import { Client } from 'pg';
import { z } from 'zod';
import {
  createApp,
  createDatabase,
  createLogger,
  createVerifier,
  finalise,
  handler,
  loadConfig,
  principalOf,
  requireAuth,
  setProblemBase,
  start,
} from '@tether/core';
import {
  changeNotification,
  fanOut,
  toSseFrame,
  type Subscriber,
} from './subscriptions.ts';

/**
 * Change notification over Server-Sent Events.
 *
 * SSE and not WebSockets, for one reason that decides it: the Flutter apps
 * declare exactly one runtime dependency and a test fails their build if a
 * second appears, so they cannot add `supabase_flutter` or a socket package.
 * SSE is plain HTTP with a long-lived response, which `dart:io` reads unaided.
 *
 * Clients that *can* take a dependency — a web clinician console — should use
 * Supabase Realtime directly instead. The publication is configured in
 * `20260914120700_realtime.sql` and applies the subscriber's own RLS, so it
 * inherits the whole consent model without this service in the path.
 *
 * What crosses this wire is never a row. A notification says which enrolment
 * changed and the client re-reads through the ordinary API, where the consent
 * check lives. A stream that pushed contents would be a second read path that
 * had to re-implement that check, against a payload a trigger assembled with no
 * idea who was listening.
 */

const config = loadConfig(
  z.object({
    /** Seconds between keep-alive comments. */
    SSE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(25),
    /** Hard cap on concurrent streams, so one client cannot exhaust the pool. */
    SSE_MAX_SUBSCRIBERS: z.coerce.number().int().positive().default(2_000),
  }),
);

setProblemBase(`${config.PUBLIC_API_URL}/problems`);

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
  pretty: config.NODE_ENV === 'development',
});

const db = createDatabase({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  applicationName: config.SERVICE_NAME,
  logger,
});

const verifier = createVerifier({
  jwksUrl: config.JWT_JWKS_URL,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  algorithm: config.JWT_ALGORITHM,
});

const subscribers = new Set<Subscriber>();

/**
 * A dedicated connection, held open for `LISTEN`.
 *
 * Not from the pool: a pooled connection is handed back between queries, and a
 * `LISTEN` registered on one would be silently lost the moment it was reused
 * for something else. This one belongs to the process for its lifetime.
 */
const listener = new Client({
  connectionString: config.DATABASE_URL,
  application_name: `${config.SERVICE_NAME}-listener`,
});

let listenerHealthy = false;

async function startListening(): Promise<void> {
  listener.on('notification', (message) => {
    if (message.channel !== 'tether_change' || !message.payload) return;

    const parsed = changeNotification.safeParse(
      JSON.parse(message.payload) as unknown,
    );
    if (!parsed.success) {
      // A malformed payload means a trigger and this service disagree about
      // the contract. Worth a log; not worth dropping every other listener.
      logger.warn({ channel: message.channel }, 'unparseable change notification');
      return;
    }

    for (const gone of fanOut(subscribers, parsed.data)) {
      subscribers.delete(gone);
    }
  });

  listener.on('error', (error) => {
    listenerHealthy = false;
    logger.error({ err: error }, 'listener connection lost');
    // Readiness goes false, so the orchestrator takes this instance out of
    // rotation rather than leaving it accepting streams it can never feed.
  });

  await listener.connect();
  await listener.query('LISTEN tether_change');
  listenerHealthy = true;
  logger.info('listening for change notifications');
}

const app = createApp({ config, logger, verifier });

app.get(
  '/stream',
  requireAuth(verifier),
  handler(async (req, res) => {
    const principal = principalOf(req);

    if (subscribers.size >= config.SSE_MAX_SUBSCRIBERS) {
      res.status(503).type('application/problem+json').json({
        type: `${config.PUBLIC_API_URL}/problems/rate-limited`,
        title: 'rate-limited',
        status: 503,
        detail: 'Too many open streams. Retry shortly.',
      });
      return;
    }

    // Resolved once, under the caller's own principal, so RLS decides what this
    // stream may ever mention. Enrolments they own, plus any a live consent
    // names them as recipient of.
    const enrolmentIds = await db.withPrincipal(
      principal.accountId,
      async (tx) => {
        const rows = await tx.query<{ id: string }>(
          `SELECT e.id FROM programme.enrolment e
           UNION
           SELECT c.enrolment_id AS id FROM programme.sharing_consent c
            WHERE c.revoked_at IS NULL`,
        );
        return new Set(rows.map((row) => row.id));
      },
    );

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Proxies that buffer will hold a stream until it looks "finished",
      // which for SSE is never.
      'X-Accel-Buffering': 'no',
    });
    // Flush the headers so the client's connect resolves immediately rather
    // than on the first event, which could be hours away.
    res.write(': connected\n\n');

    const subscriber: Subscriber = {
      accountId: principal.accountId,
      enrolmentIds,
      send: (event) => res.write(toSseFrame(event)),
    };
    subscribers.add(subscriber);

    // A comment frame, which clients ignore. It exists to stop an idle
    // connection being reaped by an intermediary that sees no bytes.
    const heartbeat = setInterval(() => {
      if (!res.write(': keep-alive\n\n')) subscribers.delete(subscriber);
    }, config.SSE_HEARTBEAT_SECONDS * 1_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      subscribers.delete(subscriber);
    });

    req.log.info({ enrolments: enrolmentIds.size }, 'stream opened');
  }),
);

finalise(app, {
  serviceName: config.SERVICE_NAME,
  isReady: async () => listenerHealthy && (await db.ping()),
});

await startListening();

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: async () => {
    // Forget the subscribers. This does not close their streams: `Subscriber`
    // has no close hook, so open SSE responses are left to the process exit.
    // (A `subscriber.send.length` statement used to sit here and did nothing.)
    subscribers.clear();
    await listener.end().catch(() => undefined);
    await db.close();
  },
});
