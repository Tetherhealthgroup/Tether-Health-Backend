import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@tether/core';
import type {
  Adherence,
  CareStore,
  ConsentRow,
  ConsentScope,
  EnrolmentSummary,
  EscalationPolicy,
  EscalationRow,
  LapseEventRow,
  MeasureSummary,
  NoteRow,
  SharedProgramme,
  StoreContext,
  TextObservationRow,
} from '../../src/store.ts';

/**
 * An in-memory stand-in for Postgres that also emulates the RLS policies.
 *
 * Emulating the policies is the point rather than an extra. The rules this
 * service is judged on — a revoked consent stops working, a totals-only
 * consent cannot reach a note, one programme cannot reach another — are
 * enforced in two places: the policies in `db/migrations/0005_care.sql` and the
 * scope projection in `view.ts`. A harness that enforced neither would let a
 * test pass on a service that leaked; a harness that enforced only the second
 * would let the migration rot unnoticed.
 *
 * So [memoryStore] resolves the same predicate the policies do — "a live
 * consent naming this principal as `recipient_id`, and `notes` before any free
 * text" — and returns nothing when it does not hold. The two layers then have
 * to fail together for a test to be wrong, which is the same property
 * production has.
 *
 * Not reproduced, and therefore not covered by any test here: the SQL, the
 * aggregate expressions, and the policies themselves as Postgres parses them.
 * Those need a database.
 */

export interface AuditRow {
  readonly accountId: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly programmeId: string | null;
  readonly detail: Record<string, unknown>;
}

interface Enrolment {
  readonly id: string;
  readonly accountId: string;
  readonly areaId: string;
  readonly status: 'active' | 'paused' | 'ended';
  readonly joinedOn: string;
}

interface Consent {
  readonly id: string;
  readonly enrolmentId: string;
  readonly scope: ConsentScope;
  readonly recipientKind: ConsentRow['recipientKind'];
  readonly recipientId: string;
  readonly consentVersion: string;
  readonly grantedAt: string;
  revokedAt: string | null;
}

interface Answer {
  readonly enrolmentId: string;
  readonly screenId: string;
  readonly blockIndex: number;
  readonly kind: 'chips' | 'option' | 'slider' | 'text';
  readonly value: unknown;
  readonly answeredAt: string;
}

interface Lapse {
  readonly enrolmentId: string;
  readonly occurredAt: string;
  readonly severity: string;
  readonly context: string[];
}

interface Observation {
  readonly enrolmentId: string;
  readonly measureId: string;
  readonly valueNum: number | null;
  readonly valueText: string | null;
  readonly unit: string;
  readonly observedAt: string;
  readonly source: MeasureSummary['source'];
  readonly platform: MeasureSummary['platform'];
}

export class World {
  readonly enrolments: Enrolment[] = [];
  readonly consents: Consent[] = [];
  readonly answers: Answer[] = [];
  readonly lapses: Lapse[] = [];
  readonly observations: Observation[] = [];
  readonly policies: EscalationPolicy[] = [];
  readonly escalations: (EscalationRow & { raisedBy: string; consentId: string })[] = [];
  readonly audit: AuditRow[] = [];

  enrol(accountId: string, areaId: string): Enrolment {
    const enrolment: Enrolment = {
      id: randomUUID(),
      accountId,
      areaId,
      status: 'active',
      joinedOn: '2026-01-01T00:00:00.000Z',
    };
    this.enrolments.push(enrolment);
    return enrolment;
  }

  grant(
    enrolmentId: string,
    scope: ConsentScope,
    recipientId: string,
    recipientKind: ConsentRow['recipientKind'] = 'care_team',
  ): Consent {
    const consent: Consent = {
      id: randomUUID(),
      enrolmentId,
      scope,
      recipientKind,
      recipientId,
      consentVersion: '2026-01',
      grantedAt: '2026-01-02T00:00:00.000Z',
      revokedAt: null,
    };
    this.consents.push(consent);
    return consent;
  }

  answer(enrolmentId: string, screenId: string, blockIndex: number, kind: Answer['kind'], value: unknown) {
    this.answers.push({
      enrolmentId,
      screenId,
      blockIndex,
      kind,
      value,
      answeredAt: '2026-04-01T00:00:00.000Z',
    });
  }

  lapse(enrolmentId: string, occurredAt: string, severity: string, context: string[] = []) {
    this.lapses.push({ enrolmentId, occurredAt, severity, context });
  }

  observe(enrolmentId: string, observation: Omit<Observation, 'enrolmentId'>) {
    this.observations.push({ enrolmentId, ...observation });
  }

