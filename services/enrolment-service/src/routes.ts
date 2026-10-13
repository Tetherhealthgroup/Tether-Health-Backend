import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  handler,
  principalOf,
  problem,
  requireAuth,
  validateBody,
  validateQuery,
  type Database,
  type Verifier,
} from '@tether/core';
import {
  JoinEnrolmentRequestSchema,
  SharePreviewQuerySchema,
  SharingRequestSchema,
  SlugSchema,
  UpdateEnrolmentRequestSchema,
  type JoinEnrolmentRequest,
  type SharePreviewQuery,
  type SharingRequest,
  type UpdateEnrolmentRequest,
} from '@tether/contracts';
import { writeAudit, type AuditAction } from './audit.ts';
import {
  ceilingRefusal,
  checkCeiling,
  liveConsents,
  longestRunning,
  withCeilingTranslation,
} from './rules.ts';
import {
  grantConsent,
  insertEnrolment,
  loadActiveCeiling,
  loadActiveProgrammes,
  loadArea,
  loadConsents,
  loadEnrolmentRow,
  loadEnrolments,
  loadPreviewSource,
  previewEntries,
  revokeLive,
  setHidden,
  setStatus,
  toEnrolment,
} from './repository.ts';

/**
 * The enrolment routes.
 *
 * Every one of them runs inside `db.withPrincipal(accountId, …)`, so
 * `app.account_id` is set for the transaction and the RLS policies apply. That
 * is the difference between this service and the catalogue: these rows belong
 * to somebody. In chronic-care's existing FastAPI backend, 17 of its 20
 * authenticated routes take a `user_id` and never use it — `GET /profile`
 * hands the oldest profile in the table to whoever asked. Under a principal-
 * scoped transaction that bug returns an empty set instead of a stranger's
 * record, and none of the SQL below can be made to do otherwise by forgetting a
 * predicate.
 */

export interface RouteOptions {
  readonly db: Database;
  readonly verifier: Verifier;
}

function areaParam(req: Request): string {
  const result = SlugSchema.safeParse(req.params.areaId);
  if (!result.success) {
    throw problem.validation('`areaId` is not a valid identifier.', [
      { path: 'areaId', message: result.error.issues[0]?.message ?? 'invalid' },
    ]);
  }
  return result.data;
}

function validatedQuery<T>(req: Request): T {
  return (req as Request & { validatedQuery: T }).validatedQuery;
}

/** Which audit action a status transition is. */
const STATUS_ACTION: Record<string, AuditAction> = {
  active: 'programme.resume',
  paused: 'programme.pause',
  ended: 'programme.end',
};

