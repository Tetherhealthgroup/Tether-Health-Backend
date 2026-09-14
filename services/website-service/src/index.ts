import rateLimit from 'express-rate-limit';
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
  problem,
  requireAuth,
  requireRole,
  setProblemBase,
  start,
  validateBody,
} from '@tether/core';
import { uuidParam, waitlistEnquirySchema } from './schema.ts';
import { audit, deleteEnquiry, purgeExpired, recordEnquiry } from './waitlist.ts';

/**
 * website-service — the waitlist endpoint, and nothing else.
 *
 * ARCHITECTURE.md is explicit that this service owns one boundary: the static
 * site has no backend, and this is the only reason it needs one. Keeping it to
 * one resource keeps the blast radius of a public, unauthenticated endpoint the
 * size of one table.
 *
 * Four routes, and three of them exist because of a sentence already published
 * at /privacy/:
 *
 *   POST   /waitlist         the form's target
 *   DELETE /waitlist/:id     "…and sooner if you ask us to delete it"
 *   POST   /waitlist/purge   "…or for two years, whichever comes first"
 *   GET    /healthz, /readyz from @tether/core
 */

const config = loadConfig(
  z.object({
    /**
     * How long a repeat submission from the same address folds into the first.
     *
     * Fifteen minutes, not a day. Long enough to cover a double tap, a retry
     * after a dropped connection, and somebody refreshing the page and trying
     * again — and short enough that a person who thinks better of it and
     * enquires properly an hour later gets a second row rather than silence.
     */
    WAITLIST_DEDUPE_WINDOW_MS: z.coerce.number().int().positive().default(900_000),

    /**
     * The submission limit, per IP. Much tighter than the service-wide default
     * in `@tether/core`, because this is the only unauthenticated write in the
     * whole backend and the only thing standing between a scraper and a table
     * of email addresses is this number.
     */
    WAITLIST_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    WAITLIST_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(3_600_000),

    /** Rows removed per purge call. See `purgeExpired`. */
    WAITLIST_PURGE_BATCH: z.coerce.number().int().positive().default(1_000),

    /** The role the purge job runs as. */
    ADMIN_ROLE: z.string().min(1).default('admin'),
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

const verifier = createVerifier({
  jwksUrl: config.JWT_JWKS_URL,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  algorithm: config.JWT_ALGORITHM,
});

const app = createApp({ config, logger, verifier });

/**
 * A second, much stricter limiter on top of the service-wide one.
 *
 * Keyed on the IP rather than on the address in the body: a limiter keyed on
 * the submitted email is trivially defeated by varying it, which is exactly
 * what a harvester checking which addresses are already on the list would do.
 */
const submissionLimit = rateLimit({
  windowMs: config.WAITLIST_RATE_LIMIT_WINDOW_MS,
  limit: config.WAITLIST_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    const error = problem.rateLimited(
      'That is more early-access requests than we can accept from one place. ' +
        'Email support@tetherhealthgroup.com and it reaches the same inbox.',
    );
    res
      .status(error.status)
      .type('application/problem+json')
      .json(error.toBody(req.requestId, req.originalUrl));
  },
});

// ---------------------------------------------------------------------------
// POST /waitlist
// ---------------------------------------------------------------------------

app.post(
  '/waitlist',
  submissionLimit,
  validateBody(waitlistEnquirySchema),
  handler(async (req, res) => {
    const enquiry = req.body as z.infer<typeof waitlistEnquirySchema>;

    // `withoutPrincipal`: nobody filling in this form has an account yet, and
    // there is nothing to scope the transaction to. Under RLS a connection with
    // no principal sees no patient data at all, which is the right thing for
    // the one endpoint on the public internet to be limited to.
    const result = await db.withoutPrincipal((tx) =>
      recordEnquiry(tx, enquiry, config.WAITLIST_DEDUPE_WINDOW_MS),
    );

    // No email address in the log line. `@tether/core`'s logger redacts
    // `*.email` anyway, but relying on redaction to catch something you chose
    // to write is one refactor away from not working.
    req.log.info(
      { waitlistId: result.id, created: result.created },
      result.created ? 'waitlist enquiry received' : 'waitlist enquiry deduplicated',
    );

    // 201 for a new row, 200 for a repeat — both 2xx, because the client treats
    // anything else as a failure and falls back to `mailto:`. The person tapped
    // the button and their details are on the list; that is a success whichever
    // row it resolved to.
    res.status(result.created ? 201 : 200).json({
      id: result.id,
      status: result.created ? 'received' : 'already-received',
      message: 'Thank you — we will reply when early access opens.',
    });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /waitlist/:id
// ---------------------------------------------------------------------------

/**
 * "…and sooner if you ask us to delete it."
 *
 * Unauthenticated, and that is the considered choice rather than an oversight.
 * Nobody on this list has an account — that is the entire point of a waitlist —
 * so there is no credential to require. The alternatives were:
 *
 *   - Admin-only. Then the promise is honoured by somebody reading an inbox,
 *     and "sooner if you ask" becomes "sooner if we get round to it".
 *   - A signed removal token. Better, and it needs a mail sender this service
 *     does not have yet. When one exists, the link it sends should come here.
 *
 * What authorises the call today is possession of the id: a v4 uuid returned
 * only in the response to the submission that created it. Guessing one is not
 * a practical attack, and the worst outcome if somebody did is that a marketing
 * contact is deleted — an error in the direction the privacy notice promises.
 * An admin token is accepted too, for requests that arrive by email.
 *
 * The response is 204 whether or not a row was there. Distinguishing the two
 * would turn this into an oracle for "is this id on the waitlist", and it would
 * also mean asking twice returns an error the second time, which is a strange
 * thing to say to somebody who asked to be forgotten.
 */
app.delete(
  '/waitlist/:id',
  submissionLimit,
  handler(async (req, res) => {
    const parsed = uuidParam.safeParse(req.params.id);
    if (!parsed.success) {
      // A malformed id cannot match a row, so the answer is the same 204 the
      // caller would have got for a well-formed id that matched nothing.
      res.status(204).end();
      return;
    }
    const id = parsed.data;

    const removed = await db.withoutPrincipal(async (tx) => {
      const gone = await deleteEnquiry(tx, id);
      if (gone) {
        await audit(tx, {
          action: 'waitlist.delete',
          resourceId: id,
          actorRole: req.principal?.roles.join(',') ?? 'self',
          requestId: req.requestId,
          ip: req.ip ?? null,
          detail: { reason: 'erasure requested' },
        });
      }
      return gone;
    });

    req.log.info({ waitlistId: id, removed }, 'waitlist erasure request');
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// POST /waitlist/purge
// ---------------------------------------------------------------------------

/**
 * The retention job. Admin only, and it takes no arguments.
 *
 * It cannot be told what to delete: the predicate is `purge_after <= now()`,
 * fixed in the SQL. An endpoint that accepted a cutoff would let a mistyped
 * date empty the table, and there is no version of the published promise that
 * requires deleting anything early in bulk.
 *
 * Authenticated with the same JWT machinery as everything else rather than a
 * shared secret, so "who ran the purge" is answerable from the token's subject
 * and lands in `ops.audit_event` with it.
 */
app.post(
  '/waitlist/purge',
  requireAuth(verifier),
  requireRole(config.ADMIN_ROLE),
  handler(async (req, res) => {
    const deleted = await db.withoutPrincipal(async (tx) => {
      const count = await purgeExpired(tx, config.WAITLIST_PURGE_BATCH);
      await audit(tx, {
        action: 'waitlist.purge',
        // A batch, not a row: the resource is the retention policy itself.
        resourceId: null,
        actorRole: req.principal?.roles.join(',') ?? null,
        requestId: req.requestId,
        ip: req.ip ?? null,
        detail: { deleted: count, batchLimit: config.WAITLIST_PURGE_BATCH },
      });
      return count;
    });

    req.log.info({ deleted }, 'waitlist retention purge');

    // `remaining` tells the caller whether to run it again: a purge that hits
    // its batch limit has not finished, and a scheduler that assumes one call
    // is enough would leave the oldest rows in place indefinitely.
    res.json({
      deleted,
      batchLimit: config.WAITLIST_PURGE_BATCH,
      complete: deleted < config.WAITLIST_PURGE_BATCH,
    });
  }),
);

finalise(app, {
  serviceName: config.SERVICE_NAME,
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: () => db.close(),
});
