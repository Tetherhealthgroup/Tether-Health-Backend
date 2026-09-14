import { Router, type Express, type Request } from 'express';
import {
  createApp,
  finalise,
  handler,
  principalOf,
  problem,
  requireAuth,
  validateBody,
  type BaseConfig,
  type Database,
  type Logger,
  type Verifier,
} from '@tether/core';
import { decodeScreenAnswers, encodeScreenAnswers } from './answers.ts';
import { writeAudit } from './audit.ts';
import {
  exportQuerySchema,
  lapseSchema,
  observationSchema,
  screenAnswersSchema,
  syncSchema,
} from './schemas.ts';
import { applySync } from './sync.ts';
import type {
  EnrolmentRow,
  ObservationRow,
  RecordStore,
  StoreContext,
  StoredAnswer,
} from './store.ts';

/**
 * records-service — the patient record.
 *
 * Answers, lapses, observations, the offline sync path, the export and the
 * deletion. Every route is scoped by area rather than reaching a record
 * directly, because a record is reached *through* its programme: there is no
 * `account_id` on `record.screen_answer`, `record.lapse_event` or
 * `record.observation`, and `per_program_sharing` is the reason. Naming the
 * programme is not an ergonomic choice, it is what makes a consent check
 * unavoidable rather than optional.
 *
 * Every handler runs inside `db.withPrincipal(accountId, …)`, so `app.account_id`
 * is set for the transaction and RLS filters every statement. A handler that
 * forgot its predicate returns nothing rather than somebody else's record.
 *
 * Three things this service does not have, each on purpose:
 *
 *  - No endpoint that edits or deletes a single lapse, and no counter, streak or
 *    progress column anywhere for one to decrement. `slip_never_resets`: "A
 *    lapse is recorded in history. It never zeroes a counter, streak or
 *    progress value." What `GET /:areaId/lapses` returns alongside the history
 *    is computed from that history at read time and only ever rises.
 *  - No path to an answer that does not name an enrolment. `behavioral` and
 *    `digital` both resolve to the `lookup` product, so their 34 screen ids are
 *    identical; keying on the screen would merge two programmes' records, which
 *    is a bug the Flutter app actually shipped and was fixed for.
 *  - No soft delete. `DELETE /record` removes rows and returns once they are
 *    gone.
 */

export interface RecordsDeps {
  readonly config: BaseConfig;
  readonly logger: Logger;
  readonly verifier: Verifier;
  readonly db: Database;
  readonly store: RecordStore;
  /** Dependencies answering. Real by default; overridden in tests. */
  readonly isReady?: () => Promise<boolean>;
  /** Injected so a receipt's `syncedAt` can be asserted. */
  readonly now?: () => Date;
}

/** Ids are opaque to this service, but not arbitrary: they index rows. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function pathId(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !ID.test(value)) {
    throw problem.validation(`The ${name} in the path is not a valid identifier.`, [
      { path: name, message: 'must be 1-120 characters of [A-Za-z0-9._-]' },
    ]);
  }
  return value;
}

/** The role the caller acted in, for the audit row. Never guessed as a right. */
const actorRole = (roles: readonly string[]): string => roles[0] ?? 'account';

