import type { Express } from 'express';
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
import {
  conditionCreateSchema,
  medicationCreateSchema,
  profilePatchSchema,
  uuidParam,
  vitalEntrySchema,
  type ConditionCreate,
  type MedicationInput,
  type ProfilePatch,
  type VitalEntryInput,
} from './schema.ts';
import {
  conditionExists,
  createCondition,
  createMedication,
  createVital,
  deleteMedication,
  getProfile,
  listConditions,
  listMedications,
  listVitals,
  upsertProfile,
} from './store.ts';

/**
 * chronic-service — the bridge for the `chronic-care` Flutter app.
 *
 *   GET    /profile
 *   PATCH  /profile
 *   GET    /conditions
 *   POST   /conditions
 *   GET    /conditions/:id/vitals
 *   POST   /conditions/:id/vitals
 *   GET    /medications
 *   POST   /medications
 *   DELETE /medications/:id
 *
 * ---------------------------------------------------------------------------
 * What this service is replacing
 * ---------------------------------------------------------------------------
 *
 * `chronic-care/backend/` is a FastAPI service the app has never called
 * (`API_ONLINE` defaults false, `lib/services/api_service.dart`). It has no
 * tenancy isolation: seventeen of its twenty authenticated routes take a
 * `user_id` and never use it. `routes.py:198`:
 *
 *     res = await session.execute(
 *         select(Profile).order_by(Profile.created_at.asc()).limit(1))
 *
 * — the oldest profile in the table, handed to whoever asked, with `PATCH`
 * writing to the same row twenty lines later.
 *
 * Every route below runs inside `db.withPrincipal(principal.accountId)`, and
 * `0007_chronic.sql` forces RLS on all four tables, which this service reaches
 * as its own least-privilege role (`0009`). A handler that forgot its predicate
 * would return an empty set, because the transaction can only see rows
 * reachable from `app.account_id`. `store.ts` writes the predicate anyway — the
 * policy is the backstop, not the statement of intent.
 *
 * What is never logged: a metric key, a condition kind, a value, a note, a drug
 * name. Each of those says what is wrong with a person, and the log collector is
 * read by people with no clinical relationship to them. Handlers log the id of
 * what they wrote, and nothing about its contents.
 *
 * The one thing a handler must still get right is *which account* it opens the
 * transaction for, and that comes from the verified token. No route reads an
 * owner from a path, a query string or a body — see `schema.ts`.
 */

export interface ChronicConfig extends BaseConfig {
  /**
   * How many readings a vitals request returns.
   *
   * Bounded because the Insights tab charts a trend, not a lifetime, and an
   * unbounded read of somebody with two years of daily glucose entries is a
   * slow query that grows for as long as they stay engaged — so the people
   * the product works best for would get the worst experience.
   */
  readonly CHRONIC_VITALS_PAGE_MAX: number;
  readonly CHRONIC_VITALS_PAGE_DEFAULT: number;
}

export interface ChronicDeps {
  readonly config: ChronicConfig;
  readonly logger: Logger;
  readonly verifier: Verifier;
  readonly db: Database;
  readonly isReady?: () => Promise<boolean>;
}

