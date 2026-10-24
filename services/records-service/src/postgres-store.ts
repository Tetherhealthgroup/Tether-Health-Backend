import type { Transaction } from '@tether/core';
import type { BlockAnswer } from './answers.ts';
import type {
  ConsentRow,
  EnrolmentRow,
  LapseRow,
  ObservationInput,
  ObservationRow,
  RecordStore,
  StoredAnswer,
  SyncReceipt,
} from './store.ts';

/**
 * The [RecordStore] against Postgres.
 *
 * Every statement here runs inside a transaction that `db.withPrincipal` has
 * already stamped with `app.account_id`, so RLS is filtering underneath all of
 * it. The explicit `account_id = $n` predicates are not redundant defence for
 * its own sake — they are what makes the intended scope readable at the call
 * site, and what makes a missing `FORCE ROW LEVEL SECURITY` on some future
 * table show up as no rows rather than as everyone's.
 *
 * Nothing in this file reads or writes a counter. `slip_never_resets` is not
 * enforced by a check somewhere; it is enforced by there being no column to
 * decrement and no statement below that would.
 */

/**
 * `timestamptz` arrives as a `Date` from `pg`, `numeric` as a string.
 *
 * Both are worth normalising at the edge rather than at each use: an ISO string
 * is what the Flutter client sends and what `DateTime.tryParse` reads back, and
 * a `numeric` left as a string silently turns `value + 1` into concatenation.
 */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const num = (value: string | number): number =>
  typeof value === 'number' ? value : Number(value);

type EnrolmentRecord = {
  id: string;
  area_id: string;
  status: 'active' | 'paused' | 'ended';
  hidden: boolean;
  joined_on: Date | string;
  ended_at: Date | string | null;
};

type AnswerRecord = {
  screen_id: string;
  block_index: number;
  kind: BlockAnswer['kind'];
  value: unknown;
  answered_at: Date | string;
  updated_at: Date | string;
};

type LapseRecord = {
  id: string;
  occurred_at: Date | string;
  severity: string;
  context: string[];
  recorded_at: Date | string;
  created?: boolean;
};

type ObservationRecord = {
  id: string;
  measure_id: string;
  value_num: string | null;
  value_text: string | null;
  unit: string;
  observed_at: Date | string;
  recorded_at: Date | string;
  source: ObservationInput['source'];
  platform: ObservationInput['platform'];
  created?: boolean;
};

type ConsentRecord = {
  id: string;
  enrolment_id: string;
  scope: ConsentRow['scope'];
  recipient_kind: ConsentRow['recipientKind'];
  recipient_id: string | null;
};

type CountRecord = { n: string };

const toEnrolment = (row: EnrolmentRecord): EnrolmentRow => ({
  id: row.id,
  areaId: row.area_id,
  status: row.status,
  hidden: row.hidden,
  joinedOn: iso(row.joined_on),
  endedAt: row.ended_at === null ? null : iso(row.ended_at),
});

const toLapse = (row: LapseRecord): LapseRow => ({
  id: row.id,
  occurredAt: iso(row.occurred_at),
  severity: row.severity,
  context: row.context,
  recordedAt: iso(row.recorded_at),
});

const toObservation = (row: ObservationRecord): ObservationRow => ({
  id: row.id,
  measureId: row.measure_id,
  value: row.value_num !== null ? num(row.value_num) : (row.value_text as string),
  unit: row.unit,
  observedAt: iso(row.observed_at),
  recordedAt: iso(row.recorded_at),
  source: row.source,
  platform: row.platform,
});

/**
 * Takes a transaction-scoped advisory lock on an arbitrary string.
 *
 * Used for the two places where this service does check-then-write without a
 * unique constraint to fall back on: the sync replay ledger, and the
 * content-keyed dedup of lapses and observations. `NOT EXISTS` alone is not
 * enough there — two concurrent transactions each read a snapshot in which the
 * other's row does not yet exist, and both insert. `_xact_` because the lock
 * must be released by the commit or the rollback; a session lock leaked by a
 * handler that threw would wedge every later retry of the same batch.
 */
