import rateLimit from 'express-rate-limit';
import type { Express, RequestHandler } from 'express';
import type { z } from 'zod';
import {
  createApp,
  finalise,
  handler,
  principalOf,
  problem,
  requireAuth,
  requireRole,
  validateBody,
  type BaseConfig,
  type Database,
  type Logger,
  type Verifier,
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

export interface WebsiteConfig extends BaseConfig {
  /** How long a repeat submission from the same address folds into the first. */
  readonly WAITLIST_DEDUPE_WINDOW_MS: number;
  /** The submission limit, per IP. */
  readonly WAITLIST_RATE_LIMIT_MAX: number;
  readonly WAITLIST_RATE_LIMIT_WINDOW_MS: number;
  /** Rows removed per purge call. See `purgeExpired`. */
  readonly WAITLIST_PURGE_BATCH: number;
  /** The role that may erase an enquiry and run the purge. */
  readonly ADMIN_ROLE: string;
}

export interface WebsiteDeps {
  readonly config: WebsiteConfig;
  readonly logger: Logger;
  readonly verifier: Verifier;
  readonly db: Database;
  readonly isReady?: () => Promise<boolean>;
}

export function createWebsiteApp(deps: WebsiteDeps): Express {
  const { config, logger, verifier, db } = deps;

  const app = createApp({ config, logger, verifier });

  /**
   * `requireAuth` from `@tether/core`. It already returns `void` and routes its
   * own failures to `next`, so it is a valid Express handler as it stands.
   */
  const requireToken: RequestHandler = requireAuth(verifier);

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
   * Admin only. This route used to be unauthenticated, on the reasoning that
   * nobody on a waitlist has an account and that possession of the enquiry's id
   * was credential enough. It is not: the id is returned to the browser in the
   * submission response and so ends up in referrer logs, browser history and
   * support screenshots, and an endpoint that deletes personal data on the
   * strength of a string that travels is an endpoint anyone who reads one of
   * those can use (R-033).
   *
   * The credential is the one `POST /waitlist/purge` already uses: a verified
   * token carrying `ADMIN_ROLE`. The published promise is "ask us", and what
   * that now means is that a person asks — by email, as the privacy notice
   * says — and somebody holding the role runs this. It costs a self-service
   * link that no client in this repository ever offered. The way to get one back
   * safely is the one the previous version of this comment named: a signed
   * removal token, which needs a mail sender this service does not have.
   *
   * The response is 204 whether or not a row was there. Distinguishing the two
   * would turn this into an oracle for "is this id on the waitlist", and it would
   * also mean asking twice returns an error the second time, which is a strange
   * thing to say to somebody who asked to be forgotten. (A caller with no token,
   * or the wrong role, gets 401 or 403 and learns nothing about any id.)
   *
   * No per-IP submission limiter here: that one is sized for a harvester posting
   * the form, and an operator clearing several erasure requests would hit it.
   */
  app.delete(
    '/waitlist/:id',
    requireToken,
    requireRole(config.ADMIN_ROLE),
    handler(async (req, res) => {
      const principal = principalOf(req);
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
            actorRole: principal.roles.join(','),
            requestId: req.requestId,
            ip: req.ip ?? null,
            // Who ran it. The enquiry's own details are deliberately absent.
            detail: { reason: 'erasure requested', actorAccountId: principal.accountId },
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
    requireToken,
    requireRole(config.ADMIN_ROLE),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const deleted = await db.withoutPrincipal(async (tx) => {
        const count = await purgeExpired(tx, config.WAITLIST_PURGE_BATCH);
        await audit(tx, {
          action: 'waitlist.purge',
          // A batch, not a row: the resource is the retention policy itself.
          resourceId: null,
          actorRole: principal.roles.join(','),
          requestId: req.requestId,
          ip: req.ip ?? null,
          detail: {
            deleted: count,
            batchLimit: config.WAITLIST_PURGE_BATCH,
            actorAccountId: principal.accountId,
          },
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

  return finalise(app, {
    serviceName: config.SERVICE_NAME,
    isReady: deps.isReady ?? (() => db.ping()),
  });
}
