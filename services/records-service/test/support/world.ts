import type { Database, Transaction } from '@tether/core';
import type {
  Appended,
  ConsentRow,
  DeletionCounts,
  EnrolmentRow,
  LapseRow,
  ObservationRow,
  RecordStore,
  StoreContext,
  StoredAnswer,
  SyncReceipt,
} from '../../src/store.ts';

/**
 * An in-memory stand-in for Postgres, honouring the same contract.
 *
 * The rules worth testing in this service — that a re-sent sync batch writes
 * nothing, that a lapse never lowers a number, that a deletion leaves nothing —
 * are properties of [RecordStore] and of the handlers above it, not of any
 * particular SQL. Asserting them against a real database would mean these tests
 * only run where one exists, which in practice means they stop running.
 *
 * What this deliberately reproduces rather than simplifies:
 *
 *  - **RLS.** Every read filters by the account that owns the enrolment, as the
 *    policies in 0003 do. A store method that forgot its scope would pass here
 *    if this did not, and the whole point of `withPrincipal` is that forgetting
 *    returns nothing rather than someone else's rows.
 *  - **The receipt's location.** `findSyncReceipt` reads the audit trail that
 *    `writeAudit` wrote, exactly as the Postgres implementation reads
 *    `ops.audit_event`. Keeping a separate receipt map here would test a
 *    mechanism production does not have.
 *
 * What it does not reproduce, and what therefore is *not* covered by any test
 * in this directory: the SQL itself, the advisory locks, and the concurrency
 * those locks exist for. Those need a database.
 */

export interface AuditRow {
  readonly accountId: string;
  readonly actorRole: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly programmeId: string | null;
  readonly requestId: string | null;
  readonly detail: Record<string, unknown>;
}

interface StoredEnrolment extends EnrolmentRow {
  readonly accountId: string;
}

interface StoredAnswerRow extends StoredAnswer {
  readonly enrolmentId: string;
}

interface StoredLapse extends LapseRow {
  readonly enrolmentId: string;
}

interface StoredObservation extends ObservationRow {
  readonly enrolmentId: string;
}

interface StoredConsent extends ConsentRow {
  revokedAt: string | null;
}

export class World {
  readonly enrolments: StoredEnrolment[] = [];
  readonly answers: StoredAnswerRow[] = [];
  readonly lapses: StoredLapse[] = [];
  readonly observations: StoredObservation[] = [];
  readonly consents: StoredConsent[] = [];
  readonly audit: AuditRow[] = [];
  readonly areaNames = new Map<string, string>();

  private sequence = 0;

  id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  enrol(accountId: string, areaId: string, name = areaId): StoredEnrolment {
    const enrolment: StoredEnrolment = {
      id: this.id('enrolment'),
      accountId,
      areaId,
      status: 'active',
      hidden: false,
      joinedOn: '2026-01-01T00:00:00.000Z',
      endedAt: null,
    };
    this.enrolments.push(enrolment);
    this.areaNames.set(areaId, name);
    return enrolment;
  }

  grant(
    enrolmentId: string,
    scope: ConsentRow['scope'],
    recipientId: string,
    recipientKind: ConsentRow['recipientKind'] = 'care_team',
  ): StoredConsent {
    const consent: StoredConsent = {
      id: this.id('consent'),
      enrolmentId,
      scope,
      recipientKind,
      recipientId,
      revokedAt: null,
    };
    this.consents.push(consent);
    return consent;
  }

  /** Enrolments this account may see, which is the RLS predicate spelled out. */
  ownedBy(accountId: string): StoredEnrolment[] {
    return this.enrolments.filter((row) => row.accountId === accountId);
  }

  owns(accountId: string, enrolmentId: string): boolean {
    return this.ownedBy(accountId).some((row) => row.id === enrolmentId);
  }
}

/**
 * A [Transaction] that understands exactly one statement: the audit insert.
 *
 * Everything else this service does goes through the store, so a transaction
 * that answered general SQL would be a second, weaker implementation of the
 * same thing. The audit insert is the exception because `writeAudit` writes it
 * directly, and a test that could not see audit rows could not check that a
 * deletion is recorded before it happens.
 */
