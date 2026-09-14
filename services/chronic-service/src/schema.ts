import { z } from 'zod';

/**
 * The wire shapes, taken from the Flutter app rather than invented.
 *
 * `chronic-care/lib/models/` is the contract: `VitalEntry`, `Medication` and
 * `Condition`. Their `toJson`/`fromJson` pairs use the Dart field names
 * verbatim, so every key here is camelCase — `conditionId`, `metricKey`,
 * `remindersEnabled`, `lastTaken`. A snake_case API would have meant a mapping
 * layer in the app, and the app is the thing that already exists.
 *
 * ---------------------------------------------------------------------------
 * The one field that is refused rather than ignored
 * ---------------------------------------------------------------------------
 *
 * Nothing here accepts a `profileId`, an `accountId`, or a `userId`. Ownership
 * comes from the verified token and from nowhere else.
 *
 * That is the shape of the defect this service replaces. The FastAPI backend at
 * `chronic-care/backend/` takes `user_id: str = Depends(get_current_user_id)`
 * on seventeen routes and uses it on three; `ConditionCreate` and
 * `MedicationCreate` both take a `profile_id` straight from the request body
 * and write it. A body that can name its own owner is a body that can name
 * somebody else's, and no amount of checking it afterwards is as good as not
 * having the field.
 *
 * `id` and `conditionId` *are* accepted on a vital, because the shipped app
 * posts `entry.toJson()` whole. See `vitalEntrySchema`.
 */

/** The five modules in `Condition.all`. A sixth is a migration, not a string. */
export const CONDITION_KINDS = [
  'diabetes',
  'hypertension',
  'cholesterol',
  'asthma',
  'smoking_cessation',
] as const;

/** Mirrors `ConditionStatus` in the FastAPI models, and the CHECK in 0007. */
export const CONDITION_STATUSES = [
  'controlled',
  'elevated',
  'borderline',
  'high',
  'in_progress',
  'uncontrolled',
  'unknown',
] as const;

const timeOfDay = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Reminder times look like "08:00".');

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * Every field optional: this is a PATCH, and it is also the only way a profile
 * comes into existence (see `upsertProfile`). An empty body is a valid request
 * that creates the row with the app's own defaults.
 */
export const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),

    // Emoji are multi-byte; 8 characters is what the predecessor's column
    // allowed and is enough for a flag or a skin-toned hand.
    avatarEmoji: z.string().trim().min(1).max(8).optional(),

    // `null` clears it. `undefined` leaves it alone. Those are different
    // requests and a single optional field cannot express both, so the union
    // is deliberate rather than sloppy.
    dob: z.coerce.date().nullable().optional(),

    healthScore: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();

export type ProfilePatch = z.infer<typeof profilePatchSchema>;

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

export const conditionCreateSchema = z
  .object({
    kind: z.enum(CONDITION_KINDS),
    status: z.enum(CONDITION_STATUSES).default('unknown'),
    goalValue: z.coerce.number().finite().nullable().optional(),
    goalUnit: z.string().trim().max(16).nullable().optional(),
    diagnosedAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export type ConditionCreate = z.infer<typeof conditionCreateSchema>;

// ---------------------------------------------------------------------------
// Vital entry
// ---------------------------------------------------------------------------

/**
 * `VitalEntry.toJson()`, accepted as the app actually sends it.
 *
 * Not `.strict()`, and `id` and `conditionId` are tolerated, because
 * `ApiService.pushVital` posts the whole entry:
 *
 *     Future<VitalEntry> pushVital(VitalEntry entry) async {
 *       await _post('vitals', entry.toJson());
 *
 * Refusing the keys it already sends would mean the endpoint could not be
 * adopted without an App Store release, and the app is offline-first — a 400
 * here is a silently dropped reading that the local store still shows.
 *
 * `id` is read and discarded: the server mints its own. A client-chosen primary
 * key in a shared table is a collision between two people's data waiting for
 * two people to generate the same one.
 *
 * `conditionId`, if present, must agree with the path. Disagreement is not a
 * case to resolve by preferring one — it means the client believes something
 * about where this reading belongs that is not what it asked for, and guessing
 * would file a blood-glucose reading under asthma.
 */
export const vitalEntrySchema = z.object({
  id: z.string().optional(),
  conditionId: z.string().optional(),

  metricKey: z.string().trim().min(1).max(64),

  // The wording the person saw on the log sheet. Defaulted rather than
  // required: an older client build may not send it, and a reading without a
  // label is still a reading.
  label: z.string().trim().max(128).default(''),

  // Dart sends a `double`. `coerce` accepts the string a form might produce
  // too, which costs nothing and avoids a 400 on "120" vs 120.
  value: z.coerce.number().finite(),

  unit: z.string().trim().max(16).default(''),

  // `VitalEntry.timestamp` — when the reading happened, not when it arrived.
  timestamp: z.coerce.date().optional(),

  // The person's own words. Redacted from logs by `@tether/core` as `*.note`.
  note: z.string().max(2_000).default(''),

  source: z.enum(['manual', 'healthkit', 'healthconnect']).default('manual'),
});

export type VitalEntryInput = z.infer<typeof vitalEntrySchema>;

// ---------------------------------------------------------------------------
// Medication
// ---------------------------------------------------------------------------

/**
 * `Medication.toJson()`, again as sent.
 *
 * `takenToday` is accepted and not stored. `0007_chronic.sql` has no column for
 * it — it is `last_taken_at` falling on today, computed at read time, for the
 * same reason a lapse is an event and not a counter. What the field does do is
 * carry information from an offline client: `takenToday: true` with no
 * `lastTaken` means the dose was taken and the app did not record when, so the
 * server stamps it now rather than discarding the fact.
 */
export const medicationCreateSchema = z.object({
  id: z.string().optional(),

  name: z.string().trim().min(1).max(128),
  dosage: z.string().trim().max(64).default(''),

  // "Once daily", not a cron expression. The app stores the words the person
  // picked, and parsing them into a schedule here would invent precision the
  // input does not have.
  schedule: z.string().trim().max(64).default(''),

  times: z.array(timeOfDay).max(12).default([]),
  remindersEnabled: z.boolean().default(true),

  takenToday: z.boolean().default(false),
  lastTaken: z.coerce.date().nullable().optional(),

  conditionId: z.string().uuid().nullable().optional(),
  active: z.boolean().default(true),
});

export type MedicationInput = z.infer<typeof medicationCreateSchema>;

/** Path parameters are uuids or they are 404s, never a 500 from the driver. */
export const uuidParam = z.string().uuid();
