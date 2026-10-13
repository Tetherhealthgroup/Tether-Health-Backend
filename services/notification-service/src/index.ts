import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  createApp,
  createDatabase,
  createLogger,
  createVerifier,
  finalise,
  handler,
  isProduction,
  loadConfig,
  principalOf,
  problem,
  requireAuth,
  setProblemBase,
  start,
  validateBody,
  requireUnprivilegedRole,
} from '@tether/core';
import { dataFor, readSpecificContentGrant, render } from './content.ts';
import { createPusher } from './push.ts';
import {
  preferenceSchema,
  sendSchema,
  deviceRegistrationSchema,
  type DeviceRegistrationInput,
  type PreferenceInput,
  type SendInput,
} from './schema.ts';
import {
  pruneTokens,
  readPreference,
  recordDelivery,
  registerDevice,
  removeDevice,
  setPreference,
  tokensFor,
} from './store.ts';

/**
 * notification-service — push, server-side only.
 *
 *   POST   /devices           register this device's token
 *   DELETE /devices/:token    unregister it
 *   GET    /preferences       is the lock-screen opt-in on?
 *   PUT    /preferences       turn it on or off
 *   POST   /send              internal, service-to-service
 *
 * `firebase-admin` lives in `push.ts` and nowhere else in the platform; see the
 * header there for why the client cannot have it. The safeguard that shapes the
 * rest of this service is documented at the top of `content.ts`.
 *
 * `/preferences` is not in the original route list and is here because the
 * safeguard cannot work without it: `sensitive_notifications_off` is
 * `defaultOff: true`, so there has to be a way for somebody to turn it on, and
 * a flag only an operator can set is not a choice the patient made.
 */

const config = loadConfig(
  z.object({
    /**
     * The service-account JSON, as a string.
     *
     * Optional, and that is the point: absent, the service starts and logs that
     * push is disabled. Local development must not require a Firebase project.
     * `.gitignore` already excludes `secrets/`, `*.p8` and `*.pem`; in a
     * container this is mounted, never baked in.
     */
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    FIREBASE_PROJECT_ID: z.string().optional(),

    /**
     * The shared secret for `POST /send`.
     *
     * Required, with no default. A default would be a credential in the
     * repository, and this one endpoint can cause a phone in somebody's pocket
     * to light up — so the service refuses to start rather than start with a
     * guessable one.
     */
    INTERNAL_API_TOKEN: z.string().min(32),
  }),
);

setProblemBase(`${config.PUBLIC_API_URL}/problems`);

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
  pretty: !isProduction(config),
});

const db = createDatabase({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  applicationName: config.SERVICE_NAME,
  logger,
});

/**
 * Before anything else is built, and long before `start` binds the listener: a
 * privileged role must never reach a listening state. See `requireUnprivilegedRole`.
 */
await requireUnprivilegedRole(db, { logger, serviceName: config.SERVICE_NAME });

const verifier = createVerifier({
  jwksUrl: config.JWT_JWKS_URL,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  algorithm: config.JWT_ALGORITHM,
});

const pusher = await createPusher({
  serviceAccountJson: config.FIREBASE_SERVICE_ACCOUNT_JSON,
  projectId: config.FIREBASE_PROJECT_ID,
  logger,
  environment: config.NODE_ENV,
});

const app = createApp({ config, logger, verifier });

// ---------------------------------------------------------------------------
// Internal-only access
// ---------------------------------------------------------------------------

const INTERNAL_TOKEN = Buffer.from(config.INTERNAL_API_TOKEN, 'utf8');

/**
 * Guards the service-to-service endpoint.
 *
 * A shared secret rather than a JWT because the caller is a service with no
 * user to speak for: enrolment deciding a check-in is due, records noticing a
 * missed dose. Minting a user token for those would mean a service that can
 * mint user tokens, which is a much larger thing to get wrong.
 *
 * `timingSafeEqual`, and the lengths are compared first because
 * `timingSafeEqual` throws on a length mismatch rather than returning false.
 * A `===` here would leak the secret a character at a time to anything that can
 * measure a response — which, for an endpoint reachable from inside the
 * network, includes every other service in it.
 */
function requireInternalCaller(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('x-internal-token') ?? '';
  const provided = Buffer.from(header, 'utf8');

  if (
    provided.length !== INTERNAL_TOKEN.length ||
    !timingSafeEqual(provided, INTERNAL_TOKEN)
  ) {
    // 404, not 403. The gateway does not route this path at all, so anything
    // reaching it is either a misconfigured service or something enumerating
    // the internal network; neither should be told the endpoint exists.
    next(problem.notFound(`No route for ${req.method} ${req.path}.`));
    return;
  }
  next();
}

/**
 * A stable, non-reversible handle for a device token, for log lines.
 *
 * Tokens are credentials: anything holding one can be sent to. They are
 * therefore never logged, and `DELETE /devices/:token` puts one in a URL, which
 * is the one place an access log is most likely to pick it up. Twelve hex
 * characters is enough to correlate two lines about the same device and not
 * enough to reconstitute it.
 */