function memoryTransaction(world: World): Transaction {
  return {
    async query(sql: string, params: readonly unknown[] = []) {
      if (sql.includes('ops.audit_event')) {
        world.audit.push({
          accountId: params[0] as string,
          actorRole: params[1] as string,
          action: params[2] as string,
          resourceType: params[3] as string,
          resourceId: (params[4] as string | null) ?? null,
          programmeId: (params[5] as string | null) ?? null,
          requestId: (params[6] as string | null) ?? null,
          detail: JSON.parse(params[9] as string) as Record<string, unknown>,
        });
        return [];
      }
      throw new Error(`memoryTransaction saw unexpected SQL: ${sql.slice(0, 80)}`);
    },
    async one() {
      return null;
    },
  };
}

export function memoryDatabase(world: World): Database {
  const tx = memoryTransaction(world);
  return {
    withPrincipal: (_accountId, fn) => fn(tx),
    withoutPrincipal: (fn) => fn(tx),
    ping: async () => true,
    close: async () => {},
  };
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function memoryStore(world: World, clock: () => string): RecordStore {
  const scoped = (ctx: StoreContext, enrolmentId: string): boolean =>
    world.owns(ctx.accountId, enrolmentId);

  return {
    async enrolmentForArea(ctx, areaId) {
      return world.ownedBy(ctx.accountId).find((row) => row.areaId === areaId) ?? null;
    },

    async enrolments(ctx) {
      return [...world.ownedBy(ctx.accountId)].sort((a, b) =>
        a.joinedOn === b.joinedOn
          ? a.areaId.localeCompare(b.areaId)
          : a.joinedOn.localeCompare(b.joinedOn),
      );
    },

    async answers(ctx, enrolmentId) {
      if (!scoped(ctx, enrolmentId)) return [];
      return world.answers
        .filter((row) => row.enrolmentId === enrolmentId)
        .sort(
          (a, b) =>
            a.screenId.localeCompare(b.screenId) || a.blockIndex - b.blockIndex,
        );
    },

    async replaceScreenAnswers(ctx, enrolmentId, screenId, blocks) {
      if (!scoped(ctx, enrolmentId)) return { written: 0, removed: 0 };
      const written = upsert(world, enrolmentId, screenId, blocks, clock);
      const keep = new Set(blocks.map((block) => block.blockIndex));
      let removed = 0;
      for (let index = world.answers.length - 1; index >= 0; index -= 1) {
        const row = world.answers[index]!;
        if (
          row.enrolmentId === enrolmentId &&
          row.screenId === screenId &&
          !keep.has(row.blockIndex)
        ) {
          world.answers.splice(index, 1);
          removed += 1;
        }
      }
      return { written, removed };
    },

    async mergeScreenAnswers(ctx, enrolmentId, screenId, blocks) {
      if (!scoped(ctx, enrolmentId)) return { written: 0 };
      return { written: upsert(world, enrolmentId, screenId, blocks, clock) };
    },

    async lapses(ctx, enrolmentId) {
      if (!scoped(ctx, enrolmentId)) return [];
      return world.lapses
        .filter((row) => row.enrolmentId === enrolmentId)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    },

    async appendLapse(ctx, enrolmentId, input): Promise<Appended<LapseRow>> {
      if (!scoped(ctx, enrolmentId)) throw new Error('not this account\'s enrolment');
      // The content key, matching the `WHERE NOT EXISTS` guard in the SQL.
      const existing = world.lapses.find(
        (row) =>
          row.enrolmentId === enrolmentId &&
          row.occurredAt === input.occurredAt &&
          row.severity === input.severity &&
          sameStrings(row.context, input.context),
      );
      if (existing) return { row: existing, created: false };

      const row: StoredLapse = {
        id: world.id('lapse'),
        enrolmentId,
        occurredAt: input.occurredAt,
        severity: input.severity,
        context: [...input.context],
        recordedAt: clock(),
      };
      world.lapses.push(row);
      return { row, created: true };
    },

    async observations(ctx, enrolmentId) {
      if (!scoped(ctx, enrolmentId)) return [];
      return world.observations
        .filter((row) => row.enrolmentId === enrolmentId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    },

    async appendObservation(ctx, enrolmentId, input): Promise<Appended<ObservationRow>> {
      if (!scoped(ctx, enrolmentId)) throw new Error('not this account\'s enrolment');
      const existing = world.observations.find(
        (row) =>
          row.enrolmentId === enrolmentId &&
          row.measureId === input.measureId &&
          row.value === input.value &&
          row.unit === input.unit &&
          row.observedAt === input.observedAt &&
          row.source === input.source,
      );
      if (existing) return { row: existing, created: false };

      const row: StoredObservation = {
        id: world.id('observation'),
        enrolmentId,
        measureId: input.measureId,
        value: input.value,
        unit: input.unit,
        observedAt: input.observedAt,
        recordedAt: clock(),
        source: input.source,
        platform: input.platform,
      };
      world.observations.push(row);
      return { row, created: true };
    },

    async liveConsents(ctx) {
      const mine = new Set(world.ownedBy(ctx.accountId).map((row) => row.id));
      return world.consents.filter(
        (row) => row.revokedAt === null && mine.has(row.enrolmentId),
      );
    },

    async areaNames(_ctx, areaIds) {
      return new Map(
        areaIds
          .map((areaId) => [areaId, world.areaNames.get(areaId)] as const)
          .filter((pair): pair is readonly [string, string] => pair[1] !== undefined),
      );
    },

    async lockSyncBatch() {
      // No concurrency in a single-threaded test. The advisory lock is the part
      // of the design this harness cannot exercise; see the note at the top.
    },

    async findSyncReceipt(ctx, idempotencyKey) {
      const row = world.audit.findLast(
        (event) =>
          event.accountId === ctx.accountId &&
          event.action === 'record.sync' &&
          event.resourceType === 'sync_batch' &&
          event.resourceId === idempotencyKey,
      );
      return row ? (row.detail as unknown as SyncReceipt) : null;
    },

    async deleteEverything(ctx): Promise<DeletionCounts> {
      const ids = new Set(world.ownedBy(ctx.accountId).map((row) => row.id));
      const drop = <T extends { enrolmentId: string }>(rows: T[]): number => {
        let removed = 0;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (ids.has(rows[index]!.enrolmentId)) {
            rows.splice(index, 1);
            removed += 1;
          }
        }
        return removed;
      };

      const observations = drop(world.observations);
      const lapses = drop(world.lapses);
      const answers = drop(world.answers);
      const consents = drop(world.consents);

      let enrolments = 0;
      for (let index = world.enrolments.length - 1; index >= 0; index -= 1) {
        if (world.enrolments[index]!.accountId === ctx.accountId) {
          world.enrolments.splice(index, 1);
          enrolments += 1;
        }
      }

      // The same proof the SQL insists on: what is left, not what was removed.
      const remaining =
        world.observations.filter((row) => ids.has(row.enrolmentId)).length +
        world.lapses.filter((row) => ids.has(row.enrolmentId)).length +
        world.answers.filter((row) => ids.has(row.enrolmentId)).length +
        world.consents.filter((row) => ids.has(row.enrolmentId)).length +
        world.enrolments.filter((row) => row.accountId === ctx.accountId).length;
      if (remaining !== 0) throw new Error(`deletion left ${remaining} rows`);

      return { enrolments, answers, lapses, observations, consents };
    },
  };
}

function upsert(
  world: World,
  enrolmentId: string,
  screenId: string,
  blocks: readonly { blockIndex: number; kind: StoredAnswer['kind']; value: StoredAnswer['value'] }[],
  clock: () => string,
): number {
  for (const block of blocks) {
    const index = world.answers.findIndex(
      (row) =>
        row.enrolmentId === enrolmentId &&
        row.screenId === screenId &&
        row.blockIndex === block.blockIndex,
    );
    const row: StoredAnswerRow = {
      enrolmentId,
      screenId,
      blockIndex: block.blockIndex,
      kind: block.kind,
      value: block.value,
      answeredAt: index >= 0 ? world.answers[index]!.answeredAt : clock(),
      updatedAt: clock(),
    };
    if (index >= 0) world.answers[index] = row;
    else world.answers.push(row);
  }
  return blocks.length;
}
