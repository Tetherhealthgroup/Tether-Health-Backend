import type {
  Adherence,
  CareStore,
  ConsentRow,
  EnrolmentSummary,
  EscalationPolicy,
  EscalationRow,
  LapseEventRow,
  MeasureSummary,
  NoteRow,
  SharedProgramme,
  TextObservationRow,
} from './store.ts';

/**
 * The [CareStore] against Postgres.
 *
 * Every statement runs inside `db.withPrincipal(clinicianAccountId, …)`, so
 * `app.account_id` is the *clinician's* account and the policies added in
 * `db/migrations/0005_care.sql` are what makes any of these queries return a
 * row at all. That is the design: the predicate that decides what a clinician
 * may see is a live consent row, evaluated by the database on every statement,
 * and revoking a consent takes effect on the next one with nothing to
 * invalidate.
 *
 * Every statement below names the clinician as well, through `LIVE_CONSENT`.
 * That began as an omission rather than a decision: the first version of this
 * file leaned on the policy alone, on the reasoning that a second copy of the
 * consent join would drift from the first. The reasoning missed the case that
 * matters. `0003`'s `*_own` policies are OR'd with 0005's recipient policies, so
 * a clinician who is also a patient reads *their own* enrolment through the
 * first, and a query with no consent predicate of its own would serve it as if
 * it were a shared one — outside the consent scope, unaudited as a disclosure.
 * The copy cannot drift far: it is one helper, used by every statement, and the
 * integration suite runs both against the same database.
 *
 * What this file does not contain, and must never grow: a query that reaches an
 * account, a query that returns two enrolments, or any expression producing a
 * risk, a grade, a score or an interpretation. `no_risk_score`,
 * `no_result_interpretation`, `never_diagnose`.
 */

/**
 * "This clinician holds a live consent on this enrolment", as a predicate.
 *
 * `enrolment` and `clinician` are SQL fragments written in this file — a column
 * reference and a bind placeholder — never input. With `scope` set, only a
 * consent of that scope satisfies it: `notes` for anything a person wrote.
 *
 * `enrolment` must be **qualified** (`record.observation.enrolment_id`, never
 * `enrolment_id`). The subquery's own table has a column of that name, so an
 * unqualified reference binds to the consent row itself, the join degenerates to
 * `consent.enrolment_id = consent.enrolment_id`, and the predicate quietly means
 * "this clinician holds a live consent on *something*". The integration suite
 * found exactly that, and `predicates.test.ts` now rejects it.
 */
const LIVE_CONSENT = (
  enrolment: string,
  clinician: string,
  scope?: 'notes',
): string =>
  `EXISTS (SELECT 1 FROM programme.sharing_consent consent
            WHERE consent.enrolment_id = ${enrolment}
              AND consent.revoked_at IS NULL
              AND consent.recipient_id = ${clinician}${
                scope ? `
              AND consent.scope = '${scope}'` : ''
              })`;

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