export function createRecordsApp(deps: RecordsDeps): Express {
  const { config, logger, verifier, db, store } = deps;
  const now = deps.now ?? (() => new Date());

  // Order as `http.ts` lays it out: the shared stack, then routes, then
  // `finalise` for health, 404 and the error handler.
  const app = createApp({ config, logger, verifier });
  const routes = Router();

  /**
   * Named on every route rather than applied to the router with `.use`.
   *
   * A router-wide `use` would also sit in front of `/healthz` and `/readyz`,
   * which `finalise` mounts afterwards — an orchestrator does not carry a
   * bearer token, so the probes would fail and the service would never be
   * routed traffic. Spelling it out per route also means a new route that
   * forgets it is visible in the diff rather than silently covered.
   */
  const auth = requireAuth(verifier);

  /**
   * Resolves the caller's enrolment in one area, inside their own transaction.
   *
   * A 404 rather than a 403 when they have none. `errors.ts` says of `notFound`:
   * "the resource does not exist, or the caller may not know that it does" —
   * and whether somebody else is enrolled in an area is not this caller's
   * business either way.
   */
  async function withEnrolment<T>(
    req: Request,
    areaId: string,
    fn: (ctx: StoreContext, enrolment: EnrolmentRow) => Promise<T>,
  ): Promise<T> {
    const principal = principalOf(req);
    return db.withPrincipal(principal.accountId, async (tx) => {
      const ctx: StoreContext = { tx, accountId: principal.accountId };
      const enrolment = await store.enrolmentForArea(ctx, areaId);
      if (!enrolment) {
        throw problem.notFound(`No programme in ${areaId} for this account.`);
      }
      return fn(ctx, enrolment);
    });
  }

  // -- Answers ---------------------------------------------------------------

  routes.get(
    '/:areaId/answers',
    auth,
    handler(async (req, res) => {
      const areaId = pathId(req, 'areaId');
      const answers = await withEnrolment(req, areaId, (ctx, enrolment) =>
        store.answers(ctx, enrolment.id),
      );
      // Keyed by bare screen id, because the programme is the thing this
      // response is already about — the same reasoning `exportRecord()` gives
      // for not repeating the area inside every key.
      res.json({ areaId, answers: groupByScreen(answers) });
    }),
  );

  routes.put(
    '/:areaId/answers/:screenId',
    auth,
    validateBody(screenAnswersSchema),
    handler(async (req, res) => {
      const areaId = pathId(req, 'areaId');
      const screenId = pathId(req, 'screenId');
      const blocks = decodeScreenAnswers(req.body);
      const principal = principalOf(req);

      const result = await withEnrolment(req, areaId, async (ctx, enrolment) => {
        // Upsert on `(enrolment_id, screen_id, block_index)`, then drop the
        // blocks the body no longer names: `PUT` replaces the screen. The
        // enrolment is in the key, which is the whole point.
        const counts = await store.replaceScreenAnswers(
          ctx,
          enrolment.id,
          screenId,
          blocks,
        );
        await writeAudit(ctx.tx, {
          accountId: principal.accountId,
          actorRole: actorRole(principal.roles),
          action: 'record.answers.write',
          resourceType: 'screen_answer',
          resourceId: screenId,
          programmeId: enrolment.id,
          requestId: req.requestId,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
          // Counts and ids. Not one answer — the audit trail must not become a
          // second, unredacted copy of the record it is auditing.
          detail: { areaId, blocks: counts.written, removed: counts.removed },
        });
        return counts;
      });

      res.json({ areaId, screenId, ...result });
    }),
  );

  // -- Lapses ----------------------------------------------------------------

  routes.get(
    '/:areaId/lapses',
    auth,
    handler(async (req, res) => {
      const areaId = pathId(req, 'areaId');
      const lapses = await withEnrolment(req, areaId, (ctx, enrolment) =>
        store.lapses(ctx, enrolment.id),
      );

      res.json({
        areaId,
        lapses,
        /**
         * Derived here, at read time, from the history itself — never stored.
         *
         * This is the concrete form of `slip_never_resets`. There is no counter
         * in the schema for a lapse to zero, so the only number this service
         * can report is one recomputed from the events, and recording a lapse
         * can only ever make it larger. `recorded` is a count of things that
         * happened; nothing here is a streak, and nothing here goes down.
         */
        history: {
          recorded: lapses.length,
          firstAt: lapses.at(-1)?.occurredAt ?? null,
          lastAt: lapses[0]?.occurredAt ?? null,
        },
      });
    }),
  );

  routes.post(
    '/:areaId/lapses',
    auth,
    validateBody(lapseSchema),
    handler(async (req, res) => {
      const areaId = pathId(req, 'areaId');
      const principal = principalOf(req);
      const body = req.body as import('./schemas.ts').LapseBody;

      const appended = await withEnrolment(req, areaId, async (ctx, enrolment) => {
        // Same insert-if-absent guard `POST /sync` uses, on purpose. A retried
        // POST and a re-sent sync item are the same event arriving twice, and a
        // client cannot tell which it is doing when the network drops a
        // response — so they must not behave differently.
        const result = await store.appendLapse(ctx, enrolment.id, {
          occurredAt: body.occurredAt,
          severity: body.severity,
          context: [...body.context].sort(),
        });
        await writeAudit(ctx.tx, {
          accountId: principal.accountId,
          actorRole: actorRole(principal.roles),
          action: 'record.lapse.append',
          resourceType: 'lapse_event',
          resourceId: result.row.id,
          programmeId: enrolment.id,
          requestId: req.requestId,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
          // No severity, no context, no time of the lapse. That a lapse was
          // recorded is the auditable fact; what it said is the record, and the
          // record is not duplicated into a table with no deletion path.
          detail: { areaId, created: result.created },
        });
        return result;
      });

      // 201 for a new event, 200 for one already held. Nothing else changed:
      // no counter moved, no streak broke, no progress value was recomputed
      // downward, because there is no such value to recompute.
      res.status(appended.created ? 201 : 200).json({
        areaId,
        lapse: appended.row,
        created: appended.created,
      });
    }),
  );

  // -- Observations ----------------------------------------------------------

  routes.get(
    '/:areaId/observations',
    auth,
    handler(async (req, res) => {
      const areaId = pathId(req, 'areaId');
      const observations = await withEnrolment(req, areaId, (ctx, enrolment) =>
        store.observations(ctx, enrolment.id),
      );
      res.json({ areaId, observations: observations.map(withProvenance) });
    }),
  );

  routes.post(
    '/:areaId/observations',
    auth,
    validateBody(observationSchema),
    handler(async (req, res) => {
      const areaId = pathId(req, 'areaId');
      const principal = principalOf(req);
      const body = req.body as import('./schemas.ts').ObservationBody;

      const appended = await withEnrolment(req, areaId, async (ctx, enrolment) => {
        const result = await store.appendObservation(ctx, enrolment.id, body);
        await writeAudit(ctx.tx, {
          accountId: principal.accountId,
          actorRole: actorRole(principal.roles),
          action: 'record.observation.append',
          resourceType: 'observation',
          resourceId: result.row.id,
          programmeId: enrolment.id,
          requestId: req.requestId,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
          // `measureId`, `source` and `platform` are provenance, not a reading.
          // Keeping provenance and dropping the value is what lets an auditor
          // check `self_report_only` without reading anybody's numbers.
          detail: {
            areaId,
            measureId: body.measureId,
            source: body.source,
            platform: body.platform,
            created: result.created,
          },
        });
        return result;
      });

      res.status(appended.created ? 201 : 200).json({
        areaId,
        observation: withProvenance(appended.row),
        created: appended.created,
      });
    }),
  );

  // -- Sync ------------------------------------------------------------------

  routes.post(
    '/sync',
    auth,
    validateBody(syncSchema),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const body = req.body as import('./schemas.ts').SyncBody;

      // Header or body. The header is the conventional place and survives a
      // client that re-serialises its document; the body field is what a Flutter
      // client writing one JSON object will find easier to produce. Neither is
      // invented server-side: a key the server made up would differ on every
      // retry, which is precisely the property that makes it worthless.
      const headerKey = req.header('idempotency-key');
      const idempotencyKey = (headerKey ?? body.idempotencyKey ?? '').trim();
      if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        throw problem.validation(
          'A sync batch must carry an Idempotency-Key header or idempotencyKey field ' +
            'of 8 to 200 characters, so that re-sending it is a no-op.',
          [{ path: 'idempotencyKey', message: 'required, 8-200 characters' }],
        );
      }

      const outcome = await db.withPrincipal(principal.accountId, async (tx) => {
        const ctx: StoreContext = { tx, accountId: principal.accountId };
        const result = await applySync(ctx, store, body, idempotencyKey, now);

        // Only a first run writes a receipt, and it writes it in the same
        // transaction as the rows it describes. A replay has already found one
        // and must add nothing — a second audit row per retry would make the
        // trail grow with the network's reliability rather than with what
        // happened to the record.
        if (!result.replayed) {
          await writeAudit(tx, {
            accountId: principal.accountId,
            actorRole: actorRole(principal.roles),
            action: 'record.sync',
            resourceType: 'sync_batch',
            resourceId: idempotencyKey,
            requestId: req.requestId,
            ipAddress: req.ip ?? null,
            userAgent: req.header('user-agent') ?? null,
            // The receipt *is* the audit detail. One object, written once, read
            // back verbatim by a replay — there is nothing in the response that
            // is not in the row, so the two cannot come to disagree.
            detail: { ...result.receipt },
          });
        }
        return result;
      });

      res.json({ ...outcome.receipt, replayed: outcome.replayed });
    }),
  );

  // -- Export ----------------------------------------------------------------

  routes.get(
    '/export',
    auth,
    handler(async (req, res) => {
      const query = exportQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw problem.validation('The query string is not valid.');
      }
      const principal = principalOf(req);

      const document = await db.withPrincipal(principal.accountId, async (tx) => {
        const ctx: StoreContext = { tx, accountId: principal.accountId };
        const built = await buildExport(ctx, store, query.data.locale, now);
        await writeAudit(tx, {
          accountId: principal.accountId,
          actorRole: actorRole(principal.roles),
          action: 'record.export',
          resourceType: 'record',
          requestId: req.requestId,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
          // What left, as a shape: which programmes and how much. An export is
          // a disclosure even when it is to the person themselves, and a
          // disclosure nobody can later enumerate is not auditable.
          detail: built.audit,
        });
        return built.document;
      });

      res
        .header(
          'content-disposition',
          `attachment; filename="tether-record-${now().toISOString().slice(0, 10)}.json"`,
        )
        .json(document);
    }),
  );

  // -- Deletion --------------------------------------------------------------

  routes.delete(
    '/record',
    auth,
    handler(async (req, res) => {
      const principal = principalOf(req);

      const result = await db.withPrincipal(principal.accountId, async (tx) => {
        const ctx: StoreContext = { tx, accountId: principal.accountId };
        const enrolments = await store.enrolments(ctx);

        // Written BEFORE anything is removed. `ops.audit_event.account_id` is
        // deliberately not a foreign key (0001) precisely so this row outlives
        // the data it describes — but ordering still matters, because the row
        // has to name what was there while there is still something to name.
        //
        // Both this and the completion row below are in the same transaction as
        // the deletes. That is not a weakness in the claim, it is the claim: if
        // the deletion fails, the audit trail must not assert that it happened.
        await writeAudit(tx, {
          accountId: principal.accountId,
          actorRole: actorRole(principal.roles),
          action: 'record.delete.requested',
          resourceType: 'record',
          requestId: req.requestId,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
          detail: { areas: enrolments.map((enrolment) => enrolment.areaId) },
        });

        // Real rows, gone, verified empty before this returns. No `deleted_at`
        // anywhere: `hard_delete_action`, and ARCHITECTURE.md's note that a
        // soft-delete column on a health row is the hidden kind of deletion the
        // safeguard names.
        const counts = await store.deleteEverything(ctx);

        await writeAudit(tx, {
          accountId: principal.accountId,
          actorRole: actorRole(principal.roles),
          action: 'record.delete.completed',
          resourceType: 'record',
          requestId: req.requestId,
          ipAddress: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
          detail: { ...counts, verifiedEmpty: true },
        });

        return counts;
      });

      // 200 with the counts rather than 204. The body is the receipt: a person
      // who asked for erasure is owed evidence it completed, and an empty
      // response is indistinguishable from one that did nothing.
      res.json({ deleted: result, verifiedEmpty: true, completedAt: now().toISOString() });
    }),
  );

  app.use(routes);

  return finalise(app, {
    serviceName: config.SERVICE_NAME,
    isReady: deps.isReady ?? (() => db.ping()),
  });
}