  policy(areaId: string, overrides: Partial<EscalationPolicy> = {}): EscalationPolicy {
    const policy: EscalationPolicy = {
      areaId,
      version: '2026.1',
      recipientKind: 'care_team',
      contact: 'behavioural-health-rota',
      crisisContact: '988',
      acknowledgeWithinMinutes: 60,
      configuredBy: 'Dr A. Clinical-Lead',
      configuredAt: '2026-01-01T00:00:00.000Z',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      notes: null,
      ...overrides,
    };
    this.policies.push(policy);
    return policy;
  }
}

function memoryTransaction(world: World): Transaction {
  return {
    async query(sql: string, params: readonly unknown[] = []) {
      if (sql.includes('ops.audit_event')) {
        world.audit.push({
          accountId: (params[0] as string | null) ?? null,
          actorRole: params[1] as string,
          action: params[2] as string,
          resourceType: params[3] as string,
          resourceId: (params[4] as string | null) ?? null,
          programmeId: (params[5] as string | null) ?? null,
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

const isoWeek = (at: string): string => {
  // Enough for a bucket label in a test; the real one is `to_char(…, 'IYYY-"W"IW')`.
  const date = new Date(at);
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

export function memoryStore(world: World): CareStore {
  /** The RLS predicate, spelled out: live consents naming this principal. */
  const live = (ctx: StoreContext, enrolmentId: string): Consent[] =>
    world.consents.filter(
      (consent) =>
        consent.enrolmentId === enrolmentId &&
        consent.revokedAt === null &&
        consent.recipientId === ctx.clinicianId,
    );

  const mayReadText = (ctx: StoreContext, enrolmentId: string): boolean =>
    live(ctx, enrolmentId).some((consent) => consent.scope === 'notes');

  const visibleAnswers = (ctx: StoreContext, enrolmentId: string): Answer[] => {
    if (live(ctx, enrolmentId).length === 0) return [];
    const text = mayReadText(ctx, enrolmentId);
    return world.answers.filter(
      (row) => row.enrolmentId === enrolmentId && (text || row.kind !== 'text'),
    );
  };

  const visibleObservations = (ctx: StoreContext, enrolmentId: string): Observation[] => {
    if (live(ctx, enrolmentId).length === 0) return [];
    const text = mayReadText(ctx, enrolmentId);
    return world.observations.filter(
      (row) => row.enrolmentId === enrolmentId && (text || row.valueText === null),
    );
  };

  const visibleLapses = (ctx: StoreContext, enrolmentId: string): Lapse[] =>
    live(ctx, enrolmentId).length === 0
      ? []
      : world.lapses.filter((row) => row.enrolmentId === enrolmentId);

  const asConsent = (consent: Consent): ConsentRow => ({
    id: consent.id,
    enrolmentId: consent.enrolmentId,
    scope: consent.scope,
    recipientKind: consent.recipientKind,
    consentVersion: consent.consentVersion,
    grantedAt: consent.grantedAt,
  });

  return {
    async sharedProgrammes(ctx) {
      const shared = new Map<string, SharedProgramme & { consents: ConsentRow[] }>();
      for (const consent of world.consents) {
        if (consent.revokedAt !== null) continue;
        if (consent.recipientId !== ctx.clinicianId) continue;
        const enrolment = world.enrolments.find((row) => row.id === consent.enrolmentId);
        if (!enrolment) continue;
        let entry = shared.get(enrolment.id);
        if (!entry) {
          entry = {
            enrolmentId: enrolment.id,
            areaId: enrolment.areaId,
            status: enrolment.status,
            joinedOn: enrolment.joinedOn,
            consents: [],
          };
          shared.set(enrolment.id, entry);
        }
        entry.consents.push(asConsent(consent));
      }
      return [...shared.values()].sort((a, b) => a.areaId.localeCompare(b.areaId));
    },

    async liveConsentsFor(ctx, enrolmentId) {
      return live(ctx, enrolmentId).map(asConsent);
    },

    async enrolment(ctx, enrolmentId): Promise<EnrolmentSummary | null> {
      // The `enrolment_consented_recipient` policy: reachable only through a
      // live consent, and through nothing else.
      if (live(ctx, enrolmentId).length === 0) return null;
      const row = world.enrolments.find((entry) => entry.id === enrolmentId);
      return row
        ? {
            enrolmentId: row.id,
            areaId: row.areaId,
            status: row.status,
            joinedOn: row.joinedOn,
            subjectAccountId: row.accountId,
          }
        : null;
    },

    async adherence(ctx, enrolmentId, asOf): Promise<Adherence> {
      const answers = visibleAnswers(ctx, enrolmentId);
      const lapses = visibleLapses(ctx, enrolmentId);
      const observations = visibleObservations(ctx, enrolmentId);
      const enrolment = world.enrolments.find((row) => row.id === enrolmentId);

      const byWeek = new Map<string, number>();
      for (const lapse of lapses) {
        const week = isoWeek(lapse.occurredAt);
        byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
      }

      const occurred = lapses.map((row) => row.occurredAt).sort();
      const observed = observations.map((row) => row.observedAt).sort();

      return {
        programmeDays: enrolment
          ? Math.max(
              0,
              Math.floor(
                (asOf.getTime() - new Date(enrolment.joinedOn).getTime()) / 86_400_000,
              ),
            )
          : 0,
        screensAnswered: new Set(answers.map((row) => row.screenId)).size,
        blocksAnswered: answers.length,
        lapses: {
          recorded: lapses.length,
          firstAt: occurred[0] ?? null,
          lastAt: occurred.at(-1) ?? null,
          byWeek: [...byWeek.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([week, recorded]) => ({ week, recorded })),
        },
        observations: {
          recorded: observations.length,
          lastAt: observed.at(-1) ?? null,
        },
      };
    },

    async measureSummaries(ctx, enrolmentId) {
      const numeric = visibleObservations(ctx, enrolmentId).filter(
        (row) => row.valueNum !== null,
      );
      const groups = new Map<string, Observation[]>();
      for (const row of numeric) {
        const key = `${row.measureId}|${row.unit}|${row.source}|${row.platform}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
      }

      return [...groups.values()]
        .map((rows): MeasureSummary => {
          const sorted = [...rows].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
          const values = sorted.map((row) => row.valueNum as number);
          const byWeek = new Map<string, number[]>();
          for (const row of sorted) {
            const week = isoWeek(row.observedAt);
            const bucket = byWeek.get(week);
            if (bucket) bucket.push(row.valueNum as number);
            else byWeek.set(week, [row.valueNum as number]);
          }
          const first = sorted[0]!;
          const latest = sorted.at(-1)!;
          return {
            measureId: first.measureId,
            unit: first.unit,
            source: first.source,
            platform: first.platform,
            recorded: sorted.length,
            min: Math.min(...values),
            max: Math.max(...values),
            firstAt: first.observedAt,
            latestAt: latest.observedAt,
            latestValue: latest.valueNum,
            byWeek: [...byWeek.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([week, weekValues]) => ({
                week,
                recorded: weekValues.length,
                min: Math.min(...weekValues),
                max: Math.max(...weekValues),
              })),
          };
        })
        .sort((a, b) => a.measureId.localeCompare(b.measureId));
    },

    async notes(ctx, enrolmentId): Promise<NoteRow[]> {
      // Returns nothing without `notes`, exactly as the policy does — so a
      // handler that called this under the wrong scope would still leak
      // nothing, which is the arrangement production has.
      if (!mayReadText(ctx, enrolmentId)) return [];
      return world.answers
        .filter((row) => row.enrolmentId === enrolmentId && row.kind === 'text')
        .map((row) => ({
          screenId: row.screenId,
          blockIndex: row.blockIndex,
          text: String(row.value),
          answeredAt: row.answeredAt,
        }));
    },

    async lapseEvents(ctx, enrolmentId): Promise<LapseEventRow[]> {
      return visibleLapses(ctx, enrolmentId)
        .map((row) => ({
          occurredAt: row.occurredAt,
          severity: row.severity,
          context: row.context,
        }))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    },

    async textObservations(ctx, enrolmentId): Promise<TextObservationRow[]> {
      if (!mayReadText(ctx, enrolmentId)) return [];
      return world.observations
        .filter((row) => row.enrolmentId === enrolmentId && row.valueText !== null)
        .map((row) => ({
          measureId: row.measureId,
          text: row.valueText as string,
          unit: row.unit,
          observedAt: row.observedAt,
          source: row.source,
          platform: row.platform,
        }));
    },

    async escalationPolicy(_ctx, areaId) {
      return world.policies.find((policy) => policy.areaId === areaId) ?? null;
    },

    async raiseEscalation(ctx, input) {
      const row = {
        id: randomUUID(),
        enrolmentId: input.enrolmentId,
        signal: input.signal,
        detail: input.detail,
        policyAreaId: input.policy.areaId,
        policyVersion: input.policy.version,
        routedToKind: input.policy.recipientKind,
        routedTo: input.policy.contact,
        raisedAt: '2026-06-01T12:00:00.000Z',
        acknowledgeBy: new Date(
          Date.parse('2026-06-01T12:00:00.000Z') +
            input.policy.acknowledgeWithinMinutes * 60_000,
        ).toISOString(),
        acknowledgedAt: null,
        raisedBy: ctx.clinicianId,
        consentId: input.consentId,
      };
      world.escalations.push(row);
      return row;
    },

    async escalations(ctx, enrolmentId) {
      if (live(ctx, enrolmentId).length === 0) return [];
      return world.escalations.filter((row) => row.enrolmentId === enrolmentId);
    },
  };
}