const numOrNull = (value: string | number | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : Number(value);

type ShareRecord = {
  enrolment_id: string;
  area_id: string;
  status: SharedProgramme['status'];
  joined_on: Date | string;
  consent_id: string;
  scope: ConsentRow['scope'];
  recipient_kind: ConsentRow['recipientKind'];
  consent_version: string;
  granted_at: Date | string;
};

type ConsentRecord = {
  id: string;
  enrolment_id: string;
  scope: ConsentRow['scope'];
  recipient_kind: ConsentRow['recipientKind'];
  consent_version: string;
  granted_at: Date | string;
};

type AdherenceRecord = {
  programme_days: string;
  screens_answered: string;
  blocks_answered: string;
  lapses_recorded: string;
  lapses_first_at: Date | string | null;
  lapses_last_at: Date | string | null;
  observations_recorded: string;
  observations_last_at: Date | string | null;
};

type WeekRecord = { week: string; recorded: string };

type MeasureRecord = {
  measure_id: string;
  unit: string;
  source: MeasureSummary['source'];
  platform: MeasureSummary['platform'];
  recorded: string;
  min_value: string | null;
  max_value: string | null;
  first_at: Date | string | null;
  latest_at: Date | string | null;
  latest_value: string | null;
};

type MeasureWeekRecord = {
  measure_id: string;
  week: string;
  recorded: string;
  min_value: string | null;
  max_value: string | null;
};

type EscalationPolicyRecord = {
  area_id: string;
  version: string;
  clinical_recipient_kind: EscalationPolicy['recipientKind'];
  clinical_contact: string;
  crisis_contact: string | null;
  acknowledge_within_minutes: number;
  configured_by: string;
  configured_at: Date | string;
  effective_from: Date | string;
  notes: string | null;
};

type EscalationRecord = {
  id: string;
  enrolment_id: string;
  signal: string;
  detail: string | null;
  policy_area_id: string;
  policy_version: string;
  routed_to_kind: EscalationPolicy['recipientKind'];
  routed_to: string;
  raised_at: Date | string;
  acknowledge_by: Date | string;
  acknowledged_at: Date | string | null;
};

const toPolicy = (row: EscalationPolicyRecord): EscalationPolicy => ({
  areaId: row.area_id,
  version: row.version,
  recipientKind: row.clinical_recipient_kind,
  contact: row.clinical_contact,
  crisisContact: row.crisis_contact,
  acknowledgeWithinMinutes: row.acknowledge_within_minutes,
  configuredBy: row.configured_by,
  configuredAt: iso(row.configured_at),
  effectiveFrom: iso(row.effective_from),
  notes: row.notes,
});

const toEscalation = (row: EscalationRecord): EscalationRow => ({
  id: row.id,
  enrolmentId: row.enrolment_id,
  signal: row.signal,
  detail: row.detail,
  policyAreaId: row.policy_area_id,
  policyVersion: row.policy_version,
  routedToKind: row.routed_to_kind,
  routedTo: row.routed_to,
  raisedAt: iso(row.raised_at),
  acknowledgeBy: iso(row.acknowledge_by),
  acknowledgedAt: isoOrNull(row.acknowledged_at),
});

export function createPostgresStore(): CareStore {
  return {
    async sharedProgrammes(ctx) {
      // Driven from `programme.sharing_consent`, so the list *is* the live
      // grants. There is no clinician-side roster to fall out of date, and a
      // revocation removes a programme from this result on the next request.
      //
      // `e.account_id` is not selected. A clinician consented to two programmes
      // must not be handed the fact that they belong to one person.
      const rows = await ctx.tx.query<ShareRecord>(
        `SELECT e.id AS enrolment_id, e.area_id, e.status, e.joined_on,
                c.id AS consent_id, c.scope, c.recipient_kind,
                c.consent_version, c.granted_at
           FROM programme.sharing_consent c
           JOIN programme.enrolment e ON e.id = c.enrolment_id
          WHERE c.revoked_at IS NULL
            AND c.recipient_id = $1
          ORDER BY e.area_id, c.scope`,
        [ctx.clinicianId],
      );

      const byEnrolment = new Map<string, SharedProgramme & { consents: ConsentRow[] }>();
      for (const row of rows) {
        let programme = byEnrolment.get(row.enrolment_id);
        if (!programme) {
          programme = {
            enrolmentId: row.enrolment_id,
            areaId: row.area_id,
            status: row.status,
            joinedOn: iso(row.joined_on),
            consents: [],
          };
          byEnrolment.set(row.enrolment_id, programme);
        }
        programme.consents.push({
          id: row.consent_id,
          enrolmentId: row.enrolment_id,
          scope: row.scope,
          recipientKind: row.recipient_kind,
          consentVersion: row.consent_version,
          grantedAt: iso(row.granted_at),
        });
      }
      return [...byEnrolment.values()];
    },

    async liveConsentsFor(ctx, enrolmentId) {
      const rows = await ctx.tx.query<ConsentRecord>(
        `SELECT id, enrolment_id, scope, recipient_kind, consent_version, granted_at
           FROM programme.sharing_consent
          WHERE enrolment_id = $1
            AND revoked_at IS NULL
            AND recipient_id = $2
          ORDER BY scope`,
        [enrolmentId, ctx.clinicianId],
      );
      return rows.map(
        (row): ConsentRow => ({
          id: row.id,
          enrolmentId: row.enrolment_id,
          scope: row.scope,
          recipientKind: row.recipient_kind,
          consentVersion: row.consent_version,
          grantedAt: iso(row.granted_at),
        }),
      );
    },

    async enrolment(ctx, enrolmentId) {
      // `account_id` is selected here and nowhere else, for the audit row. The
      // subject of a disclosure has to be recorded or "who has seen my record"
      // has no answer; it does not follow that it belongs in a response.
      const row = await ctx.tx.one<{
        id: string;
        area_id: string;
        status: EnrolmentSummary['status'];
        joined_on: Date | string;
        account_id: string;
      }>(
        `SELECT id, area_id, status, joined_on, account_id
           FROM programme.enrolment
          WHERE id = $1 AND ${LIVE_CONSENT('programme.enrolment.id', '$2')}`,
        [enrolmentId, ctx.clinicianId],
      );
      return row
        ? {
            enrolmentId: row.id,
            areaId: row.area_id,
            status: row.status,
            joinedOn: iso(row.joined_on),
            subjectAccountId: row.account_id,
          }
        : null;
    },

    async adherence(ctx, enrolmentId, asOf) {
      // Aggregated by the database rather than by counting rows in the process.
      //
      // Under a `totals_and_adherence` consent the policies in 0005 hide every
      // free-text answer, so this is not "fetch then filter" — the text is not
      // in the result set to be mishandled. Which also means `blocks_answered`
      // is a count of what the consent covers, and that is the honest number:
      // reporting blocks a clinician may not see would disclose that they exist.
      const summary = await ctx.tx.one<AdherenceRecord>(
        `SELECT
           greatest(0, floor(extract(epoch FROM ($2::timestamptz - e.joined_on)) / 86400))::text
             AS programme_days,
           (SELECT count(DISTINCT screen_id)::text FROM record.screen_answer
             WHERE enrolment_id = $1) AS screens_answered,
           (SELECT count(*)::text FROM record.screen_answer
             WHERE enrolment_id = $1) AS blocks_answered,
           (SELECT count(*)::text FROM record.lapse_event
             WHERE enrolment_id = $1) AS lapses_recorded,
           (SELECT min(occurred_at) FROM record.lapse_event
             WHERE enrolment_id = $1) AS lapses_first_at,
           (SELECT max(occurred_at) FROM record.lapse_event
             WHERE enrolment_id = $1) AS lapses_last_at,
           (SELECT count(*)::text FROM record.observation
             WHERE enrolment_id = $1) AS observations_recorded,
           (SELECT max(observed_at) FROM record.observation
             WHERE enrolment_id = $1) AS observations_last_at
         FROM programme.enrolment e
        WHERE e.id = $1 AND ${LIVE_CONSENT('e.id', '$3')}`,
        [enrolmentId, asOf.toISOString(), ctx.clinicianId],
      );

      // ISO weeks, oldest first. A count per week is a trend; nothing here says
      // whether the trend is good, and `no_result_interpretation` is why.
      const weeks = await ctx.tx.query<WeekRecord>(
        `SELECT to_char(date_trunc('week', occurred_at), 'IYYY"-W"IW') AS week,
                count(*)::text AS recorded
           FROM record.lapse_event
          WHERE enrolment_id = $1 AND ${LIVE_CONSENT('record.lapse_event.enrolment_id', '$2')}
          GROUP BY 1
          ORDER BY 1`,
        [enrolmentId, ctx.clinicianId],
      );

      return {
        programmeDays: Number(summary?.programme_days ?? 0),
        screensAnswered: Number(summary?.screens_answered ?? 0),
        blocksAnswered: Number(summary?.blocks_answered ?? 0),
        lapses: {
          recorded: Number(summary?.lapses_recorded ?? 0),
          firstAt: isoOrNull(summary?.lapses_first_at ?? null),
          lastAt: isoOrNull(summary?.lapses_last_at ?? null),
          byWeek: weeks.map((row) => ({
            week: row.week,
            recorded: Number(row.recorded),
          })),
        },
        observations: {
          recorded: Number(summary?.observations_recorded ?? 0),
          lastAt: isoOrNull(summary?.observations_last_at ?? null),
        },
      } satisfies Adherence;
    },

    async measureSummaries(ctx, enrolmentId) {
      // Numeric observations only. A textual one is a person's own words and
      // belongs to the `notes` scope; it is excluded here rather than
      // summarised, because there is no honest aggregate of a sentence.
      const rows = await ctx.tx.query<MeasureRecord>(
        `SELECT measure_id, unit, source, platform,
                count(*)::text AS recorded,
                min(value_num)::text AS min_value,
                max(value_num)::text AS max_value,
                min(observed_at) AS first_at,
                max(observed_at) AS latest_at,
                (array_agg(value_num ORDER BY observed_at DESC))[1]::text AS latest_value
           FROM record.observation
          WHERE enrolment_id = $1 AND value_num IS NOT NULL
            AND ${LIVE_CONSENT('record.observation.enrolment_id', '$2')}
          GROUP BY measure_id, unit, source, platform
          ORDER BY measure_id`,
        [enrolmentId, ctx.clinicianId],
      );

      const weeks = await ctx.tx.query<MeasureWeekRecord>(
        `SELECT measure_id,
                to_char(date_trunc('week', observed_at), 'IYYY"-W"IW') AS week,
                count(*)::text AS recorded,
                min(value_num)::text AS min_value,
                max(value_num)::text AS max_value
           FROM record.observation
          WHERE enrolment_id = $1 AND value_num IS NOT NULL
            AND ${LIVE_CONSENT('record.observation.enrolment_id', '$2')}
          GROUP BY 1, 2
          ORDER BY 1, 2`,
        [enrolmentId, ctx.clinicianId],
      );

      return rows.map(
        (row): MeasureSummary => ({
          measureId: row.measure_id,
          unit: row.unit,
          source: row.source,
          platform: row.platform,
          recorded: Number(row.recorded),
          min: numOrNull(row.min_value),
          max: numOrNull(row.max_value),
          firstAt: isoOrNull(row.first_at),
          latestAt: isoOrNull(row.latest_at),
          latestValue: numOrNull(row.latest_value),
          byWeek: weeks
            .filter((week) => week.measure_id === row.measure_id)
            .map((week) => ({
              week: week.week,
              recorded: Number(week.recorded),
              min: numOrNull(week.min_value),
              max: numOrNull(week.max_value),
            })),
        }),
      );
    },

    async notes(ctx, enrolmentId) {
      // Called only under a `notes` consent. Under any other the policy in 0005
      // returns nothing here anyway, which is the arrangement worth having: the
      // service decides what to ask for, and the database decides what exists.
      const rows = await ctx.tx.query<{
        screen_id: string;
        block_index: number;
        value: string;
        answered_at: Date | string;
      }>(
        `SELECT screen_id, block_index, value #>> '{}' AS value, answered_at
           FROM record.screen_answer
          WHERE enrolment_id = $1 AND kind = 'text'
            AND ${LIVE_CONSENT('record.screen_answer.enrolment_id', '$2', 'notes')}
          ORDER BY screen_id, block_index`,
        [enrolmentId, ctx.clinicianId],
      );
      return rows.map(
        (row): NoteRow => ({
          screenId: row.screen_id,
          blockIndex: row.block_index,
          text: row.value,
          answeredAt: iso(row.answered_at),
        }),
      );
    },

    async lapseEvents(ctx, enrolmentId) {
      const rows = await ctx.tx.query<{
        occurred_at: Date | string;
        severity: string;
        context: string[];
      }>(
        // Through `care.lapse_details`, not the table: this role may select a
        // lapse's date and nothing else from `record.lapse_event` (0011), and
        // the function returns `severity` and `context` only to a live `notes`
        // consent that names the caller.
        `SELECT occurred_at, severity, context
           FROM care.lapse_details($1)`,
        [enrolmentId],
      );
      return rows.map(
        (row): LapseEventRow => ({
          occurredAt: iso(row.occurred_at),
          severity: row.severity,
          context: row.context,
        }),
      );
    },

    async textObservations(ctx, enrolmentId) {
      const rows = await ctx.tx.query<{
        measure_id: string;
        value_text: string;
        unit: string;
        observed_at: Date | string;
        source: MeasureSummary['source'];
        platform: MeasureSummary['platform'];
      }>(
        `SELECT measure_id, value_text, unit, observed_at, source, platform
           FROM record.observation
          WHERE enrolment_id = $1 AND value_text IS NOT NULL
            AND ${LIVE_CONSENT('record.observation.enrolment_id', '$2', 'notes')}
          ORDER BY observed_at DESC`,
        [enrolmentId, ctx.clinicianId],
      );
      return rows.map(
        (row): TextObservationRow => ({
          measureId: row.measure_id,
          text: row.value_text,
          unit: row.unit,
          observedAt: iso(row.observed_at),
          source: row.source,
          platform: row.platform,
        }),
      );
    },

    async escalationPolicy(ctx, areaId) {
      const row = await ctx.tx.one<EscalationPolicyRecord>(
        `SELECT area_id, version, clinical_recipient_kind, clinical_contact,
                crisis_contact, acknowledge_within_minutes, configured_by,
                configured_at, effective_from, notes
           FROM care.escalation_policy
          WHERE area_id = $1 AND effective_from <= now()`,
        [areaId],
      );
      return row ? toPolicy(row) : null;
    },

    async raiseEscalation(ctx, input) {
      // The routing is copied out of the policy and written onto the row rather
      // than referenced. Where a signal went is a historical fact; a policy
      // edited next month changes where the next one goes and rewrites nothing.
      //
      // Inserted *from* the clinician's own live consent, so an escalation can
      // only cite a consent that names the caller and belongs to this
      // enrolment. Any other consent id produces no row.
      const row = await ctx.tx.one<EscalationRecord>(
        `INSERT INTO care.escalation (
           enrolment_id, raised_by, consent_id, signal, detail,
           policy_area_id, policy_version, routed_to_kind, routed_to, acknowledge_by
         )
         SELECT c.enrolment_id, $2::uuid, c.id, $4, $5,
                $6, $7, $8, $9, now() + make_interval(mins => $10::int)
           FROM programme.sharing_consent c
          WHERE c.id = $3
            AND c.enrolment_id = $1
            AND c.revoked_at IS NULL
            AND c.recipient_id = $11
         RETURNING id, enrolment_id, signal, detail, policy_area_id, policy_version,
                   routed_to_kind, routed_to, raised_at, acknowledge_by, acknowledged_at`,
        [
          input.enrolmentId,
          ctx.clinicianId,
          input.consentId,
          input.signal,
          input.detail,
          input.policy.areaId,
          input.policy.version,
          input.policy.recipientKind,
          input.policy.contact,
          input.policy.acknowledgeWithinMinutes,
          ctx.clinicianId,
        ],
      );
      if (!row) throw new Error('escalation insert returned no row');
      return toEscalation(row);
    },

    async escalations(ctx, enrolmentId) {
      const rows = await ctx.tx.query<EscalationRecord>(
        `SELECT id, enrolment_id, signal, detail, policy_area_id, policy_version,
                routed_to_kind, routed_to, raised_at, acknowledge_by, acknowledged_at
           FROM care.escalation
          WHERE enrolment_id = $1 AND ${LIVE_CONSENT('care.escalation.enrolment_id', '$2')}
          ORDER BY raised_at DESC`,
        [enrolmentId, ctx.clinicianId],
      );
      return rows.map(toEscalation);
    },
  };
}