async function lockKey(tx: Transaction, key: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

export function createPostgresStore(): RecordStore {
  return {
    async enrolmentForArea(ctx, areaId) {
      const row = await ctx.tx.one<EnrolmentRecord>(
        `SELECT id, area_id, status, hidden, joined_on, ended_at
           FROM programme.enrolment
          WHERE account_id = $1 AND area_id = $2`,
        [ctx.accountId, areaId],
      );
      return row ? toEnrolment(row) : null;
    },

    async enrolments(ctx) {
      const rows = await ctx.tx.query<EnrolmentRecord>(
        `SELECT id, area_id, status, hidden, joined_on, ended_at
           FROM programme.enrolment
          WHERE account_id = $1
          ORDER BY joined_on, area_id`,
        [ctx.accountId],
      );
      return rows.map(toEnrolment);
    },

    async answers(ctx, enrolmentId) {
      const rows = await ctx.tx.query<AnswerRecord>(
        `SELECT sa.screen_id, sa.block_index, sa.kind, sa.value,
                sa.answered_at, sa.updated_at
           FROM record.screen_answer sa
           JOIN programme.enrolment e ON e.id = sa.enrolment_id
          WHERE sa.enrolment_id = $1 AND e.account_id = $2
          ORDER BY sa.screen_id, sa.block_index`,
        [enrolmentId, ctx.accountId],
      );
      return rows.map(
        (row): StoredAnswer => ({
          screenId: row.screen_id,
          blockIndex: row.block_index,
          kind: row.kind,
          value: row.value as StoredAnswer['value'],
          answeredAt: iso(row.answered_at),
          updatedAt: iso(row.updated_at),
        }),
      );
    },

    async replaceScreenAnswers(ctx, enrolmentId, screenId, blocks) {
      const written = await upsertBlocks(ctx.tx, enrolmentId, screenId, blocks);
      // Blocks the body no longer names are gone from the screen, so they are
      // gone from the record. With an empty array `block_index = ANY('{}')` is
      // false for every row, which clears the screen — the correct reading of
      // `PUT {}`.
      //
      // The enrolment is named as the caller's as well as by id: a DELETE that
      // matches nothing because RLS hid the row reads exactly like one that had
      // nothing to delete, so the predicate is what makes the intent visible.
      const removed = await ctx.tx.query<{ block_index: number }>(
        `DELETE FROM record.screen_answer
           WHERE enrolment_id = $1
             AND screen_id = $2
             AND NOT (block_index = ANY($3::smallint[]))
             AND EXISTS (SELECT 1 FROM programme.enrolment own
                          WHERE own.id = record.screen_answer.enrolment_id
                            AND own.account_id = $4)
         RETURNING block_index`,
        [enrolmentId, screenId, blocks.map((block) => block.blockIndex), ctx.accountId],
      );
      return { written, removed: removed.length };
    },

    async mergeScreenAnswers(ctx, enrolmentId, screenId, blocks) {
      return { written: await upsertBlocks(ctx.tx, enrolmentId, screenId, blocks) };
    },

    async lapses(ctx, enrolmentId) {
      const rows = await ctx.tx.query<LapseRecord>(
        `SELECT l.id, l.occurred_at, l.severity, l.context, l.recorded_at
           FROM record.lapse_event l
           JOIN programme.enrolment e ON e.id = l.enrolment_id
          WHERE l.enrolment_id = $1 AND e.account_id = $2
          ORDER BY l.occurred_at DESC, l.id`,
        [enrolmentId, ctx.accountId],
      );
      return rows.map(toLapse);
    },

    async appendLapse(ctx, enrolmentId, input) {
      const context = [...input.context];
      await lockKey(
        ctx.tx,
        `record.lapse:${enrolmentId}:${input.occurredAt}:${input.severity}:${context.join('')}`,
      );

      // Insert-if-absent against the event's own content. See `sync.ts` for why
      // content is the identity: `record.lapse_event` has no client-supplied id
      // column, and this service does not own the migration that would add one.
      const rows = await ctx.tx.query<LapseRecord>(
        `WITH inserted AS (
           INSERT INTO record.lapse_event (enrolment_id, occurred_at, severity, context)
           SELECT $1::uuid, $2::timestamptz, $3::text, $4::text[]
            WHERE NOT EXISTS (
              SELECT 1 FROM record.lapse_event
               WHERE enrolment_id = $1::uuid
                 AND occurred_at = $2::timestamptz
                 AND severity    = $3::text
                 AND context     = $4::text[])
           RETURNING id, occurred_at, severity, context, recorded_at
         )
         SELECT id, occurred_at, severity, context, recorded_at, true AS created
           FROM inserted
         UNION ALL
         SELECT id, occurred_at, severity, context, recorded_at, false AS created
           FROM record.lapse_event
          WHERE enrolment_id = $1::uuid
            AND occurred_at = $2::timestamptz
            AND severity    = $3::text
            AND context     = $4::text[]
            AND NOT EXISTS (SELECT 1 FROM inserted)
          LIMIT 1`,
        [enrolmentId, input.occurredAt, input.severity, context],
      );

      const row = rows[0];
      if (!row) throw new Error('lapse insert returned no row');
      return { row: toLapse(row), created: row.created === true };
    },

    async observations(ctx, enrolmentId) {
      const rows = await ctx.tx.query<ObservationRecord>(
        `SELECT o.id, o.measure_id, o.value_num, o.value_text, o.unit,
                o.observed_at, o.recorded_at, o.source, o.platform
           FROM record.observation o
           JOIN programme.enrolment e ON e.id = o.enrolment_id
          WHERE o.enrolment_id = $1 AND e.account_id = $2
          ORDER BY o.observed_at DESC, o.id`,
        [enrolmentId, ctx.accountId],
      );
      return rows.map(toObservation);
    },

    async appendObservation(ctx, enrolmentId, input) {
      const valueNum = typeof input.value === 'number' ? input.value : null;
      const valueText = typeof input.value === 'string' ? input.value : null;

      await lockKey(
        ctx.tx,
        `record.observation:${enrolmentId}:${input.measureId}:${input.observedAt}:${String(input.value)}:${input.source}`,
      );

      const rows = await ctx.tx.query<ObservationRecord>(
        `WITH inserted AS (
           INSERT INTO record.observation
             (enrolment_id, measure_id, value_num, value_text, unit,
              observed_at, source, platform)
           SELECT $1::uuid, $2::text, $3::numeric, $4::text, $5::text,
                  $6::timestamptz, $7::text, $8::text
            WHERE NOT EXISTS (
              SELECT 1 FROM record.observation
               WHERE enrolment_id = $1::uuid
                 AND measure_id   = $2::text
                 AND value_num  IS NOT DISTINCT FROM $3::numeric
                 AND value_text IS NOT DISTINCT FROM $4::text
                 AND unit         = $5::text
                 AND observed_at  = $6::timestamptz
                 AND source       = $7::text)
           RETURNING id, measure_id, value_num, value_text, unit,
                     observed_at, recorded_at, source, platform
         )
         SELECT id, measure_id, value_num, value_text, unit,
                observed_at, recorded_at, source, platform, true AS created
           FROM inserted
         UNION ALL
         SELECT id, measure_id, value_num, value_text, unit,
                observed_at, recorded_at, source, platform, false AS created
           FROM record.observation
          WHERE enrolment_id = $1::uuid
            AND measure_id   = $2::text
            AND value_num  IS NOT DISTINCT FROM $3::numeric
            AND value_text IS NOT DISTINCT FROM $4::text
            AND unit         = $5::text
            AND observed_at  = $6::timestamptz
            AND source       = $7::text
            AND NOT EXISTS (SELECT 1 FROM inserted)
          LIMIT 1`,
        [
          enrolmentId,
          input.measureId,
          valueNum,
          valueText,
          input.unit,
          input.observedAt,
          input.source,
          input.platform,
        ],
      );

      const row = rows[0];
      if (!row) throw new Error('observation insert returned no row');
      return { row: toObservation(row), created: row.created === true };
    },

    async liveConsents(ctx) {
      const rows = await ctx.tx.query<ConsentRecord>(
        `SELECT c.id, c.enrolment_id, c.scope, c.recipient_kind, c.recipient_id
           FROM programme.sharing_consent c
           JOIN programme.enrolment e ON e.id = c.enrolment_id
          WHERE e.account_id = $1 AND c.revoked_at IS NULL`,
        [ctx.accountId],
      );
      return rows.map(
        (row): ConsentRow => ({
          id: row.id,
          enrolmentId: row.enrolment_id,
          scope: row.scope,
          recipientKind: row.recipient_kind,
          recipientId: row.recipient_id,
        }),
      );
    },

    async areaNames(ctx, areaIds) {
      if (areaIds.length === 0) return new Map();
      // `catalogue.area` is non-PHI and has no RLS; it is read here only to put
      // a human-readable name in the export, which is a disclosure a person
      // reads rather than a machine parses.
      const rows = await ctx.tx.query<{ id: string; name: string }>(
        'SELECT id, name FROM catalogue.area WHERE id = ANY($1::text[])',
        [[...areaIds]],
      );
      return new Map(rows.map((row) => [row.id, row.name]));
    },

    async lockSyncBatch(ctx, idempotencyKey) {
      await lockKey(ctx.tx, `record.sync:${ctx.accountId}:${idempotencyKey}`);
    },

    async findSyncReceipt(ctx, idempotencyKey) {
      // The ledger is `ops.audit_event` itself rather than a table of its own.
      // The receipt and the writes it describes therefore commit together — a
      // batch can never be marked applied without having been applied, which is
      // the failure mode a separate ledger table invites.
      const row = await ctx.tx.one<{ detail: SyncReceipt }>(
        `SELECT detail
           FROM ops.audit_event
          WHERE account_id = $1
            AND action = 'record.sync'
            AND resource_type = 'sync_batch'
            AND resource_id = $2
          ORDER BY id DESC
          LIMIT 1`,
        [ctx.accountId, idempotencyKey],
      );
      return row ? row.detail : null;
    },

    async deleteEverything(ctx) {
      // The enrolment ids are captured first because they are the handle on
      // every PHI row, and after the delete there is nothing left to derive
      // them from — which is also what makes the verification below possible.
      const enrolments = await ctx.tx.query<{ id: string }>(
        'SELECT id FROM programme.enrolment WHERE account_id = $1',
        [ctx.accountId],
      );
      const ids = enrolments.map((row) => row.id);

      if (ids.length === 0) {
        return { enrolments: 0, answers: 0, lapses: 0, observations: 0, consents: 0 };
      }

      const deleteFrom = async (table: string): Promise<number> => {
        const rows = await ctx.tx.query<{ id: string }>(
          `DELETE FROM ${table} WHERE enrolment_id = ANY($1::uuid[]) RETURNING id`,
          [ids],
        );
        return rows.length;
      };

      // Children before parents. `ON DELETE CASCADE` would do this, but doing it
      // explicitly is what produces the counts that go in the audit row — a
      // cascade deletes silently and reports one number.
      const observations = await deleteFrom('record.observation');
      const lapses = await deleteFrom('record.lapse_event');
      const answers = await deleteFrom('record.screen_answer');
      const consents = await deleteFrom('programme.sharing_consent');

      const removedEnrolments = await ctx.tx.query<{ id: string }>(
        'DELETE FROM programme.enrolment WHERE account_id = $1 RETURNING id',
        [ctx.accountId],
      );

      // The proof. `PRODUCTION_RELEASE_CHECKLIST.md` asks for deletion "with
      // auditable completion", and a count of rows deleted is not that — it says
      // what was removed, not what is left. This says what is left, against the
      // ids captured before any of it ran, and the transaction only commits if
      // the answer is nothing.
      const remaining = await ctx.tx.one<CountRecord>(
        `SELECT (
             (SELECT count(*) FROM record.observation   WHERE enrolment_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM record.lapse_event   WHERE enrolment_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM record.screen_answer WHERE enrolment_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM programme.sharing_consent WHERE enrolment_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM programme.enrolment  WHERE account_id = $2)
         )::text AS n`,
        [ids, ctx.accountId],
      );

      if (!remaining || Number(remaining.n) !== 0) {
        throw new Error(
          `deletion left ${remaining?.n ?? 'an unknown number of'} rows; rolling back`,
        );
      }

      return {
        enrolments: removedEnrolments.length,
        answers,
        lapses,
        observations,
        consents,
      };
    },
  };
}

/**
 * Upserts a screen's blocks in one statement.
 *
 * `jsonb_to_recordset` rather than a loop or a built `VALUES` list: one round
 * trip, and no string interpolation anywhere near a value out of the record.
 * The conflict target is the schema's own `(enrolment_id, screen_id,
 * block_index)` — the key that makes the Flutter app's cross-programme answer
 * collision unrepresentable here, because the enrolment is part of it.
 */
async function upsertBlocks(
  tx: Transaction,
  enrolmentId: string,
  screenId: string,
  blocks: readonly BlockAnswer[],
): Promise<number> {
  if (blocks.length === 0) return 0;

  const payload = blocks.map((block) => ({
    block_index: block.blockIndex,
    kind: block.kind,
    value: block.value,
  }));

  const rows = await tx.query<{ block_index: number }>(
    `INSERT INTO record.screen_answer (enrolment_id, screen_id, block_index, kind, value)
     SELECT $1::uuid, $2::text, b.block_index, b.kind, b.value
       FROM jsonb_to_recordset($3::jsonb)
            AS b(block_index smallint, kind text, value jsonb)
     ON CONFLICT (enrolment_id, screen_id, block_index)
     DO UPDATE SET kind = EXCLUDED.kind, value = EXCLUDED.value
     RETURNING block_index`,
    [enrolmentId, screenId, JSON.stringify(payload)],
  );

  return rows.length;
}
