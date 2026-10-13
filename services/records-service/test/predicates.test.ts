import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertScopedTo,
  recordingTransaction,
} from '../../../packages/core/test/support/recording-tx.ts';
import { createPostgresStore } from '../src/postgres-store.ts';

/**
 * Every records-service read already named the account. The one statement that
 * did not was the DELETE that clears blocks a `PUT` no longer names, which
 * leaned on RLS alone. The behaviour against the real policies is
 * `db/test/service-roles.integration.test.ts`.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ENROLMENT = 'aaaaaaaa-0000-4000-8000-000000000001';

test('clearing a screen\'s dropped blocks names the caller as the enrolment\'s owner', async () => {
  const tx = recordingTransaction([]);
  const store = createPostgresStore();

  await store.replaceScreenAnswers({ tx, accountId: ACCOUNT }, ENROLMENT, 'S01', []);

  const remove = tx.statements.find((s) => /DELETE FROM record\.screen_answer/.test(s.sql));
  assert.ok(remove, 'no DELETE was issued');
  assertScopedTo(remove, 'own.account_id', ACCOUNT);
  // Joined to a qualified column of the statement's own table, not to whatever
  // `enrolment_id` happens to bind to.
  assert.match(remove.sql, /own\.id = record\.screen_answer\.enrolment_id/);
});

test('every read of the record names the account', async () => {
  const tx = recordingTransaction([]);
  const store = createPostgresStore();
  const ctx = { tx, accountId: ACCOUNT };

  await store.enrolmentForArea(ctx, 'tobacco');
  await store.enrolments(ctx);
  await store.answers(ctx, ENROLMENT);
  await store.lapses(ctx, ENROLMENT);
  await store.observations(ctx, ENROLMENT);
  await store.liveConsents(ctx);

  assert.equal(tx.statements.length, 6);
  for (const statement of tx.statements) {
    assertScopedTo(statement, 'account_id', ACCOUNT);
  }
});
