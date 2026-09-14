import type { Transaction } from '@tether/core';

/**
 * What the clinician surface needs from the database.
 *
 * Every method takes the clinician's account id, and every one of them is
 * scoped to a single enrolment. There is no method here that takes an account,
 * no method that returns a patient's other programmes, and no method that joins
 * two enrolments — because "never join across programmes" is a property the
 * type signatures either have or do not, and a comment saying so would be
 * weaker than the absence.
 *
 * The scope split runs through the interface too. [adherence] and
 * [measureSummaries] return numbers computed by the database; [notes],
 * [lapseEvents] and [textObservations] return content. A handler serving a
 * `totals_and_adherence` consent calls only the first group, so free text is
 * not filtered out of a response — it is never fetched into the process. The
 * policies added in `db/migrations/0005_care.sql` hold the same line one layer
 * down, so a handler that called the wrong one would still get nothing.
 */

export interface StoreContext {
  readonly tx: Transaction;
  /** The clinician's account id, from the JWT `sub`. */
  readonly clinicianId: string;
}

export type ConsentScope = 'totals_and_adherence' | 'notes';

export interface ConsentRow {
  readonly id: string;
  readonly enrolmentId: string;
  readonly scope: ConsentScope;
  readonly recipientKind: 'coach' | 'care_team' | 'supporter';
  readonly consentVersion: string;
  readonly grantedAt: string;
}

/**
 * One programme shared with this clinician.
 *
 * Note what is absent: the patient's account id. A clinician holding consent
 * for two enrolments must not be able to learn that they belong to the same
 * person — that is a join across programmes performed in the client's head, and
 * the only way to prevent it is not to hand over the key. See `app.ts` for the
 * cost of that decision, which is real.
 */
export interface SharedProgramme {
  readonly enrolmentId: string;
  readonly areaId: string;
  readonly status: 'active' | 'paused' | 'ended';
  readonly joinedOn: string;
  readonly consents: readonly ConsentRow[];
}

/** Counts and dates. Nothing here is a verdict, a grade or a risk. */
export interface Adherence {
  readonly programmeDays: number;
  readonly screensAnswered: number;
  readonly blocksAnswered: number;
  readonly lapses: {
    readonly recorded: number;
    readonly firstAt: string | null;
    readonly lastAt: string | null;
    /** ISO week buckets, oldest first. A trend, not an interpretation of one. */
    readonly byWeek: readonly { week: string; recorded: number }[];
  };
  readonly observations: {
    readonly recorded: number;
    readonly lastAt: string | null;
  };
}

export interface MeasureSummary {
  readonly measureId: string;
  readonly unit: string;
  readonly source: 'self_report' | 'device' | 'clinician' | 'derived';
  readonly platform: 'ios' | 'android' | 'web' | 'unknown' | null;
  readonly recorded: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly firstAt: string | null;
  readonly latestAt: string | null;
  readonly latestValue: number | null;
  readonly byWeek: readonly {
    week: string;
    recorded: number;
    min: number | null;
    max: number | null;
  }[];
}

/** A person's own words, from a `kind = 'text'` answer. `notes` scope only. */
export interface NoteRow {
  readonly screenId: string;
  readonly blockIndex: number;
  readonly text: string;
  readonly answeredAt: string;
}

export interface LapseEventRow {
  readonly occurredAt: string;
  readonly severity: string;
  readonly context: readonly string[];
}

export interface TextObservationRow {
  readonly measureId: string;
  readonly text: string;
  readonly unit: string;
  readonly observedAt: string;
  readonly source: MeasureSummary['source'];
  readonly platform: MeasureSummary['platform'];
}

export interface EscalationPolicy {
  readonly areaId: string;
  readonly version: string;
  readonly recipientKind: 'clinician' | 'care_team' | 'crisis_line';
  readonly contact: string;
  readonly crisisContact: string | null;
  readonly acknowledgeWithinMinutes: number;
  readonly configuredBy: string;
  readonly configuredAt: string;
  readonly effectiveFrom: string;
  readonly notes: string | null;
}

export interface EscalationInput {
  readonly enrolmentId: string;
  readonly consentId: string;
  readonly signal: string;
  readonly detail: string | null;
  readonly policy: EscalationPolicy;
}

export interface EscalationRow {
  readonly id: string;
  readonly enrolmentId: string;
  readonly signal: string;
  readonly detail: string | null;
  readonly policyAreaId: string;
  readonly policyVersion: string;
  readonly routedToKind: EscalationPolicy['recipientKind'];
  readonly routedTo: string;
  readonly raisedAt: string;
  readonly acknowledgeBy: string;
  readonly acknowledgedAt: string | null;
}

export interface EnrolmentSummary {
  readonly enrolmentId: string;
  readonly areaId: string;
  readonly status: 'active' | 'paused' | 'ended';
  readonly joinedOn: string;
  /**
   * The patient's account, for the audit row only.
   *
   * `ops.audit_event.account_id` is the subject of the event, so answering
   * "who has seen my record" requires it. It is fetched here and never leaves
   * the process in a response body — the two uses are separated on purpose,
   * and `app.ts` is the only caller.
   */
  readonly subjectAccountId: string;
}

export interface CareStore {
  /**
   * Programmes shared with this clinician, derived from live consent rows.
   *
   * Never from a clinician-side roster. A list a clinician's own record kept
   * would survive a revocation until somebody remembered to prune it, and
   * `for-clinicians.astro` promises the opposite: "revocation is enforced
   * rather than merely recorded".
   */
  sharedProgrammes(ctx: StoreContext): Promise<SharedProgramme[]>;

  /** Live consents for one enrolment naming this clinician. Empty means no. */
  liveConsentsFor(ctx: StoreContext, enrolmentId: string): Promise<ConsentRow[]>;

  enrolment(ctx: StoreContext, enrolmentId: string): Promise<EnrolmentSummary | null>;

  adherence(ctx: StoreContext, enrolmentId: string, asOf: Date): Promise<Adherence>;

  measureSummaries(ctx: StoreContext, enrolmentId: string): Promise<MeasureSummary[]>;

  notes(ctx: StoreContext, enrolmentId: string): Promise<NoteRow[]>;

  lapseEvents(ctx: StoreContext, enrolmentId: string): Promise<LapseEventRow[]>;

  textObservations(
    ctx: StoreContext,
    enrolmentId: string,
  ): Promise<TextObservationRow[]>;

  escalationPolicy(ctx: StoreContext, areaId: string): Promise<EscalationPolicy | null>;

  raiseEscalation(ctx: StoreContext, input: EscalationInput): Promise<EscalationRow>;

  escalations(ctx: StoreContext, enrolmentId: string): Promise<EscalationRow[]>;
}
