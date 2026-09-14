import type { Transaction } from '@tether/core';
import type {
  Enrolment,
  EnrolmentStatus,
  RecipientKind,
  SharePreviewEntry,
  SharePreviewNote,
  SharePreviewPayload,
  SharePreviewTotal,
  SharingConsent,
  SharingScope,
} from '@tether/contracts';
import { ceilingFromRule, liveConsents, type ActiveProgramme } from './rules.ts';

/**
 * Every query this service runs, and the projection the share preview is built
 * from.
 *
 * All of it goes through a transaction opened by `db.withPrincipal`, so
 * `app.account_id` is set and the RLS policies in
 * `0003_programme_and_record.sql` apply. None of the SQL below carries its own
 * `WHERE account_id = …` for the enrolment table, and that is not an oversight:
 * the policy is the filter, and writing the predicate by hand as well would
 * make a query that forgot it look no different from one that did not.
 *
 * Columns are aliased to their wire names in SQL for the same reason as in the
 * catalogue service — a hand-written mapper is a place a field goes missing.
 */

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface EnrolmentRow {
  id: string;
  areaId: string;
  status: EnrolmentStatus;
  hidden: boolean;
  childProfileId: string | null;
  joinedOn: Date | string;
  endedAt: Date | string | null;
}

interface ConsentRow {
  id: string;
  enrolmentId: string;
  scope: SharingScope;
  recipientKind: RecipientKind;
  recipientId: string | null;
  consentVersion: string;
  consentText: string;
  grantedAt: Date | string;
  revokedAt: Date | string | null;
}

/** See the catalogue service's `instant` — same reasoning, same two inputs. */
function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableInstant(value: Date | string | null): string | null {
  return value === null ? null : instant(value);
}

export function toConsent(row: ConsentRow): SharingConsent {
  return {
    id: row.id,
    enrolmentId: row.enrolmentId,
    scope: row.scope,
    recipientKind: row.recipientKind,
    recipientId: row.recipientId,
    consentVersion: row.consentVersion,
    consentText: row.consentText,
    grantedAt: instant(row.grantedAt),
    revokedAt: nullableInstant(row.revokedAt),
  };
}

export function toEnrolment(
  row: EnrolmentRow,
  consents: readonly SharingConsent[],
): Enrolment {
  return {
    id: row.id,
    areaId: row.areaId,
    status: row.status,
    hidden: row.hidden,
    childProfileId: row.childProfileId,
    joinedOn: instant(row.joinedOn),
    endedAt: nullableInstant(row.endedAt),
    // Filtered here, once, by the single definition of live. See `liveConsents`.
    consents: liveConsents(consents),
  };
}

const ENROLMENT_COLUMNS = `
  id,
  area_id          AS "areaId",
  status,
  hidden,
  child_profile_id AS "childProfileId",
  joined_on        AS "joinedOn",
  ended_at         AS "endedAt"
`;

const CONSENT_COLUMNS = `
  id,
  enrolment_id     AS "enrolmentId",
  scope,
  recipient_kind   AS "recipientKind",
  recipient_id     AS "recipientId",
  consent_version  AS "consentVersion",
  consent_text     AS "consentText",
  granted_at       AS "grantedAt",
  revoked_at       AS "revokedAt"
`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Consents for a set of enrolments — revoked ones included.
 *
 * Deliberately unfiltered. `liveConsents` is the one place a grant is judged
 * live, and it can only be that place if the rows reach it. The volume is a
 * handful of rows per programme, so nothing is paid for the honesty.
 */
async function loadConsentRows(
  tx: Transaction,
  enrolmentIds: readonly string[],
): Promise<SharingConsent[]> {
  if (enrolmentIds.length === 0) return [];
  const rows = await tx.query<ConsentRow>(
    `SELECT ${CONSENT_COLUMNS}
       FROM programme.sharing_consent
      WHERE enrolment_id = ANY($1)
      ORDER BY granted_at, id`,
    [enrolmentIds],
  );
  return rows.map(toConsent);
}

export async function loadEnrolments(tx: Transaction): Promise<Enrolment[]> {
  const rows = await tx.query<EnrolmentRow>(
    `SELECT ${ENROLMENT_COLUMNS} FROM programme.enrolment ORDER BY joined_on, area_id`,
  );
  if (rows.length === 0) return [];

  const consents = await loadConsentRows(
    tx,
    rows.map((row) => row.id),
  );

  return rows.map((row) =>
    toEnrolment(
      row,
      consents.filter((consent) => consent.enrolmentId === row.id),
    ),
  );
}

