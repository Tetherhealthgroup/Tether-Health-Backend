import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertScopedTo, recordingTransaction } from './support/recording-tx.ts';

/**
 * The predicate assertions in the service tests are only worth having if they
 * can fail. These are the shapes they must reject.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

void test('a statement that compares the account is accepted, whichever placeholder carries it', () => {
  assertScopedTo(
    { sql: 'SELECT 1 FROM t WHERE a = $1 AND account_id = $2', params: ['x', ACCOUNT] },
    'account_id',
    ACCOUNT,
  );
  assertScopedTo(
    { sql: 'SELECT 1 FROM t WHERE $1 = own.account_id', params: [ACCOUNT] },
    'own.account_id',
    ACCOUNT,
  );
});

void test('an account that is passed but never compared is rejected', () => {
  assert.throws(
    () =>
      assertScopedTo(
        { sql: 'SELECT $1, id FROM t WHERE area_id = $2', params: [ACCOUNT, 'x'] },
        'account_id',
        ACCOUNT,
      ),
    /no `account_id = \$n` predicate/,
  );
});

void test('a statement that does not receive the account at all is rejected', () => {
  assert.throws(
    () =>
      assertScopedTo(
        { sql: 'SELECT id FROM t WHERE area_id = $1', params: ['x'] },
        'account_id',
        ACCOUNT,
      ),
    /not among the parameters/,
  );
});

void test('$1 is not mistaken for $10', () => {
  assert.throws(() =>
    assertScopedTo(
      { sql: 'SELECT 1 WHERE account_id = $10', params: [ACCOUNT, ...Array<string>(9).fill('x'), 'y'] },
      'account_id',
      ACCOUNT,
    ),
  );
});

void test('the recording transaction returns what it is told and remembers what it was asked', async () => {
  const tx = recordingTransaction([{ id: 1 }]);
  assert.deepEqual(await tx.query('SELECT 1', ['a']), [{ id: 1 }]);
  assert.deepEqual(await tx.one('SELECT 2'), { id: 1 });
  assert.deepEqual(
    tx.statements.map((s) => s.sql),
    ['SELECT 1', 'SELECT 2'],
  );
});
