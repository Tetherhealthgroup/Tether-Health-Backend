import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAccountId } from '../src/db.ts';

/**
 * `app.account_id` is what every RLS policy keys off, and it is read through a
 * `::uuid` cast. These are the inputs that must never reach `set_config`.
 */

test('a uuid is accepted and normalised to lower case', () => {
  assert.equal(
    assertAccountId('11111111-AAAA-4111-8111-111111111111'),
    '11111111-aaaa-4111-8111-111111111111',
  );
});

test('anything that is not a uuid is refused, without echoing it', () => {
  for (const bad of [
    '',
    ' ',
    'not-a-uuid',
    "11111111-1111-4111-8111-111111111111'; DROP TABLE x;--",
    '11111111-1111-4111-8111-11111111111',
    '11111111-1111-4111-8111-1111111111111',
    '{11111111-1111-4111-8111-111111111111}',
    ' 11111111-1111-4111-8111-111111111111',
  ]) {
    assert.throws(
      () => assertAccountId(bad),
      (error: Error) => {
        assert.match(error.message, /not a uuid/);
        assert.ok(bad.trim() === '' || !error.message.includes(bad), 'the input was echoed');
        return true;
      },
      JSON.stringify(bad),
    );
  }
});
