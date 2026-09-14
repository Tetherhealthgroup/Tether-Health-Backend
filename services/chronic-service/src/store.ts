import type { Transaction } from '@tether/core';
import type {
  ConditionCreate,
  MedicationInput,
  ProfilePatch,
  VitalEntryInput,
} from './schema.ts';

/**
 * Every statement this service runs, and the row-to-JSON mapping the Flutter
 * app expects back.
 *
 * Two rules hold throughout and neither is optional:
 *
 * 1. **No query names an account except through `app_account_id()`.** Each of
 *    these runs inside `db.withPrincipal(accountId)`, and the policies in
 *    `0007_chronic.sql` do the filtering. The `WHERE` clauses below are the
 *    second line, not the first — which is the difference between this and the
 *    FastAPI service, where the only line was a `WHERE` that was not written.
 *
 * 2. **`numeric` is converted explicitly.** `pg` returns `numeric` as a string,
 *    because a JavaScript number cannot represent every value the type can
 *    hold. `VitalEntry.fromJson` does `(json['value'] as num).toDouble()` and
 *    throws on a string, so a missing `Number()` here is a crash in the app
 *    rather than a wrong number — which is at least the better failure, but it
 *    is still one.
 */

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

type ProfileRow = {
  id: string;
  display_name: string;
  avatar_emoji: string;
  dob: string | null;
  health_score: number;
  created_at: Date;
  updated_at: Date;
};

