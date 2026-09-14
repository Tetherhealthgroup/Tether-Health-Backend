import type {
  Adherence,
  CareStore,
  ConsentRow,
  ConsentScope,
  EnrolmentSummary,
  MeasureSummary,
  StoreContext,
} from './store.ts';

/**
 * Turning a set of live consents into exactly what may be returned.
 *
 * Two scopes exist because the disclosures are different in kind, not in
 * degree: `programme.sharing_consent` calls them `totals_and_adherence` and
 * `notes`, and the schema's own comment is the whole argument — "a coach seeing
 * a total is a different disclosure from a coach reading a note."
 *
 * So the split here is not a filter applied to a full view. Under
 * `totals_and_adherence` the free-text queries are never issued: nothing that
 * could be a person's own words is fetched into this process, which means no
 * later refactor of a serialiser can leak one. The policies in
 * `db/migrations/0005_care.sql` hold the same line underneath, so the two have
 * to fail together for a note to escape.
 *
 * What is in neither scope, at any level of consent:
 *
 *  - a risk score, a percentage or a band (`no_risk_score`)
 *  - a verdict on a value (`no_result_interpretation`: "Lab values are stored
 *    and trended. The product does not say what a value means clinically.")
 *  - a diagnostic label or a condition badge (`never_diagnose`)
 *
 * This service returns values, counts and dates. A clinician interprets them;
 * that is what a clinician is for, and a system that pre-empted it would be
 * practising. There is no `risk`, `grade`, `interpretation`, `verdict` or
 * `severityScore` field anywhere in what follows, and a test asserts it.
 */

/** `notes` implies everything `totals_and_adherence` covers, and more. */
export function widestScope(consents: readonly ConsentRow[]): ConsentScope | null {
  if (consents.some((consent) => consent.scope === 'notes')) return 'notes';
  if (consents.some((consent) => consent.scope === 'totals_and_adherence')) {
    return 'totals_and_adherence';
  }
  return null;
}

/** The consent row a read was served under. Recorded on the audit event. */
export function consentRelied(
  consents: readonly ConsentRow[],
  scope: ConsentScope,
): ConsentRow {
  const match = consents.find((consent) => consent.scope === scope);
  if (!match) throw new Error('no consent matching the resolved scope');
  return match;
}

export interface PatientView {
  readonly enrolmentId: string;
  readonly areaId: string;
  readonly status: string;
  readonly joinedOn: string;
  /** What this response was served under, stated in the response itself. */
  readonly servedUnder: {
    readonly scope: ConsentScope;
    readonly consentId: string;
    readonly consentVersion: string;
    readonly grantedAt: string;
  };
  readonly adherence: Adherence;
  readonly measures: readonly (MeasureSummary & { selfReported: boolean })[];
  /** Present only under `notes`. Absent — not empty — under anything else. */
  readonly notes?: readonly {
    screenId: string;
    blockIndex: number;
    text: string;
    answeredAt: string;
  }[];
  readonly lapseEvents?: readonly {
    occurredAt: string;
    severity: string;
    context: readonly string[];
  }[];
  readonly textObservations?: readonly {
    measureId: string;
    text: string;
    unit: string;
    observedAt: string;
    source: string;
    platform: string | null;
    selfReported: boolean;
  }[];
}

export async function buildPatientView(
  ctx: StoreContext,
  store: CareStore,
  enrolment: EnrolmentSummary,
  consents: readonly ConsentRow[],
  scope: ConsentScope,
  asOf: Date,
): Promise<PatientView> {
  const consent = consentRelied(consents, scope);

  const adherence = await store.adherence(ctx, enrolment.enrolmentId, asOf);
  const measures = await store.measureSummaries(ctx, enrolment.enrolmentId);

  const base: PatientView = {
    enrolmentId: enrolment.enrolmentId,
    areaId: enrolment.areaId,
    status: enrolment.status,
    joinedOn: enrolment.joinedOn,
    servedUnder: {
      scope,
      consentId: consent.id,
      consentVersion: consent.consentVersion,
      grantedAt: consent.grantedAt,
    },
    adherence,
    // `self_report_only`: "The product is explicit that these are
    // self-reports." A clinician comparing a self-reported craving score with a
    // device-measured one needs the difference to arrive with the number, not
    // beside it in a legend.
    measures: measures.map((measure) => ({
      ...measure,
      selfReported: measure.source === 'self_report',
    })),
  };

  if (scope !== 'notes') return base;

  // Only now are the content queries issued at all. Sequential, because all of
  // this shares one transaction and a `pg` client runs one statement at a time.
  const notes = await store.notes(ctx, enrolment.enrolmentId);
  const lapseEvents = await store.lapseEvents(ctx, enrolment.enrolmentId);
  const textObservations = await store.textObservations(ctx, enrolment.enrolmentId);

  return {
    ...base,
    notes: notes.map((note) => ({ ...note })),
    lapseEvents: lapseEvents.map((lapse) => ({
      occurredAt: lapse.occurredAt,
      severity: lapse.severity,
      context: lapse.context,
    })),
    textObservations: textObservations.map((observation) => ({
      measureId: observation.measureId,
      text: observation.text,
      unit: observation.unit,
      observedAt: observation.observedAt,
      source: observation.source,
      platform: observation.platform,
      selfReported: observation.source === 'self_report',
    })),
  };
}