export async function loadEnrolmentRow(
  tx: Transaction,
  areaId: string,
): Promise<EnrolmentRow | null> {
  return tx.one<EnrolmentRow>(
    `SELECT ${ENROLMENT_COLUMNS} FROM programme.enrolment WHERE area_id = $1`,
    [areaId],
  );
}

export async function loadEnrolment(
  tx: Transaction,
  areaId: string,
): Promise<Enrolment | null> {
  const row = await loadEnrolmentRow(tx, areaId);
  if (!row) return null;
  return toEnrolment(row, await loadConsentRows(tx, [row.id]));
}

/** All consents on one enrolment, revoked included. See [loadConsentRows]. */
export async function loadConsents(
  tx: Transaction,
  enrolmentId: string,
): Promise<SharingConsent[]> {
  return loadConsentRows(tx, [enrolmentId]);
}

export async function loadActiveProgrammes(
  tx: Transaction,
): Promise<ActiveProgramme[]> {
  const rows = await tx.query<{ areaId: string; joinedOn: Date | string }>(
    `SELECT area_id AS "areaId", joined_on AS "joinedOn"
       FROM programme.enrolment
      WHERE status = 'active'
      ORDER BY joined_on`,
  );
  return rows.map((row) => ({
    areaId: row.areaId,
    joinedOn: instant(row.joinedOn),
  }));
}

/**
 * The two-active ceiling, read from the catalogue the trigger reads it from.
 *
 * Cross-schema, and that is the point: `programme.enforce_active_ceiling()`
 * reads `catalogue.shell_rule` too. One source means the API's refusal and the
 * database's backstop can never disagree about the number.
 */
export async function loadActiveCeiling(tx: Transaction): Promise<number> {
  const row = await tx.one<{ rule: string }>(
    `SELECT rule FROM catalogue.shell_rule WHERE id = 'two_active_max'`,
  );
  return ceilingFromRule(row?.rule);
}

export interface AreaFacts {
  readonly id: string;
  readonly name: string;
  readonly productId: string | null;
}

export async function loadArea(
  tx: Transaction,
  areaId: string,
): Promise<AreaFacts | null> {
  return tx.one<AreaFacts>(
    `SELECT id, name, product_id AS "productId" FROM catalogue.area WHERE id = $1`,
    [areaId],
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function insertEnrolment(
  tx: Transaction,
  accountId: string,
  areaId: string,
): Promise<EnrolmentRow> {
  const row = await tx.one<EnrolmentRow>(
    `INSERT INTO programme.enrolment (account_id, area_id, status)
     VALUES ($1, $2, 'active')
     RETURNING ${ENROLMENT_COLUMNS}`,
    [accountId, areaId],
  );
  if (!row) throw new Error('insert returned no row');
  return row;
}

/**
 * Sets a status, and keeps `ended_at` consistent with it.
 *
 * Resuming an ended programme clears `ended_at` rather than leaving a row that
 * is simultaneously active and ended. `joined_on` is deliberately *not* reset:
 * `0003` keeps one enrolment row per account per area precisely so history
 * survives a pause and resume, and rewriting the join date would throw away the
 * thing the row was reused to keep.
 */
export async function setStatus(
  tx: Transaction,
  areaId: string,
  status: EnrolmentStatus,
): Promise<EnrolmentRow | null> {
  return tx.one<EnrolmentRow>(
    `UPDATE programme.enrolment
        SET status   = $2::text,
            ended_at = CASE WHEN $2::text = 'ended' THEN now() ELSE NULL END
      WHERE area_id = $1
      RETURNING ${ENROLMENT_COLUMNS}`,
    [areaId, status],
  );
}

export async function setHidden(
  tx: Transaction,
  areaId: string,
  hidden: boolean,
): Promise<EnrolmentRow | null> {
  return tx.one<EnrolmentRow>(
    `UPDATE programme.enrolment
        SET hidden = $2
      WHERE area_id = $1
      RETURNING ${ENROLMENT_COLUMNS}`,
    [areaId, hidden],
  );
}

export interface GrantInput {
  readonly enrolmentId: string;
  readonly scope: SharingScope;
  readonly recipientKind: RecipientKind;
  readonly recipientId: string | null;
  readonly consentVersion: string;
  readonly consentText: string;
}

/**
 * Revokes any live grant for this (scope, recipient) pair.
 *
 * `IS NOT DISTINCT FROM` rather than `=` on `recipient_id`, because null there
 * means "any recipient of this kind" and `null = null` is null, so an equality
 * test would silently fail to revoke exactly the widest grant a person can
 * make. Returns the ids revoked, which is what the audit row records.
 */
export async function revokeLive(
  tx: Transaction,
  input: {
    readonly enrolmentId: string;
    readonly scope: SharingScope;
    readonly recipientKind: RecipientKind;
    readonly recipientId: string | null;
  },
): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    `UPDATE programme.sharing_consent
        SET revoked_at = now()
      WHERE enrolment_id   = $1
        AND scope          = $2
        AND recipient_kind = $3
        AND recipient_id IS NOT DISTINCT FROM $4
        AND revoked_at IS NULL
      RETURNING id`,
    [input.enrolmentId, input.scope, input.recipientKind, input.recipientId],
  );
  return rows.map((row) => row.id);
}

