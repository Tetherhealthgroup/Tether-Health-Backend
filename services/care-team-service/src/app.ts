import { Router, type Express, type Request } from 'express';
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
import { writeAudit } from './audit.ts';
import { escalationSchema, type EscalationBody } from './schemas.ts';
import type { CareStore, ConsentRow, StoreContext } from './store.ts';
import { buildPatientView, widestScope } from './view.ts';

/**
 * care-team-service — the clinician surface.
 *
 * This is the only service in the platform that reads across a consent
 * boundary, and that is why it is a service rather than a route on
 * `records-service`. ARCHITECTURE.md puts it plainly: "Separate service because
 * it is the only place a share is resolved, and that deserves its own audit
 * trail and its own blast radius." A compromise of the patient record service
 * exposes one person's record to themselves; a compromise here exposes many
 * people's records to somebody else.
 *
 * Four properties this file exists to hold:
 *
 * **1 · The list comes from live consent, never from a roster.**
 * `GET /patients` is a query over unrevoked `programme.sharing_consent` rows.
 * There is nowhere for a clinician's own copy of "my patients" to live, so
 * there is nothing to forget to prune. `for-clinicians.astro`: "revocation is
 * enforced rather than merely recorded."
 *
 * **2 · Every read is audited, including the refused ones.**
 * A clinician reading a patient record is a 42 CFR Part 2 event. Each read
 * writes `ops.audit_event` naming the enrolment, the scope relied on and the
 * consent id. A read that cannot be proved consented is a read that should not
 * have been served — so the proof is written in the same transaction, and a
 * refusal's row is committed *before* the 403 is thrown, because a throw inside
 * the transaction would roll the evidence back with it.
 *
 * **3 · Scope is a boundary, not a filter.**
 * `totals_and_adherence` gets aggregates; `notes` is required before a single
 * word a person wrote is fetched. See `view.ts`.
 *
 * **4 · No programme reaches another.**
 * Every route takes an enrolment id and resolves consent for that enrolment
 * alone. Nothing here takes an account, and `GET /patients` deliberately does
 * not return one, so two programmes belonging to one person are not joinable
 * even by the caller. That has a cost — see the note on `GET /patients` — and
 * it is the cost the schema was shaped to pay.
 */

export interface CareTeamDeps {
  readonly config: BaseConfig;
  readonly logger: Logger;
  readonly verifier: Verifier;
  readonly db: Database;
  readonly store: CareStore;
  readonly isReady?: () => Promise<boolean>;
  readonly now?: () => Date;
}

/**
 * The role a clinician holds on the JWT.
 *
 * Assumed, and worth flagging as an assumption: the identity model for
 * clinicians is not settled anywhere in the sources this backend was written
 * from. What is settled is that `programme.sharing_consent.recipient_id` is the
 * handle a person grants against, so that is what authorisation turns on here —
 * the role gets a caller through the door, and the consent row decides what is
 * behind it. Holding the role and no consent returns nothing.
 */
const CLINICIAN_ROLE = 'clinician';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AREA_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;

function pathEnrolmentId(req: Request): string {
  const value = req.params.enrolmentId;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw problem.validation('The enrolment id in the path is not a uuid.', [
      { path: 'enrolmentId', message: 'must be a uuid' },
    ]);
  }
  return value;
}

function pathAreaId(req: Request): string {
  const value = req.params.areaId;
  if (typeof value !== 'string' || !AREA_ID.test(value)) {
    throw problem.validation('The area id in the path is not a valid identifier.', [
      { path: 'areaId', message: 'must be 1-120 characters of [a-z0-9._-]' },
    ]);
  }
  return value;
}

/** The message a refused read gets. Identical in every case, by design. */
const REFUSAL =
  'No live consent covers this programme for you. Consent is granted per ' +
  'programme and revocation takes effect immediately.';

