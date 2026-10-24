import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conditionCreateSchema,
  medicationCreateSchema,
  profilePatchSchema,
  vitalEntrySchema,
} from '../src/schema.ts';

/**
 * Two properties, and they pull in opposite directions:
 *
 *   - the shipped Flutter app's JSON must be accepted exactly as it is sent,
 *   - and nothing in a request body may name its own owner.
 *
 * The second is the defect being fixed. `ConditionCreate` and
 * `MedicationCreate` in the FastAPI backend both take `profile_id` from the
 * body; these schemas take it from nowhere.
 */

void test('a VitalEntry.toJson() payload is accepted whole', () => {
  // Copied from `lib/models/vital_entry.dart` — `ApiService.pushVital` posts
  // this object unmodified.
  const payload = {
    id: 'local-uuid-from-the-app',
    conditionId: '3f1e6b0e-0e39-4f0f-b8d5-2e6f8a2f4f11',
    metricKey: 'blood_glucose',
    label: 'Blood Glucose',
    value: 112.0,
    unit: 'mg/dL',
    timestamp: '2026-09-14T08:15:00.000Z',
    note: 'before breakfast',
  };

  const result = vitalEntrySchema.safeParse(payload);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.equal(result.data?.metricKey, 'blood_glucose');
  assert.equal(result.data?.value, 112);
  assert.equal(result.data?.timestamp instanceof Date, true);
});

void test('a vital with no label, unit or note still parses', () => {
  const result = vitalEntrySchema.safeParse({ metricKey: 'steps', value: 4312 });
  assert.equal(result.success, true);
  assert.equal(result.data?.label, '');
  assert.equal(result.data?.unit, '');
  assert.equal(result.data?.note, '');
  assert.equal(result.data?.source, 'manual');
});

void test('a Medication.toJson() payload is accepted whole', () => {
  const payload = {
    id: 'local-uuid',
    name: 'Metformin',
    dosage: '500 mg',
    schedule: 'Twice daily',
    times: ['08:00', '20:00'],
    remindersEnabled: true,
    takenToday: false,
    lastTaken: null,
  };

  const result = medicationCreateSchema.safeParse(payload);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  assert.deepEqual(result.data?.times, ['08:00', '20:00']);
});

void test('a reminder time that is not HH:MM is refused', () => {
  // The same rule the database enforces via `chronic.is_time_of_day_list`.
  // Failing here makes it a 400 naming the field instead of a 500 from a CHECK.
  for (const time of ['8:00', '24:00', '08:60', 'morning', '0800']) {
    assert.equal(
      medicationCreateSchema.safeParse({ name: 'x', times: [time] }).success,
      false,
      `expected ${time} to be refused`,
    );
  }
});

void test('no schema accepts an owner from the request body', () => {
  // The FastAPI predecessor's `ConditionCreate` and `MedicationCreate` both
  // take `profile_id` from the body and write it. A body that can name its own
  // owner can name somebody else's.
  const owners = { profileId: 'x', accountId: 'x', userId: 'x', user_id: 'x' };

  assert.equal(
    conditionCreateSchema.safeParse({ kind: 'diabetes', ...owners }).success,
    false,
  );
  assert.equal(
    profilePatchSchema.safeParse({ displayName: 'Alex', ...owners }).success,
    false,
  );

  // The vital and medication schemas are not strict — the app posts extra keys
  // and must keep working — so an owner key is *dropped* rather than refused.
  // What matters is that it never reaches the insert.
  const vital = vitalEntrySchema.safeParse({
    metricKey: 'steps',
    value: 1,
    ...owners,
  });
  assert.equal(vital.success, true);
  for (const key of Object.keys(owners)) {
    assert.equal(key in (vital.data ?? {}), false, `${key} must not survive parsing`);
  }

  const medication = medicationCreateSchema.safeParse({ name: 'x', ...owners });
  assert.equal(medication.success, true);
  for (const key of Object.keys(owners)) {
    assert.equal(
      key in (medication.data ?? {}),
      false,
      `${key} must not survive parsing`,
    );
  }
});

void test('only the five shipped condition kinds are accepted', () => {
  for (const kind of ['diabetes', 'hypertension', 'cholesterol', 'asthma', 'smoking_cessation']) {
    assert.equal(conditionCreateSchema.safeParse({ kind }).success, true, kind);
  }
  assert.equal(conditionCreateSchema.safeParse({ kind: 'copd' }).success, false);
});

void test('a health score outside 0-100 is refused', () => {
  assert.equal(profilePatchSchema.safeParse({ healthScore: 101 }).success, false);
  assert.equal(profilePatchSchema.safeParse({ healthScore: -1 }).success, false);
  assert.equal(profilePatchSchema.safeParse({ healthScore: 100 }).success, true);
});

void test('an empty patch is valid, because a PATCH also creates the profile', () => {
  assert.equal(profilePatchSchema.safeParse({}).success, true);
});
