import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertScopedTo,
  recordingTransaction,
} from '../../../packages/core/test/support/recording-tx.ts';
import { resolveAllowlist } from '../src/allowlist.ts';

/**
 * R-032 / R-033: who a stream may mention is decided here, once, when it opens.
 *
 * The statements are recorded, not run: that they behave against the real
 * policies, and that a stream really does deliver only to the owner, is
 * `db/test/service-roles.integration.test.ts`.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OWN = 'aaaaaaaa-0000-4000-8000-000000000001';
const SHARED = 'bbbbbbbb-0000-4000-8000-000000000001';

test('both lookups name the account', async () => {
  const tx = recordingTransaction([]);

  await resolveAllowlist(tx, ACCOUNT);

  assert.equal(tx.statements.length, 2);
  const [owned, shared] = tx.statements;
  assert.ok(owned && shared);

  assert.match(owned.sql, /FROM programme\.enrolment/);
  assertScopedTo(owned, 'account_id', ACCOUNT);

  assert.match(shared.sql, /FROM programme\.sharing_consent/);
  assertScopedTo(shared, 'recipient_id', ACCOUNT);
  assert.match(shared.sql, /revoked_at IS NULL/);
});

test('owned and shared are kept apart', async () => {
  const tx = recordingTransaction((s) =>
    /FROM programme\.enrolment/.test(s.sql) ? [{ id: OWN }] : [{ enrolment_id: SHARED }],
  );

  const allowlist = await resolveAllowlist(tx, ACCOUNT);

  assert.deepEqual([...allowlist.owned], [OWN]);
  assert.deepEqual([...allowlist.shared], [SHARED]);
});

test('an enrolment the account owns is never also "shared with" it', async () => {
  // A consent naming the owner as recipient of their own enrolment is odd but
  // representable. It must not put the enrolment in the set a revocation can
  // remove it from.
  const tx = recordingTransaction((s) =>
    /FROM programme\.enrolment/.test(s.sql) ? [{ id: OWN }] : [{ enrolment_id: OWN }],
  );

  const allowlist = await resolveAllowlist(tx, ACCOUNT);

  assert.deepEqual([...allowlist.owned], [OWN]);
  assert.deepEqual([...allowlist.shared], []);
});
