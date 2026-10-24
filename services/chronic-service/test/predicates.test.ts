import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertScopedTo,
  recordingTransaction,
} from '../../../packages/core/test/support/recording-tx.ts';
import {
  conditionExists,
  createMedication,
  createVital,
  deleteMedication,
  getProfile,
  listConditions,
  listMedications,
  listVitals,
} from '../src/store.ts';
import { ACCOUNT, CONDITION, answer } from './support/harness.ts';

/**
 * R-032: chronic-service's reads of a condition, its vitals, and the delete of a
 * medication took an id from the request and filtered on nothing else, leaning
 * entirely on the policy. Every statement now reaches the row through the
 * caller's own profile.
 */

const MEDICATION = '55555555-5555-4555-8555-555555555555';

void test('every read of a condition or a reading names the account', async () => {
  const tx = recordingTransaction((s) => answer(s.sql));

  await getProfile(tx, ACCOUNT);
  await listConditions(tx, ACCOUNT);
  await conditionExists(tx, ACCOUNT, CONDITION);
  await listVitals(tx, ACCOUNT, CONDITION, 50);
  await listMedications(tx, ACCOUNT);

  assert.equal(tx.statements.length, 5);
  for (const statement of tx.statements) {
    assertScopedTo(statement, 'account_id', ACCOUNT);
  }
});

void test('a reading is filed only under a condition that belongs to the account', async () => {
  const tx = recordingTransaction((s) => answer(s.sql));

  await createVital(tx, ACCOUNT, CONDITION, {
    metricKey: 'k',
    label: '',
    value: 1,
    unit: '',
    note: '',
    source: 'manual',
  });

  const [insert] = tx.statements;
  assert.ok(insert);
  assertScopedTo(insert, 'p.account_id', ACCOUNT);
  // Inserted from the condition, not `VALUES`, so a condition that is not the
  // caller's produces no row at all.
  assert.match(insert.sql, /SELECT c\.id[\s\S]+FROM chronic\.condition c/);
});

void test('a medication is deleted only from the account\'s own profile', async () => {
  const tx = recordingTransaction((s) => answer(s.sql));

  assert.equal(await deleteMedication(tx, ACCOUNT, MEDICATION), true);

  const [statement] = tx.statements;
  assert.ok(statement);
  assertScopedTo(statement, 'account_id', ACCOUNT);
  assert.deepEqual(statement.params, [MEDICATION, ACCOUNT]);
});

void test('deleting a medication that is not the account\'s reports nothing removed', async () => {
  const tx = recordingTransaction([]);
  assert.equal(await deleteMedication(tx, ACCOUNT, MEDICATION), false);
});

void test('a medication cannot be tied to somebody else\'s condition', async () => {
  // Foreign keys are checked without row-level security, so the statement
  // itself has to refuse a condition id that is not the caller's. With no row
  // produced, the caller gets the same 404 an unknown condition would.
  const tx = recordingTransaction((s) =>
    /INSERT INTO chronic\.profile/.test(s.sql) ? [{ id: 'profile-1' }] : [],
  );

  await assert.rejects(
    createMedication(tx, ACCOUNT, {
      name: 'x',
      dosage: '',
      schedule: '',
      times: [],
      remindersEnabled: true,
      takenToday: false,
      conditionId: CONDITION,
      active: true,
    }),
    (error: Error) => /No such condition/.test(error.message),
  );

  const insert = tx.statements.find((s) => /INSERT INTO chronic\.medication/.test(s.sql));
  assert.ok(insert);
  assert.match(insert.sql, /c\.profile_id = \$1::uuid/);
});
