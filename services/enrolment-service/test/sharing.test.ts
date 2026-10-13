import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharingRequestSchema } from '@tether/contracts';

/**
 * `per_program_sharing`, enforced in the shape of the request.
 *
 * "Sharing consent is granted per program, never globally. A cessation coach
 * has no business seeing behavioural health data. Under 42 CFR Part 2,
 * substance-use data must be segregated regardless."
 *
 * `programme.sharing_consent` has no `account_id` column, so a global grant is
 * unrepresentable in the database. The tests below are about the other half of
 * that: an API that *accepted* one would be promising something it then had to
 * fake, and faking it means walking every enrolment on the caller's behalf —
 * which is exactly the sweep the missing column exists to prevent.
 */

const VALID_GRANT = {
  granted: true,
  scope: 'totals_and_adherence',
  recipientKind: 'coach',
  consentVersion: '2026-09-01',
  consentText:
    'I agree to share my totals and adherence for this programme with my coach.',
};

function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

void test('a per-programme grant naming its wording is accepted', () => {
  const result = SharingRequestSchema.safeParse(VALID_GRANT);
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

void test('a revocation needs no wording', () => {
  const result = SharingRequestSchema.safeParse({
    granted: false,
    scope: 'notes',
    recipientKind: 'care_team',
  });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

void test('a grant that does not carry the wording is refused', () => {
  const { consentText, ...withoutWording } = VALID_GRANT;
  void consentText;

  const result = SharingRequestSchema.safeParse(withoutWording);
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes('consentText'));
});

void test('a body naming an account rather than a programme is refused, with the rule quoted', () => {
  for (const key of [
    'accountId',
    'account_id',
    'userId',
    'global',
    'allPrograms',
    'allProgrammes',
    'applyToAll',
  ]) {
    const result = SharingRequestSchema.safeParse({
      ...VALID_GRANT,
      [key]: key === 'global' || key === 'applyToAll' ? true : 'some-uuid',
    });

    assert.equal(result.success, false, `\`${key}\` was accepted`);
    assert.ok(
      issuePaths(result).includes(key),
      `\`${key}\` was not the field blamed`,
    );

    // The refusal has to explain itself. "Unrecognized key" teaches a client
    // author to try a different spelling; the rule teaches them there is no
    // spelling.
    const messages = (result.error?.issues ?? []).map((issue) => issue.message);
    assert.ok(
      messages.some((message) => /never globally/.test(message)),
      `\`${key}\` was refused without quoting the rule`,
    );
  }
});

void test('a wildcard recipient is refused — null already means "any of this kind"', () => {
  for (const recipientId of ['*', 'all', 'ANY', ' everyone ']) {
    const result = SharingRequestSchema.safeParse({ ...VALID_GRANT, recipientId });
    assert.equal(result.success, false, `\`${recipientId}\` was accepted`);
    assert.ok(issuePaths(result).includes('recipientId'));
  }
});

void test('a named recipient of a known kind is fine', () => {
  const result = SharingRequestSchema.safeParse({
    ...VALID_GRANT,
    recipientId: 'coach-4417',
  });
  assert.equal(result.success, true, JSON.stringify(issuePaths(result)));
});

void test('scope and recipientKind are closed sets', () => {
  // `scope: 'all'` and `recipientKind: 'everyone'` are the other two shapes a
  // global grant arrives in. The enums refuse both without any extra code.
  assert.equal(
    SharingRequestSchema.safeParse({ ...VALID_GRANT, scope: 'all' }).success,
    false,
  );
  assert.equal(
    SharingRequestSchema.safeParse({ ...VALID_GRANT, recipientKind: 'everyone' })
      .success,
    false,
  );
});

void test('an unknown field is refused rather than ignored', () => {
  const result = SharingRequestSchema.safeParse({
    ...VALID_GRANT,
    expiresInDays: 30,
  });

  // Silently dropping it would let a client believe it had set an expiry that
  // this API does not implement.
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes('expiresInDays'));
});