/** `[{screenId, blockIndex, …}]` into `{screenId: {chips, option, slider, text}}`. */
function groupByScreen(
  answers: readonly StoredAnswer[],
): Record<string, ReturnType<typeof encodeScreenAnswers>> {
  const byScreen = new Map<string, StoredAnswer[]>();
  for (const answer of answers) {
    const bucket = byScreen.get(answer.screenId);
    if (bucket) bucket.push(answer);
    else byScreen.set(answer.screenId, [answer]);
  }
  const out: Record<string, ReturnType<typeof encodeScreenAnswers>> = {};
  for (const [screenId, blocks] of byScreen) {
    out[screenId] = encodeScreenAnswers(blocks);
  }
  return out;
}

/**
 * An observation with its provenance made explicit.
 *
 * `self_report_only` requires the product be "explicit that these are
 * self-reports". `source` already carries it, but a consumer has to know to
 * read it; `selfReported` is the same fact in the form a template will actually
 * check. Nothing in this service ever presents a self-reported value as
 * measured, and the cheapest way to hold that line is for the flag to travel
 * with the value rather than be looked up beside it.
 */
function withProvenance(observation: ObservationRow): ObservationRow & {
  selfReported: boolean;
} {
  return { ...observation, selfReported: observation.source === 'self_report' };
}