/**
 * Grants consent, superseding any live grant that carried different wording.
 *
 * Re-granting the identical version is idempotent — a client retrying a request
 * must not produce a second consent row and a second audit event. A *different*
 * version supersedes: the old grant is revoked and a new row is inserted, so
 * the record shows the person agreeing to v2 and the moment v1 stopped
 * applying. Editing the old row in place would erase the fact that they were
 * ever shown v1, which is the half of "consent versioning" that matters when
 * somebody asks what they agreed to.
 */
export async function grantConsent(
  tx: Transaction,
  input: GrantInput,
): Promise<{ consent: SharingConsent; supersededIds: string[]; created: boolean }> {
  const existing = await tx.one<ConsentRow>(
    `SELECT ${CONSENT_COLUMNS}
       FROM programme.sharing_consent
      WHERE enrolment_id   = $1
        AND scope          = $2
        AND recipient_kind = $3
        AND recipient_id IS NOT DISTINCT FROM $4
        AND revoked_at IS NULL`,
    [input.enrolmentId, input.scope, input.recipientKind, input.recipientId],
  );

  if (existing && existing.consentVersion === input.consentVersion) {
    return { consent: toConsent(existing), supersededIds: [], created: false };
  }

  const supersededIds = existing
    ? await revokeLive(tx, {
        enrolmentId: input.enrolmentId,
        scope: input.scope,
        recipientKind: input.recipientKind,
        recipientId: input.recipientId,
      })
    : [];

  const row = await tx.one<ConsentRow>(
    `INSERT INTO programme.sharing_consent
       (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${CONSENT_COLUMNS}`,
    [
      input.enrolmentId,
      input.scope,
      input.recipientKind,
      input.recipientId,
      input.consentVersion,
      input.consentText,
    ],
  );
  if (!row) throw new Error('consent insert returned no row');

  return { consent: toConsent(row), supersededIds, created: true };
}

// ---------------------------------------------------------------------------
// The share preview
// ---------------------------------------------------------------------------

/**
 * Everything a recipient could be shown for one programme, before scoping.
 *
 * Read from `record.*` rather than reconstructed, because the safeguard is
 * `share_preview` — "Readings and history go to a clinician only when the
 * person chooses, **after previewing what is sent**" — and a preview assembled
 * from anything other than the real rows is a mock-up. A mock-up that diverges
 * from what is actually sent is precisely the failure the safeguard names.
 *
 * These tables belong to records-service. Reading them here is a boundary this
 * service would not otherwise cross, and it is crossed knowingly: the rows are
 * the caller's own, the transaction carries the caller's own principal, and RLS
 * returns nothing that is not theirs. No consent boundary is involved, because
 * nobody else's data is touched.
 */
export interface PreviewSource {
  readonly areaId: string;
  readonly areaName: string;
  readonly status: EnrolmentStatus;
  readonly joinedOn: string;
  readonly totals: readonly SharePreviewTotal[];
  readonly answersRecorded: number;
  readonly lapseDates: readonly string[];
  readonly notes: readonly SharePreviewNote[];
}

interface TotalRow {
  measureId: string;
  label: string;
  unit: string;
  count: number;
  firstObservedAt: Date | string | null;
  lastObservedAt: Date | string | null;
  latestNum: string | null;
  latestText: string | null;
}

interface NoteRow {
  screenId: string;
  blockIndex: number;
  value: unknown;
  answeredAt: Date | string;
}