export function enrolmentRoutes(options: RouteOptions): Router {
  const { db, verifier } = options;
  const router = Router();

  /**
   * Nothing this service returns may be cached by anything.
   *
   * It is the mirror image of the catalogue, where `public` caching is the
   * whole point. Here every response is scoped to one person: an enrolment list
   * says which health areas they are dealing with, and `discreet_program`
   * exists because "stigma is a real adherence barrier on shared or family
   * devices". A copy of that sitting in a shared cache, or in a browser's
   * back/forward buffer, is the disclosure the rule is about.
   */
  const noStore = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  /**
   * Attached per route rather than `router.use`-d.
   *
   * This router is mounted at the application root, so a `router.use`
   * middleware runs for every request reaching it — including `/healthz` and
   * `/readyz`, which `finalise` registers afterwards. Requiring a token there
   * would make an orchestrator that holds none see a service that is
   * permanently unhealthy while serving perfectly.
   */
  const guarded = [requireAuth(verifier), noStore];

  // -------------------------------------------------------------------------
  // GET /enrolments
  // -------------------------------------------------------------------------
  router.get(
    '/enrolments',
    ...guarded,
    handler(async (req, res) => {
      const { accountId } = principalOf(req);
      const enrolments = await db.withPrincipal(accountId, (tx) =>
        loadEnrolments(tx, accountId),
      );
      res.json({ enrolments });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /enrolments
  // -------------------------------------------------------------------------
  router.post(
    '/enrolments',
    ...guarded,
    validateBody(JoinEnrolmentRequestSchema),
    handler(async (req, res) => {
      const { accountId } = principalOf(req);
      const body = req.body as JoinEnrolmentRequest;

      /**
       * Filled in inside the transaction and read after it.
       *
       * The `two_active_max` trigger is DEFERRABLE INITIALLY DEFERRED, so when
       * it fires it fires at COMMIT — after the callback below has returned and
       * with no transaction left to ask which programme is oldest. The hint is
       * how the friendly refusal still manages to name one.
       */
      const hint: { wouldPause: string | null } = { wouldPause: null };

      const result = await withCeilingTranslation(hint, () =>
        db.withPrincipal(accountId, async (tx) => {
          // 1 · The area must exist and must have something to join.
          const area = await loadArea(tx, body.areaId);
          if (!area) throw problem.notFound(`No area with id \`${body.areaId}\`.`);
          if (area.productId === null) {
            // Nine of the eleven areas are a plan, not an implementation.
            // Refused rather than accepted-and-ignored, so a client cannot show
            // somebody a programme that will never have a screen.
            throw problem.areaNotImplemented(body.areaId);
          }

          const active = await loadActiveProgrammes(tx, accountId);

          if (body.pausing !== undefined) {
            if (body.pausing === body.areaId) {
              throw problem.validation(
                'A programme cannot be paused to make room for itself.',
                [{ path: 'pausing', message: 'same as areaId' }],
              );
            }
            if (!active.some((programme) => programme.areaId === body.pausing)) {
              throw problem.validation(
                `\`${body.pausing}\` is not an active programme, so pausing it frees nothing.`,
                [{ path: 'pausing', message: 'not currently active' }],
              );
            }
          }

          // 2 · The ceiling.
          const check = checkCeiling({
            active,
            areaId: body.areaId,
            pausing: body.pausing,
            ceiling: await loadActiveCeiling(tx),
          });
          hint.wouldPause = check.wouldPause ?? longestRunning(check.remaining);
          if (check.refused) throw ceilingRefusal(check);

          // 3 · Pause, then join — one transaction.
          //
          // Two requests would leave a window in which the person has paused
          // something and gained nothing, and if the second failed they would
          // have to work that out for themselves. The trigger is deferred
          // precisely so this sequence is legal: it is only checked once, at
          // COMMIT, by which point the count is right.
          if (body.pausing !== undefined) {
            const paused = await setStatus(tx, accountId, body.pausing, 'paused');
            if (paused) {
              await writeAudit(tx, req, {
                action: 'programme.pause',
                resourceType: 'enrolment',
                resourceId: paused.id,
                programmeId: paused.id,
                detail: { areaId: paused.areaId, reason: 'made room for a join' },
              });
            }
          }

          // `UNIQUE (account_id, area_id)` — re-joining reuses the row, which
          // is what keeps history across a pause and resume and what stops a
          // second join quietly orphaning the first one's record.
          const existing = await loadEnrolmentRow(tx, accountId, body.areaId);

          let row = existing;
          let joined = false;

          if (!existing) {
            row = await insertEnrolment(tx, accountId, body.areaId);
            joined = true;
          } else if (existing.status !== 'active') {
            // No `?? existing` fallback. An UPDATE that matched nothing means
            // the row moved out from under this transaction, and reporting the
            // stale row as the result would tell the person they had joined and
            // write an audit event saying so.
            row = await setStatus(tx, accountId, body.areaId, 'active');
            joined = true;
          }

          if (row === null) throw problem.internal('enrolment vanished mid-join');

          if (joined) {
            await writeAudit(tx, req, {
              action: 'programme.join',
              resourceType: 'enrolment',
              resourceId: row.id,
              programmeId: row.id,
              detail: {
                areaId: row.areaId,
                productId: area.productId,
                rejoined: existing !== null,
                paused: body.pausing ?? null,
              },
            });
          }

          return {
            joined,
            enrolment: toEnrolment(row, await loadConsents(tx, accountId, row.id)),
          };
        }),
      );

      // 200 when nothing changed. A client that retries a join it already made
      // should not be told it created something.
      res.status(result.joined ? 201 : 200).json(result.enrolment);
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /enrolments/:areaId
  // -------------------------------------------------------------------------
  router.patch(
    '/enrolments/:areaId',
    ...guarded,
    validateBody(UpdateEnrolmentRequestSchema),
    handler(async (req, res) => {
      const { accountId } = principalOf(req);
      const areaId = areaParam(req);
      const body = req.body as UpdateEnrolmentRequest;
      const hint: { wouldPause: string | null } = { wouldPause: null };

      const enrolment = await withCeilingTranslation(hint, () =>
        db.withPrincipal(accountId, async (tx) => {
          const existing = await loadEnrolmentRow(tx, accountId, areaId);
          if (!existing) {
            throw problem.notFound(`You have no enrolment in \`${areaId}\`.`);
          }

          // Resuming is a join by another name, so it meets the same ceiling.
          // Without this, pausing a programme and resuming it would be the way
          // around a rule the join screen enforces.
          if (body.status === 'active' && existing.status !== 'active') {
            const check = checkCeiling({
              active: await loadActiveProgrammes(tx, accountId),
              areaId,
              ceiling: await loadActiveCeiling(tx),
            });
            hint.wouldPause = check.wouldPause ?? longestRunning(check.remaining);
            if (check.refused) throw ceilingRefusal(check);
          }

          let row = existing;

          if (body.status !== undefined && body.status !== existing.status) {
            // As in the join: an UPDATE that matched nothing is not a success
            // with the old values, it is a row that is no longer there.
            const updated = await setStatus(tx, accountId, areaId, body.status);
            if (!updated) throw problem.internal('enrolment vanished mid-update');
            row = updated;
            await writeAudit(tx, req, {
              action: STATUS_ACTION[body.status] ?? 'programme.pause',
              resourceType: 'enrolment',
              resourceId: row.id,
              programmeId: row.id,
              detail: { areaId, from: existing.status, to: body.status },
            });
          }

          if (body.hidden !== undefined && body.hidden !== row.hidden) {
            // Hidden is not paused: the programme still runs, still takes
            // check-ins and still counts against the ceiling. No status
            // transition, and so no status audit event.
            const updated = await setHidden(tx, accountId, areaId, body.hidden);
            if (!updated) throw problem.internal('enrolment vanished mid-update');
            row = updated;
          }

          return toEnrolment(row, await loadConsents(tx, accountId, row.id));
        }),
      );

      res.json(enrolment);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /enrolments/:areaId/sharing
  // -------------------------------------------------------------------------
  router.get(
    '/enrolments/:areaId/sharing',
    ...guarded,
    handler(async (req, res) => {
      const { accountId } = principalOf(req);
      const areaId = areaParam(req);

      const response = await db.withPrincipal(accountId, async (tx) => {
        const enrolment = await loadEnrolmentRow(tx, accountId, areaId);
        if (!enrolment) {
          throw problem.notFound(`You have no enrolment in \`${areaId}\`.`);
        }
        return {
          areaId,
          enrolmentId: enrolment.id,
          consents: liveConsents(await loadConsents(tx, accountId, enrolment.id)),
        };
      });

      res.json(response);
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /enrolments/:areaId/sharing
  // -------------------------------------------------------------------------
  router.put(
    '/enrolments/:areaId/sharing',
    ...guarded,
    // The schema is where a global grant dies. A body naming an account rather
    // than a programme never reaches this handler — see `SharingRequestSchema`.
    validateBody(SharingRequestSchema),
    handler(async (req, res) => {
      const { accountId } = principalOf(req);
      const areaId = areaParam(req);
      const body = req.body as SharingRequest;
      const recipientId = body.recipientId ?? null;

      const response = await db.withPrincipal(accountId, async (tx) => {
        const enrolment = await loadEnrolmentRow(tx, accountId, areaId);
        if (!enrolment) {
          // A consent that names no programme is not representable, so a
          // consent for a programme somebody is not in is not either.
          throw problem.notFound(`You have no enrolment in \`${areaId}\`.`);
        }

        if (body.granted) {
          const { consent, supersededIds, created } = await grantConsent(tx, accountId, {
            enrolmentId: enrolment.id,
            scope: body.scope,
            recipientKind: body.recipientKind,
            recipientId,
            // Both are guaranteed present when `granted` is true; the schema
            // refuses a grant that does not carry the wording.
            consentVersion: body.consentVersion as string,
            consentText: body.consentText as string,
          });

          for (const supersededId of supersededIds) {
            await writeAudit(tx, req, {
              action: 'consent.revoke',
              resourceType: 'sharing_consent',
              resourceId: supersededId,
              programmeId: enrolment.id,
              detail: {
                areaId,
                scope: body.scope,
                recipientKind: body.recipientKind,
                reason: 'superseded by a newer consent version',
              },
            });
          }

          if (created) {
            await writeAudit(tx, req, {
              action: 'consent.grant',
              resourceType: 'sharing_consent',
              resourceId: consent.id,
              programmeId: enrolment.id,
              detail: {
                areaId,
                scope: consent.scope,
                recipientKind: consent.recipientKind,
                recipientId: consent.recipientId,
                consentVersion: consent.consentVersion,
              },
            });
          }
        } else {
          const revokedIds = await revokeLive(tx, accountId, {
            enrolmentId: enrolment.id,
            scope: body.scope,
            recipientKind: body.recipientKind,
            recipientId,
          });

          for (const revokedId of revokedIds) {
            await writeAudit(tx, req, {
              action: 'consent.revoke',
              resourceType: 'sharing_consent',
              resourceId: revokedId,
              programmeId: enrolment.id,
              detail: {
                areaId,
                scope: body.scope,
                recipientKind: body.recipientKind,
                recipientId,
              },
            });
          }
        }

        return {
          areaId,
          enrolmentId: enrolment.id,
          consents: liveConsents(await loadConsents(tx, accountId, enrolment.id)),
        };
      });

      res.json(response);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /enrolments/:areaId/sharing/preview
  // -------------------------------------------------------------------------
  router.get(
    '/enrolments/:areaId/sharing/preview',
    ...guarded,
    validateQuery(SharePreviewQuerySchema),
    handler(async (req, res) => {
      const { accountId } = principalOf(req);
      const areaId = areaParam(req);
      const query = validatedQuery<SharePreviewQuery>(req);

      const prospective =
        query.scope !== undefined && query.recipientKind !== undefined
          ? { scope: query.scope, recipientKind: query.recipientKind }
          : null;

      const entries = await db.withPrincipal(accountId, async (tx) => {
        const enrolment = await loadEnrolmentRow(tx, accountId, areaId);
        if (!enrolment) {
          throw problem.notFound(`You have no enrolment in \`${areaId}\`.`);
        }

        const area = await loadArea(tx, areaId);
        const source = await loadPreviewSource(
          tx,
          accountId,
          enrolment,
          area?.name ?? areaId,
        );

        return previewEntries({
          consents: await loadConsents(tx, accountId, enrolment.id),
          prospective,
          source,
        });
      });

      res.json({
        areaId,
        generatedAt: new Date().toISOString(),
        // This endpoint sends nothing to anybody. It is serialised rather than
        // assumed so a client author reading one response can see it.
        nothingWasSent: true,
        entries,
      });
    }),
  );

  return router;
}