export function createChronicApp(deps: ChronicDeps): Express {
  const { config, logger, verifier, db } = deps;

  const app = createApp({ config, logger, verifier });

  /**
   * There is no unauthenticated route in this service — a list of which chronic
   * conditions somebody manages is health information before a single reading is
   * attached to it.
   *
   * Applied per route rather than with `app.use`. `finalise` mounts `/healthz`
   * and `/readyz` *after* this file's routes, so a global `app.use(requireAuth)`
   * here would sit in front of them: the container would fail its own health
   * check, the orchestrator would restart it forever, and the symptom would look
   * like a crash loop rather than a 401.
   */
  const auth = requireAuth(verifier);

  /** `limit`, clamped. A client asking for a million gets the ceiling, not a 400. */
  function pageLimit(raw: unknown): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return config.CHRONIC_VITALS_PAGE_DEFAULT;
    return Math.min(Math.trunc(parsed), config.CHRONIC_VITALS_PAGE_MAX);
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  app.get(
    '/profile',
    auth,
    handler(async (req, res) => {
      const principal = principalOf(req);

      const profile = await db.withPrincipal(principal.accountId, (tx) =>
        getProfile(tx, principal.accountId),
      );

      if (!profile) {
        // 404, and deliberately not "here is the first profile we found". That
        // sentence is the entire bug being fixed. An account with no chronic-care
        // profile has no chronic-care profile.
        throw problem.notFound('No chronic-care profile for this account yet.');
      }

      res.json(profile);
    }),
  );

  app.patch(
    '/profile',
    auth,
    validateBody(profilePatchSchema),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const patch = req.body as ProfilePatch;

      const profile = await db.withPrincipal(principal.accountId, (tx) =>
        upsertProfile(tx, principal.accountId, patch),
      );

      // The patched fields are not logged. `displayName` is a name and `dob` is a
      // date of birth; between them they identify a person, and a log line is
      // read by people with no clinical relationship to them.
      req.log.info({ fields: Object.keys(patch) }, 'chronic profile updated');

      res.json(profile);
    }),
  );

  // ---------------------------------------------------------------------------
  // Conditions
  // ---------------------------------------------------------------------------

  app.get(
    '/conditions',
    auth,
    handler(async (req, res) => {
      const principal = principalOf(req);
      const conditions = await db.withPrincipal(principal.accountId, (tx) =>
        listConditions(tx, principal.accountId),
      );
      res.json(conditions);
    }),
  );

  app.post(
    '/conditions',
    auth,
    validateBody(conditionCreateSchema),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const input = req.body as ConditionCreate;

      const condition = await db.withPrincipal(principal.accountId, (tx) =>
        createCondition(tx, principal.accountId, input),
      );

      // The condition's id, not its kind. `kind` is a diagnosis. "Did that write
      // land?" is answered by the id, which is what an incident reader can look
      // up under RLS.
      req.log.info({ conditionId: condition.id }, 'chronic condition recorded');

      res.status(201).json(condition);
    }),
  );

  // ---------------------------------------------------------------------------
  // Vitals
  // ---------------------------------------------------------------------------

  app.get(
    '/conditions/:id/vitals',
    auth,
    handler(async (req, res) => {
      const principal = principalOf(req);
      const parsed = uuidParam.safeParse(req.params.id);
      if (!parsed.success) throw problem.notFound('No such condition.');

      const vitals = await db.withPrincipal(principal.accountId, async (tx) => {
        // Existence and ownership are one question under RLS: a condition
        // belonging to someone else is not visible on this transaction. The check
        // is here so the answer is 404 rather than an empty list, which would
        // read as "no readings yet" for a condition that is not theirs.
        if (!(await conditionExists(tx, principal.accountId, parsed.data))) {
          throw problem.notFound('No such condition.');
        }
        return listVitals(tx, principal.accountId, parsed.data, pageLimit(req.query.limit));
      });

      res.json(vitals);
    }),
  );

  app.post(
    '/conditions/:id/vitals',
    auth,
    validateBody(vitalEntrySchema),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const input = req.body as VitalEntryInput;

      const parsed = uuidParam.safeParse(req.params.id);
      if (!parsed.success) throw problem.notFound('No such condition.');
      const conditionId = parsed.data;

      // The app posts `entry.toJson()` whole, so `conditionId` is usually in the
      // body as well as the path. Agreement is required rather than resolved: a
      // client that disagrees with itself about where a reading belongs would
      // otherwise file a blood-glucose value under asthma, and the chart would
      // look plausible.
      if (input.conditionId && input.conditionId !== conditionId) {
        throw problem.validation(
          'The reading names a different condition from the one in the URL.',
          [{ path: 'conditionId', message: `Expected ${conditionId}.` }],
        );
      }

      const vital = await db.withPrincipal(principal.accountId, async (tx) => {
        if (!(await conditionExists(tx, principal.accountId, conditionId))) {
          throw problem.notFound('No such condition.');
        }
        return createVital(tx, principal.accountId, conditionId, input);
      });

      // The reading's id only. Not `metricKey` (`blood_glucose` names a
      // condition), not `value`, not `note`. Core's redaction list also covers
      // them, at the top level and one level down, as a net for the next handler
      // that forgets.
      req.log.info({ vitalId: vital.id }, 'vital recorded');

      res.status(201).json(vital);
    }),
  );

  // ---------------------------------------------------------------------------
  // Medications
  // ---------------------------------------------------------------------------

  app.get(
    '/medications',
    auth,
    handler(async (req, res) => {
      const principal = principalOf(req);
      const medications = await db.withPrincipal(principal.accountId, (tx) =>
        listMedications(tx, principal.accountId),
      );
      res.json(medications);
    }),
  );

  app.post(
    '/medications',
    auth,
    validateBody(medicationCreateSchema),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const input = req.body as MedicationInput;

      const medication = await db.withPrincipal(principal.accountId, (tx) =>
        createMedication(tx, principal.accountId, input),
      );

      // The drug's name is not logged. "Which medications does this person take"
      // is among the most disclosive facts in the product — it implies the
      // diagnosis — and a log collector is not where it belongs.
      req.log.info({ medicationId: medication.id }, 'medication recorded');

      res.status(201).json(medication);
    }),
  );

  app.delete(
    '/medications/:id',
    auth,
    handler(async (req, res) => {
      const principal = principalOf(req);
      const parsed = uuidParam.safeParse(req.params.id);
      if (!parsed.success) {
        // Nothing to delete and nothing to disclose: the same 204 a well-formed
        // id that matched nothing would get.
        res.status(204).end();
        return;
      }

      const removed = await db.withPrincipal(principal.accountId, (tx) =>
        deleteMedication(tx, principal.accountId, parsed.data),
      );

      req.log.info({ medicationId: parsed.data, removed }, 'medication deleted');

      // 204 either way. Under RLS a medication belonging to somebody else simply
      // is not there, so a 404 would distinguish "not yours" from "not ours" —
      // which is an existence oracle over a table of prescriptions.
      res.status(204).end();
    }),
  );

  return finalise(app, {
    serviceName: config.SERVICE_NAME,
    isReady: deps.isReady ?? (() => db.ping()),
  });
}
