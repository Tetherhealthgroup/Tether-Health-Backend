import type { Transaction } from '@tether/core';
import type { BlockAnswer } from './answers.ts';

/**
 * What this service needs from the database, stated as a contract.
 *
 * Two reasons it is an interface rather than SQL sprinkled through the
 * handlers. The first is ordinary: the rules worth testing here — that a
 * re-sent sync batch writes nothing the second time, that a lapse never
 * decrements anything, that a deletion leaves no rows — are properties of the
 * *contract*, and asserting them should not require a Postgres.
 *
 * The second is the one that matters. Every method below takes the caller's
 * account id explicitly, even though `db.withPrincipal` has already set
 * `app.account_id` and RLS will filter on it. That duplication is deliberate:
 * `packages/core/src/db.ts` documents the chronic-care bug where 17 of 20
 * authenticated routes take a `user_id` and never use it, and RLS is what turns
 * that class of bug into an empty result rather than another patient's record.
 * Belt and braces — but the braces are the database's, and the belt is here so
 * that a reviewer can see the predicate without reading the migration.
 */

/** Ambient context for one call: the open transaction and whose it is. */
export interface StoreContext {
  readonly tx: Transaction;
  readonly accountId: string;
}

export interface EnrolmentRow {
  readonly id: string;
  readonly areaId: string;
  readonly status: 'active' | 'paused' | 'ended';
  readonly hidden: boolean;
  readonly joinedOn: string;
  readonly endedAt: string | null;
}

export interface StoredAnswer extends BlockAnswer {
  readonly screenId: string;
  readonly answeredAt: string;
  readonly updatedAt: string;
}

export interface LapseInput {
  readonly occurredAt: string;
  readonly severity: string;
  readonly context: readonly string[];
}

export interface LapseRow extends LapseInput {
  readonly id: string;
  readonly recordedAt: string;
}

export type ObservationSource = 'self_report' | 'device' | 'clinician' | 'derived';
export type ObservationPlatform = 'ios' | 'android' | 'web' | 'unknown';

export interface ObservationInput {
  readonly measureId: string;
  /** Numeric or textual; `record.observation` requires exactly one to be set. */
  readonly value: number | string;
  readonly unit: string;
  readonly observedAt: string;
  readonly source: ObservationSource;
  readonly platform: ObservationPlatform | null;
}

export interface ObservationRow extends ObservationInput {
  readonly id: string;
  readonly recordedAt: string;
}

/** A live row of `programme.sharing_consent`, for the export's `sharing` block. */
export interface ConsentRow {
  readonly id: string;
  readonly enrolmentId: string;
  readonly scope: 'totals_and_adherence' | 'notes';
  readonly recipientKind: 'coach' | 'care_team' | 'supporter';
  readonly recipientId: string | null;
}

/**
 * Whether a write created a row or found the identical one already there.
 *
 * The distinction is the whole of `POST /sync`'s idempotency guarantee, so it
 * is carried in the type rather than inferred from a row count at the call
 * site.
 */
export interface Appended<T> {
  readonly row: T;
  readonly created: boolean;
}

export interface DeletionCounts {
  readonly enrolments: number;
  readonly answers: number;
  readonly lapses: number;
  readonly observations: number;
  readonly consents: number;
}

/** What a completed `POST /sync` recorded, replayed verbatim on a re-send. */
export interface SyncReceipt {
  readonly idempotencyKey: string;
  readonly syncedAt: string;
  readonly applied: {
    readonly answers: number;
    readonly lapses: number;
    readonly observations: number;
  };
  readonly duplicates: {
    readonly lapses: number;
    readonly observations: number;
  };
  readonly rejected: readonly {
    readonly item: string;
    readonly key: string;
    readonly reason: string;
  }[];
  /**
   * Client-supplied item ids the batch carried, in order.
   *
   * Part of the receipt rather than a separate field on the audit row so that
   * the stored copy and the first response are the same object. A replay must
   * return what the first run returned, and the cheapest way to guarantee that
   * is for there to be nothing the first run returns that is not stored.
   */
  readonly eventIds: readonly string[];
}

export interface RecordStore {
  /** The caller's enrolment in one area, or null when they have none. */
  enrolmentForArea(ctx: StoreContext, areaId: string): Promise<EnrolmentRow | null>;

  /** Every enrolment the caller holds, joined or ended. */
  enrolments(ctx: StoreContext): Promise<EnrolmentRow[]>;

  answers(ctx: StoreContext, enrolmentId: string): Promise<StoredAnswer[]>;

  /**
   * Makes one screen's stored answers equal `blocks`.
   *
   * Upserts on `(enrolment_id, screen_id, block_index)` and removes blocks the
   * body no longer names, so `PUT` means what `PUT` means. Returns the blocks
   * written and the blocks removed.
   */
  replaceScreenAnswers(
    ctx: StoreContext,
    enrolmentId: string,
    screenId: string,
    blocks: readonly BlockAnswer[],
  ): Promise<{ written: number; removed: number }>;

  /**
   * As above but additive: blocks absent from `blocks` are left alone.
   *
   * `POST /sync` uses this. An offline client sends the screens it has, and a
   * screen answered on another device and not yet pulled down must not be
   * deleted by a sync from this one.
   */
  mergeScreenAnswers(
    ctx: StoreContext,
    enrolmentId: string,
    screenId: string,
    blocks: readonly BlockAnswer[],
  ): Promise<{ written: number }>;

  lapses(ctx: StoreContext, enrolmentId: string): Promise<LapseRow[]>;

  /**
   * Appends a lapse, or returns the identical one already recorded.
   *
   * Append-only: `record.lapse_event` carries a rule blocking `UPDATE`, and
   * there is deliberately no method on this interface that edits or removes
   * one, and none that returns a counter a lapse could decrement.
   */
  appendLapse(
    ctx: StoreContext,
    enrolmentId: string,
    input: LapseInput,
  ): Promise<Appended<LapseRow>>;

  observations(ctx: StoreContext, enrolmentId: string): Promise<ObservationRow[]>;

  appendObservation(
    ctx: StoreContext,
    enrolmentId: string,
    input: ObservationInput,
  ): Promise<Appended<ObservationRow>>;

  /** Live consents across the caller's enrolments, for the export. */
  liveConsents(ctx: StoreContext): Promise<ConsentRow[]>;

  /** Area display names, for the export. Non-PHI, from the catalogue. */
  areaNames(ctx: StoreContext, areaIds: readonly string[]): Promise<Map<string, string>>;

  /**
   * Serialises concurrent `POST /sync` calls carrying the same key.
   *
   * Without it two copies of one batch can each find no receipt and each apply
   * it. Transaction-scoped, so it is released by the commit or the rollback and
   * cannot be leaked by a handler that throws.
   */
  lockSyncBatch(ctx: StoreContext, idempotencyKey: string): Promise<void>;

  /** A receipt for a batch already applied, or null. */
  findSyncReceipt(
    ctx: StoreContext,
    idempotencyKey: string,
  ): Promise<SyncReceipt | null>;

  /**
   * Erases the caller's record, and proves it.
   *
   * Returns what was removed, and must only return once nothing is left: an
   * implementation that counts rows before deleting them and reports the count
   * has proved nothing. `hard_delete_action`, and no soft delete.
   */
  deleteEverything(ctx: StoreContext): Promise<DeletionCounts>;
}