/**
 * The whole record, in the shape `TetherSession.exportRecord()` produces.
 *
 * Answers nest inside the programme that recorded them and are keyed by bare
 * screen id, exactly as the app does it, and for the app's stated reason: "a
 * single list of S13, S17, S22 above two programme headings invites exactly the
 * wrong conclusion — that there is one shared pool of answers underneath the
 * programmes. There is not… the export should say so by its shape and not only
 * in a sentence."
 *
 * Two additions to the client's shape, both additive and neither changing the
 * nesting. `observations` sits beside `lapses` because the server holds
 * measurements the client has never had a field for, and an export that omitted
 * them would not be the whole record. `exportedAt` is at the top because an
 * export is evidence, and evidence with no timestamp is weaker evidence.
 *
 * `locale` comes from the request rather than the database: the app owns it —
 * `TetherSession` takes it at construction and pointedly does not store it —
 * and a server that guessed would be a second source of truth for something the
 * person sets elsewhere.
 */
async function buildExport(
  ctx: StoreContext,
  store: RecordStore,
  locale: string,
  now: () => Date,
): Promise<{ document: unknown; audit: Record<string, unknown> }> {
  const enrolments = await store.enrolments(ctx);
  const consents = await store.liveConsents(ctx);
  const names = await store.areaNames(
    ctx,
    enrolments.map((enrolment) => enrolment.areaId),
  );

  const programs = [];
  let totalAnswers = 0;
  let totalLapses = 0;
  let totalObservations = 0;

  for (const enrolment of enrolments) {
    // Sequential rather than concurrent: these share one transaction, and a
    // `pg` client cannot run two statements at once. `Promise.all` here would
    // interleave them onto the same connection and fail at runtime.
    const answers = await store.answers(ctx, enrolment.id);
    const lapses = await store.lapses(ctx, enrolment.id);
    const observations = await store.observations(ctx, enrolment.id);
    totalAnswers += answers.length;
    totalLapses += lapses.length;
    totalObservations += observations.length;

    const live = consents.filter((consent) => consent.enrolmentId === enrolment.id);

    programs.push({
      area: enrolment.areaId,
      name: names.get(enrolment.areaId) ?? enrolment.areaId,
      status: enrolment.status,
      joinedOn: enrolment.joinedOn,
      hidden: enrolment.hidden,
      // Derived from live `programme.sharing_consent` rows, never from a stored
      // pair of booleans. A revoked consent is a row with `revoked_at` set, and
      // it must not still read as `true` in the person's own export.
      sharing: {
        totalsAndAdherence: live.some((c) => c.scope === 'totals_and_adherence'),
        notes: live.some((c) => c.scope === 'notes'),
        recipient: live.find((c) => c.recipientId !== null)?.recipientId ?? null,
      },
      lapses: lapses.map((lapse) => ({
        at: lapse.occurredAt,
        severity: lapse.severity,
        context: lapse.context,
      })),
      observations: observations.map(withProvenance),
      answers: groupByScreen(answers),
    });
  }

  return {
    document: { exportedAt: now().toISOString(), locale, programs },
    audit: {
      programmes: enrolments.length,
      answers: totalAnswers,
      lapses: totalLapses,
      observations: totalObservations,
      locale,
    },
  };
}