export interface ProfileJson {
  readonly id: string;
  readonly displayName: string;
  readonly avatarEmoji: string;
  readonly dob: string | null;
  readonly healthScore: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `dob::text`, not `dob`.
 *
 * `pg` parses a `date` into a JavaScript `Date` at local midnight, so a row
 * holding 1985-03-04 comes back as 1985-03-03T23:00:00Z west of UTC and the
 * app shows the wrong birthday for half the world. A date of birth has no time
 * and no zone; the only faithful representation of it in JSON is the string.
 */
const PROFILE_COLUMNS = `
  id, display_name, avatar_emoji, dob::text AS dob,
  health_score, created_at, updated_at
`;

function toProfileJson(row: ProfileRow): ProfileJson {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarEmoji: row.avatar_emoji,
    dob: row.dob,
    healthScore: Number(row.health_score),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The caller's profile, or null.
 *
 * Note the absence of an `ORDER BY`. The predecessor's
 * `select(Profile).order_by(Profile.created_at.asc()).limit(1)` needed one
 * because it had no way to say *whose* profile it wanted. `account_id` is
 * UNIQUE here, so there is exactly one row that could match and nothing to
 * order. `tx.one` throws rather than returning the first of several, which is
 * how a future duplicate would be found instead of silently preferred.
 */
export async function getProfile(
  tx: Transaction,
  accountId: string,
): Promise<ProfileJson | null> {
  const row = await tx.one<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM chronic.profile WHERE account_id = $1`,
    [accountId],
  );
  return row ? toProfileJson(row) : null;
}

/**
 * Creates the profile if it is not there, and returns its id.
 *
 * Writes auto-provision. The app has no "create my profile" screen — it is
 * offline-first and a profile is simply the container its conditions hang off —
 * so requiring an explicit create would mean every first write failing once
 * before succeeding, and a client that has to know to retry.
 *
 * Reads deliberately do not auto-provision. `GET /profile` on a new account
 * returns 404, because inserting a row to answer a GET makes a read a write and
 * makes "has this person used chronic-care?" unanswerable.
 */
export async function ensureProfileId(
  tx: Transaction,
  accountId: string,
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `
    WITH created AS (
      INSERT INTO chronic.profile (account_id) VALUES ($1)
      ON CONFLICT (account_id) DO NOTHING
      RETURNING id
    )
    SELECT id FROM created
    UNION ALL
    SELECT id FROM chronic.profile WHERE account_id = $1
    LIMIT 1
    `,
    [accountId],
  );

  const row = rows[0];
  if (!row) {
    // Unreachable unless RLS rejected the insert, which would mean the
    // transaction's principal is not the account we were handed — a bug worth
    // an error rather than a silent empty response.
    throw new Error('could not resolve a chronic profile for the principal');
  }
  return row.id;
}

/**
 * Applies a patch, creating the row if this is the first write.
 *
 * `COALESCE($n, column)` per field: an omitted key leaves the value alone. `dob`
 * cannot use that trick — `null` means "clear it" there, which COALESCE cannot
 * distinguish from "not supplied" — so it carries an explicit
 * "was this key present?" flag alongside the value.
 */
export async function upsertProfile(
  tx: Transaction,
  accountId: string,
  patch: ProfilePatch,
): Promise<ProfileJson> {
  await ensureProfileId(tx, accountId);

  const dobSupplied = Object.prototype.hasOwnProperty.call(patch, 'dob');

  const row = await tx.one<ProfileRow>(
    `
    UPDATE chronic.profile
       SET display_name = COALESCE($2::text, display_name),
           avatar_emoji = COALESCE($3::text, avatar_emoji),
           dob          = CASE WHEN $4::boolean THEN $5::date ELSE dob END,
           health_score = COALESCE($6::smallint, health_score)
     WHERE account_id = $1
    RETURNING ${PROFILE_COLUMNS}
    `,
    [
      accountId,
      patch.displayName ?? null,
      patch.avatarEmoji ?? null,
      dobSupplied,
      patch.dob ? toDateOnly(patch.dob) : null,
      patch.healthScore ?? null,
    ],
  );

  if (!row) throw new Error('profile update matched no row');
  return toProfileJson(row);
}

/** YYYY-MM-DD in UTC. See `PROFILE_COLUMNS` for why a date is never a Date. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

type ConditionRow = {
  id: string;
  kind: string;
  status: string;
  goal_value: string | null;
  goal_unit: string | null;
  diagnosed_at: string | null;
  created_at: Date;
};

export interface ConditionJson {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly goalValue: number | null;
  readonly goalUnit: string | null;
  readonly diagnosedAt: string | null;
  readonly createdAt: string;
}

const CONDITION_COLUMNS = `
  id, kind, status, goal_value, goal_unit,
  diagnosed_at::text AS diagnosed_at, created_at
`;

function toConditionJson(row: ConditionRow): ConditionJson {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    goalValue: row.goal_value === null ? null : Number(row.goal_value),
    goalUnit: row.goal_unit,
    diagnosedAt: row.diagnosed_at,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listConditions(
  tx: Transaction,
  accountId: string,
): Promise<ConditionJson[]> {
  const rows = await tx.query<ConditionRow>(
    `SELECT ${CONDITION_COLUMNS}
       FROM chronic.condition c
      WHERE c.profile_id = (SELECT id FROM chronic.profile WHERE account_id = $1)
      ORDER BY c.created_at`,
    [accountId],
  );
  return rows.map(toConditionJson);
}

/**
 * Adds a condition, or updates the one that is already there.
 *
 * `ON CONFLICT (profile_id, kind)` because the unique constraint in 0007 says
 * one row per module per person, and because the app's Log tab will happily
 * post the same condition twice on a flaky connection. A 409 for that would be
 * a true statement and an unhelpful one — the caller wants the condition to
 * exist, and after this it does.
 */
export async function createCondition(
  tx: Transaction,
  accountId: string,
  input: ConditionCreate,
): Promise<ConditionJson> {
  const profileId = await ensureProfileId(tx, accountId);

  const row = await tx.one<ConditionRow>(
    `
    INSERT INTO chronic.condition
      (profile_id, kind, status, goal_value, goal_unit, diagnosed_at)
    VALUES ($1, $2, $3, $4, $5, $6::date)
    ON CONFLICT (profile_id, kind) DO UPDATE
       SET status       = EXCLUDED.status,
           goal_value   = COALESCE(EXCLUDED.goal_value, chronic.condition.goal_value),
           goal_unit    = COALESCE(EXCLUDED.goal_unit, chronic.condition.goal_unit),
           diagnosed_at = COALESCE(EXCLUDED.diagnosed_at, chronic.condition.diagnosed_at)
    RETURNING ${CONDITION_COLUMNS}
    `,
    [
      profileId,
      input.kind,
      input.status,
      input.goalValue ?? null,
      input.goalUnit ?? null,
      input.diagnosedAt ? toDateOnly(input.diagnosedAt) : null,
    ],
  );

  if (!row) throw new Error('condition upsert returned no row');
  return toConditionJson(row);
}

/**
 * True when the condition exists *and* belongs to the caller.
 *
 * Under RLS those are the same question: a condition belonging to somebody else
 * is not visible on this transaction, so it does not exist as far as this query
 * is concerned. That collapse is the property the whole schema is built for,
 * and it is why the route can answer 404 without ever comparing owners itself.
 */
export async function conditionExists(
  tx: Transaction,
  conditionId: string,
): Promise<boolean> {
  const row = await tx.one<{ id: string }>(
    'SELECT id FROM chronic.condition WHERE id = $1',
    [conditionId],
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

type VitalRow = {
  id: string;
  condition_id: string;
  metric_key: string;
  label: string;
  value: string;
  unit: string;
  note: string;
  observed_at: Date;
};

export interface VitalJson {
  readonly id: string;
  readonly conditionId: string;
  readonly metricKey: string;
  readonly label: string;
  readonly value: number;
  readonly unit: string;
  readonly timestamp: string;
  readonly note: string;
}

/**
 * Exactly the keys `VitalEntry.fromJson` reads, including `timestamp` for the
 * column called `observed_at`. The app is the older of the two and does not get
 * to be renamed by a table.
 */
function toVitalJson(row: VitalRow): VitalJson {
  return {
    id: row.id,
    conditionId: row.condition_id,
    metricKey: row.metric_key,
    label: row.label,
    value: Number(row.value),
    unit: row.unit,
    timestamp: row.observed_at.toISOString(),
    note: row.note,
  };
}

export async function listVitals(
  tx: Transaction,
  conditionId: string,
  limit: number,
): Promise<VitalJson[]> {
  const rows = await tx.query<VitalRow>(
    `SELECT id, condition_id, metric_key, label, value, unit, note, observed_at
       FROM chronic.vital_entry
      WHERE condition_id = $1
      ORDER BY observed_at DESC
      LIMIT $2`,
    [conditionId, limit],
  );
  return rows.map(toVitalJson);
}

export async function createVital(
  tx: Transaction,
  conditionId: string,
  input: VitalEntryInput,
): Promise<VitalJson> {
  const row = await tx.one<VitalRow>(
    `
    INSERT INTO chronic.vital_entry
      (condition_id, metric_key, label, value, unit, note, observed_at, source)
    VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8)
    RETURNING id, condition_id, metric_key, label, value, unit, note, observed_at
    `,
    [
      conditionId,
      input.metricKey,
      input.label,
      input.value,
      input.unit,
      input.note,
      input.timestamp?.toISOString() ?? null,
      input.source,
    ],
  );

  if (!row) throw new Error('vital insert returned no row');
  return toVitalJson(row);
}

// ---------------------------------------------------------------------------
// Medications
// ---------------------------------------------------------------------------

type MedicationRow = {
  id: string;
  condition_id: string | null;
  name: string;
  dosage: string;
  schedule: string;
  times: string[];
  reminders_enabled: boolean;
  last_taken_at: Date | null;
  active: boolean;
  taken_today: boolean;
};

export interface MedicationJson {
  readonly id: string;
  readonly name: string;
  readonly dosage: string;
  readonly schedule: string;
  readonly times: readonly string[];
  readonly remindersEnabled: boolean;
  readonly takenToday: boolean;
  readonly lastTaken: string | null;
  readonly conditionId: string | null;
  readonly active: boolean;
}

/**
 * `taken_today` is computed, never stored.
 *
 * Derived in SQL rather than in TypeScript so that every caller gets the same
 * answer from the same clock. The day boundary is the database's — UTC in every
 * environment this runs in — and the app, which knows the device's timezone,
 * recomputes it from `lastTaken` for display. Two sources of truth would be
 * worse; this way there is one value and one authoritative field it comes from.
 */
const MEDICATION_COLUMNS = `
  id, condition_id, name, dosage, schedule, times,
  reminders_enabled, last_taken_at, active,
  (last_taken_at IS NOT NULL
     AND last_taken_at >= date_trunc('day', now())) AS taken_today
`;

function toMedicationJson(row: MedicationRow): MedicationJson {
  return {
    id: row.id,
    name: row.name,
    dosage: row.dosage,
    schedule: row.schedule,
    times: row.times,
    remindersEnabled: row.reminders_enabled,
    takenToday: row.taken_today,
    lastTaken: row.last_taken_at?.toISOString() ?? null,
    conditionId: row.condition_id,
    active: row.active,
  };
}

export async function listMedications(
  tx: Transaction,
  accountId: string,
): Promise<MedicationJson[]> {
  const rows = await tx.query<MedicationRow>(
    `SELECT ${MEDICATION_COLUMNS}
       FROM chronic.medication
      WHERE profile_id = (SELECT id FROM chronic.profile WHERE account_id = $1)
        AND active
      ORDER BY created_at`,
    [accountId],
  );
  return rows.map(toMedicationJson);
}

/**
 * Adds a medication.
 *
 * `takenToday` with no `lastTaken` becomes `now()`. An offline client that
 * recorded the dose but not the minute is telling us something true, and
 * dropping it would show an untaken dose on a device where the person has
 * already ticked it off.
 */
export async function createMedication(
  tx: Transaction,
  accountId: string,
  input: MedicationInput,
): Promise<MedicationJson> {
  const profileId = await ensureProfileId(tx, accountId);

  const lastTaken =
    input.lastTaken ?? (input.takenToday ? new Date() : null);

  const row = await tx.one<MedicationRow>(
    `
    INSERT INTO chronic.medication
      (profile_id, condition_id, name, dosage, schedule, times,
       reminders_enabled, last_taken_at, active)
    VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8::timestamptz, $9)
    RETURNING ${MEDICATION_COLUMNS}
    `,
    [
      profileId,
      input.conditionId ?? null,
      input.name,
      input.dosage,
      input.schedule,
      input.times,
      input.remindersEnabled,
      lastTaken?.toISOString() ?? null,
      input.active,
    ],
  );

  if (!row) throw new Error('medication insert returned no row');
  return toMedicationJson(row);
}

/**
 * Deletes a medication. Returns whether a row went.
 *
 * A real DELETE, not `active = false`. `export_and_delete`: "Implement verified
 * exports and deletion with auditable completion", and the `active` flag exists
 * for stopping a course, not for hiding a row from the person who asked for it
 * to be gone.
 */
export async function deleteMedication(
  tx: Transaction,
  medicationId: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'DELETE FROM chronic.medication WHERE id = $1 RETURNING id',
    [medicationId],
  );
  return rows.length > 0;
}