export function createCareTeamApp(deps: CareTeamDeps): Express {
  const { config, logger, verifier, db, store } = deps;
  const now = deps.now ?? (() => new Date());

  const app = createApp({ config, logger, verifier });
  const routes = Router();

  // Named per route rather than applied with `.use`, so that `finalise`'s
  // `/healthz` and `/readyz` stay reachable by an orchestrator carrying no
  // token, and so a route added without them is visible in the diff.
  const auth = requireAuth(verifier);
  const clinician = requireRole(CLINICIAN_ROLE);

  const audit = (
    req: Request,
    subjectAccountId: string | null,
    event: {
      action: string;
      resourceType: string;
      resourceId?: string | null;
      programmeId?: string | null;
      detail?: Record<string, unknown>;
    },
  ) => ({
    accountId: subjectAccountId,
    actorRole: CLINICIAN_ROLE,
    actorAccountId: principalOf(req).accountId,
    requestId: req.requestId,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    ...event,
  });

  // -- The shared list -------------------------------------------------------

  routes.get(
    '/patients',
    auth,
    clinician,
    handler(async (req, res) => {
      const principal = principalOf(req);

      const programmes = await db.withPrincipal(principal.accountId, async (tx) => {
        const ctx: StoreContext = { tx, clinicianId: principal.accountId };
        const shared = await store.sharedProgrammes(ctx);

        // One audit row for the listing rather than one per programme. The
        // disclosure is a single act — "these are the programmes shared with
        // you" — and the row still names every enrolment, every scope and every
        // consent id, which is what the requirement is actually for. A row per
        // entry would make the trail's size a function of how many people share
        // with a clinician rather than of how often they looked.
        await writeAudit(
          tx,
          audit(req, null, {
            action: 'care.patients.list',
            resourceType: 'sharing_consent',
            detail: {
              programmes: shared.map((programme) => ({
                enrolmentId: programme.enrolmentId,
                areaId: programme.areaId,
                scopes: programme.consents.map((consent) => consent.scope),
                consentIds: programme.consents.map((consent) => consent.id),
              })),
            },
          }),
        );

        return shared;
      });

      res.json({
        /**
         * Each entry is a shared *programme*, and carries no patient account id.
         *
         * That is the cost of "never join across programmes" paid in the
         * response body. A clinician with consent for one person's tobacco
         * programme and another person's alcohol programme sees two entries and
         * cannot tell whether they are one person or two — and neither could
         * they if the two programmes did belong to one person, which is the
         * whole point: `per_program_sharing` exists because "a cessation coach
         * has no business seeing behavioural health data", and an account id
         * would reconstitute exactly that link in the client.
         *
         * How a clinician recognises who they are looking at is therefore an
         * open question this service does not answer — the identity model for
         * the clinician side is not specified in any of the sources, and
         * inventing a patient display name here would mean inventing what may
         * be disclosed alongside it.
         */
        programmes: programmes.map((programme) => ({
          enrolmentId: programme.enrolmentId,
          areaId: programme.areaId,
          status: programme.status,
          joinedOn: programme.joinedOn,
          scopes: programme.consents.map((consent) => consent.scope),
          consents: programme.consents.map((consent) => ({
            id: consent.id,
            scope: consent.scope,
            recipientKind: consent.recipientKind,
            consentVersion: consent.consentVersion,
            grantedAt: consent.grantedAt,
          })),
        })),
      });
    }),
  );

  // -- One shared programme --------------------------------------------------

  routes.get(
    '/patients/:enrolmentId',
    auth,
    clinician,
    handler(async (req, res) => {
      const enrolmentId = pathEnrolmentId(req);
      const principal = principalOf(req);

      const outcome = await db.withPrincipal(principal.accountId, async (tx) => {
        const ctx: StoreContext = { tx, clinicianId: principal.accountId };

        // Consent first, every time, before anything is read. Resolved from the
        // live row rather than from anything cached, so a revocation a second
        // ago is in force now.
        const consents: ConsentRow[] = await store.liveConsentsFor(ctx, enrolmentId);
        const scope = widestScope(consents);
        const enrolment = scope ? await store.enrolment(ctx, enrolmentId) : null;

        if (!scope || !enrolment) {
          // The refusal is recorded and the transaction commits. Throwing here
          // would roll this row back, and an attempted disclosure nobody can
          // see afterwards is the one outcome worse than the disclosure.
          await writeAudit(
            tx,
            audit(req, null, {
              action: 'care.patient.read.refused',
              resourceType: 'enrolment',
              resourceId: enrolmentId,
              programmeId: enrolmentId,
              detail: { reason: 'no-live-consent' },
            }),
          );
          return null;
        }

        const view = await buildPatientView(
          ctx,
          store,
          enrolment,
          consents,
          scope,
          now(),
        );

        await writeAudit(
          tx,
          // Filed under the *patient's* account, because "who has seen my
          // record" is the question this table exists to answer.
          audit(req, enrolment.subjectAccountId, {
            action: 'care.patient.read',
            resourceType: 'enrolment',
            resourceId: enrolmentId,
            programmeId: enrolmentId,
            detail: {
              areaId: enrolment.areaId,
              scope,
              consentId: view.servedUnder.consentId,
              consentVersion: view.servedUnder.consentVersion,
              // Shape, not content: how much was disclosed, never what it said.
              disclosed: {
                measures: view.measures.length,
                notes: view.notes?.length ?? 0,
                lapseEvents: view.lapseEvents?.length ?? 0,
              },
            },
          }),
        );

        return view;
      });

      // Thrown outside the transaction, so the refusal's audit row has already
      // committed. `consent-required` rather than `forbidden` because
      // `errors.ts` reserves it for exactly this: "a read crossed a programme
      // boundary without consent covering it… this one is a 42 CFR Part 2 event
      // and is always audited."
      if (outcome === null) {
        throw problem.consentRequired(REFUSAL, { enrolmentId });
      }

      res.json(outcome);
    }),
  );

  // -- Escalation ------------------------------------------------------------

  routes.post(
    '/escalations',
    auth,
    clinician,
    validateBody(escalationSchema),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const body = req.body as EscalationBody;

      const outcome = await db.withPrincipal(principal.accountId, async (tx) => {
        const ctx: StoreContext = { tx, clinicianId: principal.accountId };

        const consents = await store.liveConsentsFor(ctx, body.enrolmentId);
        const scope = widestScope(consents);
        const enrolment = scope ? await store.enrolment(ctx, body.enrolmentId) : null;

        if (!scope || !enrolment) {
          await writeAudit(
            tx,
            audit(req, null, {
              action: 'care.escalation.refused',
              resourceType: 'escalation',
              resourceId: body.enrolmentId,
              programmeId: body.enrolmentId,
              detail: { reason: 'no-live-consent' },
            }),
          );
          return { refusal: 'consent' } as const;
        }

        /**
         * Routing is data, and the absence of the data is an answer.
         *
         * `distress_escalation`: "A distress signal never terminates at a
         * non-clinical coach. Routing is configured per program by clinical
         * leadership." A programme with no policy row has not had that
         * conversation, and the tempting fallback — route it to the recipient
         * on the consent, or to the nearest coach — is the precise failure the
         * safeguard names, because the nearest recipient in a cessation
         * programme *is* a coach.
         *
         * So this refuses. Refusing is visible: the clinician is told the
         * programme is not configured and can use the crisis route directly,
         * which is a worse experience and a correct one. Accepting would be a
         * signal that looks delivered and is not.
         */
        const policy = await store.escalationPolicy(ctx, enrolment.areaId);
        if (!policy) {
          await writeAudit(
            tx,
            audit(req, enrolment.subjectAccountId, {
              action: 'care.escalation.refused',
              resourceType: 'escalation',
              resourceId: body.enrolmentId,
              programmeId: body.enrolmentId,
              detail: { reason: 'no-escalation-policy', areaId: enrolment.areaId },
            }),
          );
          return { refusal: 'policy', areaId: enrolment.areaId } as const;
        }

        const consent = consents.find((row) => row.scope === scope)!;
        const escalation = await store.raiseEscalation(ctx, {
          enrolmentId: body.enrolmentId,
          consentId: consent.id,
          signal: body.signal,
          detail: body.detail,
          policy,
        });

        await writeAudit(
          tx,
          audit(req, enrolment.subjectAccountId, {
            action: 'care.escalation.raised',
            resourceType: 'escalation',
            resourceId: escalation.id,
            programmeId: body.enrolmentId,
            detail: {
              areaId: enrolment.areaId,
              scope,
              consentId: consent.id,
              signal: escalation.signal,
              policyVersion: policy.version,
              routedToKind: escalation.routedToKind,
            },
          }),
        );

        return { escalation } as const;
      });

      if ('refusal' in outcome) {
        if (outcome.refusal === 'consent') {
          throw problem.consentRequired(REFUSAL, { enrolmentId: body.enrolmentId });
        }
        throw problem.conflict(
          `The ${outcome.areaId} programme has no escalation policy configured, ` +
            'so a distress signal cannot be routed to a qualified person. ' +
            'Routing is set per programme by clinical leadership; use the crisis ' +
            'route directly.',
        );
      }

      res.status(201).json({ escalation: outcome.escalation });
    }),
  );

  // -- Routing, readable -----------------------------------------------------

  routes.get(
    '/escalation-policy/:areaId',
    auth,
    clinician,
    handler(async (req, res) => {
      const areaId = pathAreaId(req);
      const principal = principalOf(req);

      const policy = await db.withPrincipal(principal.accountId, (tx) =>
        store.escalationPolicy({ tx, clinicianId: principal.accountId }, areaId),
      );

      // Not audited, and deliberately not: a routing policy is operational
      // configuration with no PHI in it, and nothing about reading it says
      // anything about a patient. Auditing it would dilute a trail whose value
      // is that every row in it is a disclosure.
      if (!policy) {
        throw problem.notFound(
          `The ${areaId} programme has no escalation policy configured.`,
        );
      }

      res.json({ policy });
    }),
  );

  app.use(routes);

  return finalise(app, {
    serviceName: config.SERVICE_NAME,
    isReady: deps.isReady ?? (() => db.ping()),
  });
}