export async function loadPreviewSource(
  tx: Transaction,
  enrolment: EnrolmentRow,
  areaName: string,
): Promise<PreviewSource> {
  const totalRows = await tx.query<TotalRow>(
    `SELECT o.measure_id           AS "measureId",
            m.label,
            o.unit,
            count(*)::int          AS "count",
            min(o.observed_at)     AS "firstObservedAt",
            max(o.observed_at)     AS "lastObservedAt",
            (array_agg(o.value_num  ORDER BY o.observed_at DESC))[1] AS "latestNum",
            (array_agg(o.value_text ORDER BY o.observed_at DESC))[1] AS "latestText"
       FROM record.observation o
       JOIN catalogue.measure m ON m.id = o.measure_id
      WHERE o.enrolment_id = $1
      GROUP BY o.measure_id, m.label, o.unit
      ORDER BY o.measure_id`,
    [enrolment.id],
  );

  const answers = await tx.one<{ count: number }>(
    `SELECT count(*)::int AS count FROM record.screen_answer WHERE enrolment_id = $1`,
    [enrolment.id],
  );

  const lapses = await tx.query<{ occurredAt: Date | string }>(
    `SELECT occurred_at AS "occurredAt"
       FROM record.lapse_event
      WHERE enrolment_id = $1
      ORDER BY occurred_at DESC`,
    [enrolment.id],
  );

  const noteRows = await tx.query<NoteRow>(
    `SELECT screen_id   AS "screenId",
            block_index AS "blockIndex",
            value,
            answered_at AS "answeredAt"
       FROM record.screen_answer
      WHERE enrolment_id = $1 AND kind = 'text'
      ORDER BY answered_at, screen_id, block_index`,
    [enrolment.id],
  );

  return {
    areaId: enrolment.areaId,
    areaName,
    status: enrolment.status,
    joinedOn: instant(enrolment.joinedOn),
    totals: totalRows.map((row) => ({
      measureId: row.measureId,
      label: row.label,
      unit: row.unit,
      count: row.count,
      firstObservedAt: nullableInstant(row.firstObservedAt),
      lastObservedAt: nullableInstant(row.lastObservedAt),
      // `pg` returns `numeric` as a string so it cannot lose precision on the
      // way through a double. Converted here rather than left as a string,
      // because the contract says a number and a clinician comparing "8" with
      // 8 is a bug waiting for a sort order.
      latestValue:
        row.latestNum !== null ? Number(row.latestNum) : row.latestText,
    })),
    answersRecorded: answers?.count ?? 0,
    lapseDates: lapses.map((row) => instant(row.occurredAt)),
    notes: noteRows.map((row) => ({
      screenId: row.screenId,
      blockIndex: row.blockIndex,
      // `record.screen_answer.value` is one jsonb column typed by `kind`; for
      // `kind = 'text'` it holds a JSON string.
      text: typeof row.value === 'string' ? row.value : JSON.stringify(row.value),
      answeredAt: instant(row.answeredAt),
    })),
  };
}

/**
 * Narrows the full picture to what one scope actually discloses.
 *
 * `totals_and_adherence` and `notes` are two different disclosures, not two
 * sizes of one: "A coach seeing a total is a different disclosure from a coach
 * reading a note." Under the smaller scope `notes` is `null` rather than an
 * empty array, because null renders as "this recipient would receive none of
 * your own words" and `[]` renders as "you have not written any" — and only one
 * of those is what the person is being asked to check.
 *
 * Lapse *dates* are adherence; lapse severity and context are the person's
 * account of a slip, and they never leave under the smaller scope.
 */
export function projectShare(
  scope: SharingScope,
  source: PreviewSource,
): SharePreviewPayload {
  return {
    programme: {
      areaId: source.areaId,
      areaName: source.areaName,
      status: source.status,
      joinedOn: source.joinedOn,
    },
    totals: [...source.totals],
    adherence: {
      answersRecorded: source.answersRecorded,
      lapsesRecorded: source.lapseDates.length,
      lapseDates: [...source.lapseDates],
    },
    notes: scope === 'notes' ? [...source.notes] : null,
  };
}

/**
 * Builds the preview entries for one programme.
 *
 * `consents` is the *unfiltered* list, and the filtering happens here through
 * `liveConsents`. That is the whole point of the function: revocation is
 * enforced rather than recorded, so the instant `revoked_at` is set the grant
 * must vanish from this preview, and the only way to be sure of that is for the
 * preview to derive its entries from the same predicate `GET /sharing` uses.
 *
 * `prospective` previews a grant that has not been made — the case the
 * safeguard is actually about, since a person is meant to see what would be
 * sent *before* confirming.
 */
export function previewEntries(input: {
  readonly consents: readonly SharingConsent[];
  readonly prospective:
    | { readonly scope: SharingScope; readonly recipientKind: RecipientKind }
    | null;
  readonly source: PreviewSource;
}): SharePreviewEntry[] {
  const { consents, prospective, source } = input;

  if (prospective) {
    return [
      {
        consentId: null,
        prospective: true,
        scope: prospective.scope,
        recipientKind: prospective.recipientKind,
        recipientId: null,
        payload: projectShare(prospective.scope, source),
      },
    ];
  }

  return liveConsents(consents).map((consent) => ({
    consentId: consent.id,
    prospective: false,
    scope: consent.scope,
    recipientKind: consent.recipientKind,
    recipientId: consent.recipientId,
    payload: projectShare(consent.scope, source),
  }));
}