function tokenHandle(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

app.post(
  '/devices',
  requireAuth(verifier),
  validateBody(deviceRegistrationSchema),
  handler(async (req, res) => {
    const principal = principalOf(req);
    const input = req.body as DeviceRegistrationInput;

    const result = await db.withPrincipal(principal.accountId, (tx) =>
      registerDevice(tx, principal.accountId, {
        token: input.token,
        platform: input.platform,
        areaId: input.areaId ?? null,
      }),
    );

    req.log.info(
      { device: tokenHandle(input.token), platform: input.platform },
      'device registered',
    );

    // Always 200 with the same shape, registration or refresh. The app calls
    // this on every launch and has no use for the distinction, and a 201 on
    // first sight would be a fact about our table leaking into its control flow.
    res.json({ id: result.id, platform: input.platform });
  }),
);

app.delete(
  '/devices/:token',
  requireAuth(verifier),
  handler(async (req, res) => {
    const principal = principalOf(req);
    const token = req.params.token ?? '';

    const removed = await db.withPrincipal(principal.accountId, (tx) =>
      removeDevice(tx, principal.accountId, token),
    );

    req.log.info({ device: tokenHandle(token), removed }, 'device unregistered');

    // 204 either way. Unregistering a token that is already gone is what a
    // retried sign-out looks like, and it is not an error.
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// The lock-screen preference
// ---------------------------------------------------------------------------

app.get(
  '/preferences',
  requireAuth(verifier),
  handler(async (req, res) => {
    const principal = principalOf(req);
    const preference = await db.withPrincipal(principal.accountId, (tx) =>
      readPreference(tx, principal.accountId),
    );
    res.json({
      specificContent: preference.specificContent,
      optedInAt: preference.optedInAt?.toISOString() ?? null,
    });
  }),
);

app.put(
  '/preferences',
  requireAuth(verifier),
  validateBody(preferenceSchema),
  handler(async (req, res) => {
    const principal = principalOf(req);
    const input = req.body as PreferenceInput;

    const preference = await db.withPrincipal(principal.accountId, (tx) =>
      setPreference(
        tx,
        principal.accountId,
        input.specificContent,
        input.consentText ?? null,
      ),
    );

    // The value is logged, the wording is not: `consentText` is the person's
    // agreement, kept in the row where it can be produced on request, not
    // scattered through a log index.
    req.log.info(
      { specificContent: preference.specificContent },
      'lock-screen content preference changed',
    );

    res.json({
      specificContent: preference.specificContent,
      optedInAt: preference.optedInAt?.toISOString() ?? null,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /send — internal
// ---------------------------------------------------------------------------

/**
 * Sends one notification to every device an account has registered.
 *
 * Note what the handler never touches: a title or a body. It has a `kind`, and
 * `render` decides the words — generic unless `readSpecificContentGrant`
 * returned a grant for this exact account, minted from a row that says
 * `specific_content = true`. The variables the caller supplied are handed to
 * `render` and dropped there if there is no grant.
 *
 * Both the preference read and the device read happen inside
 * `withPrincipal(accountId)`, in one transaction, so the preference that
 * authorises the wording and the devices that receive it cannot come from
 * different accounts.
 */
app.post(
  '/send',
  requireInternalCaller,
  validateBody(sendSchema),
  handler(async (req, res) => {
    const input = req.body as SendInput;

    const prepared = await db.withPrincipal(input.accountId, async (tx) => {
      const grant = await readSpecificContentGrant(tx, input.accountId);
      const tokens = await tokensFor(tx, input.accountId);
      const rendered = render(input.kind, input.accountId, grant, input.vars ?? {});
      return { tokens, rendered };
    });

    // The push itself is outside the transaction. FCM is a network call to a
    // third party and holding a database transaction open across one means a
    // slow provider becomes a connection-pool outage.
    const outcome = await pusher.send(
      prepared.tokens,
      prepared.rendered.payload,
      dataFor(input.kind, input.refId ?? null),
    );

    await db.withPrincipal(input.accountId, async (tx) => {
      await recordDelivery(tx, {
        accountId: input.accountId,
        kind: input.kind,
        variant: prepared.rendered.variant,
        deviceCount: prepared.tokens.length,
        delivered: outcome.delivered,
        failed: outcome.failed,
        provider: outcome.provider,
      });
      if (outcome.staleTokens.length > 0) {
        await pruneTokens(tx, input.accountId, outcome.staleTokens);
      }
    });

    // `variant`, never the payload. This is the log line that would be the
    // easiest place to undo the whole safeguard, and `packages/core`'s
    // redaction list does not cover `*.body` or `*.title` — it redacts
    // `*.text`, `*.note`, `*.answers` and the credentials. So the rule in this
    // service is not "redact the body", it is that no code path ever puts the
    // body in a log object; `render`'s output goes to `pusher.send` and
    // nowhere else.
    // No `kind`, either. `lapse_support` and `medication_reminder` say something
    // true about a person's health, and a log index is read by people with no
    // clinical relationship to them. The kind is in `ops.notification_log`,
    // under RLS, which is where an incident reader should look for it.
    req.log.info(
      {
        variant: prepared.rendered.variant,
        devices: prepared.tokens.length,
        delivered: outcome.delivered,
        failed: outcome.failed,
        provider: outcome.provider,
        pruned: outcome.staleTokens.length,
      },
      'notification sent',
    );

    res.json({
      variant: prepared.rendered.variant,
      devices: prepared.tokens.length,
      delivered: outcome.delivered,
      failed: outcome.failed,
      provider: outcome.provider,
    });
  }),
);

finalise(app, {
  serviceName: config.SERVICE_NAME,
  // Readiness is the database, not Firebase. Push being disabled is a supported
  // state — every other route works — and reporting not-ready for it would take
  // the service out of rotation over something it is designed to tolerate.
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: () => db.close(),
});
