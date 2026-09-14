import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProblem, ProblemType } from '@tether/core';
import {
  ceilingFromRule,
  ceilingRefusal,
  checkCeiling,
  DEFAULT_ACTIVE_CEILING,
  isActiveCeilingViolation,
  longestRunning,
  withCeilingTranslation,
  type ActiveProgramme,
} from '../src/rules.ts';

/**
 * `two_active_max`, and the two ways it can be reached.
 *
 * "At most two programs may be active at once. Three concurrent behaviour
 * changes is where adherence collapses. A third requires a conversation with a
 * clinician or coach, not a tap."
 *
 * The API refuses first, and the deferred constraint trigger in
 * `0003_programme_and_record.sql` refuses second, for the race the API cannot
 * see. Both have to end in the same `at-programme-ceiling` problem naming the
 * same programme, because the client has one screen for it.
 */

const TOBACCO: ActiveProgramme = {
  areaId: 'tobacco',
  joinedOn: '2026-01-04T09:00:00.000Z',
};
const BEHAVIORAL: ActiveProgramme = {
  areaId: 'behavioral',
  joinedOn: '2026-06-18T09:00:00.000Z',
};

test('two active programmes refuse a third, and name the longest-running one', () => {
  const check = checkCeiling({
    active: [BEHAVIORAL, TOBACCO],
    areaId: 'digital',
    ceiling: 2,
  });

  assert.equal(check.refused, true);

  // Tobacco was joined in January and behavioural in June. The one the person
  // has been doing longest is the one the join screen offers to pause.
  assert.equal(check.wouldPause, 'tobacco');

  const refusal = ceilingRefusal(check);
  assert.ok(isProblem(refusal));
  assert.equal(refusal.type, ProblemType.atProgrammeCeiling);
  assert.equal(refusal.status, 409);
  // On `extensions`, not `context`: the join screen has to render which
  // programme would be paused, and `context` is never serialised.
  assert.equal(refusal.extensions?.wouldPause, 'tobacco');
  assert.equal(refusal.toBody().wouldPause, 'tobacco');
});

test('naming a programme to pause makes room in the same request', () => {
  const check = checkCeiling({
    active: [TOBACCO, BEHAVIORAL],
    areaId: 'digital',
    pausing: 'tobacco',
    ceiling: 2,
  });

  assert.equal(check.refused, false);
  assert.equal(check.wouldPause, null);
  assert.deepEqual(
    check.remaining.map((programme) => programme.areaId),
    ['behavioral'],
  );
});

test('re-joining a programme that is already active is not a third programme', () => {
  const check = checkCeiling({
    active: [TOBACCO, BEHAVIORAL],
    areaId: 'tobacco',
    ceiling: 2,
  });

  // `UNIQUE (account_id, area_id)` means this reuses the existing row. Counting
  // it as a new one would refuse a request that changes nothing.
  assert.equal(check.refused, false);
});

test('one active programme leaves room for another', () => {
  const check = checkCeiling({ active: [TOBACCO], areaId: 'digital', ceiling: 2 });
  assert.equal(check.refused, false);
  assert.equal(check.wouldPause, null);
});

test('longestRunning is empty-safe', () => {
  assert.equal(longestRunning([]), null);
  assert.equal(longestRunning([BEHAVIORAL]), 'behavioral');
});

test('the ceiling is read from the shell rule, and falls back exactly as the trigger does', () => {
  assert.equal(ceilingFromRule('At most 3 programs may be active at once.'), 3);

  // The rule as shipped spells the number in words, so `substring(rule from
  // '\d+')` in the trigger yields NULL and this yields undefined. Both fall
  // back to 2 — and agreeing is the point, because an API that thought the
  // ceiling was 3 while the trigger thought it was 2 would return a 500 on
  // precisely the request the friendly refusal was written for.
  assert.equal(
    ceilingFromRule('At most two programs may be active at once.'),
    DEFAULT_ACTIVE_CEILING,
  );
  assert.equal(ceilingFromRule(null), DEFAULT_ACTIVE_CEILING);
  assert.equal(ceilingFromRule(undefined), DEFAULT_ACTIVE_CEILING);
});

// ---------------------------------------------------------------------------
// The database backstop
// ---------------------------------------------------------------------------

/** What `pg` raises when `programme.enforce_active_ceiling()` fires. */
function triggerViolation(): Error & Record<string, unknown> {
  const error = new Error(
    'at most 2 programmes may be active at once (account 0b1e…)',
  ) as Error & Record<string, unknown>;
  error.code = '23514';
  error.where =
    'PL/pgSQL function programme.enforce_active_ceiling() line 15 at RAISE';
  return error;
}

/** An ordinary CHECK on the same table, which shares the SQLSTATE. */
function ordinaryCheckViolation(): Error & Record<string, unknown> {
  const error = new Error(
    'new row for relation "enrolment" violates check constraint "enrolment_status_check"',
  ) as Error & Record<string, unknown>;
  error.code = '23514';
  error.constraint = 'enrolment_status_check';
  return error;
}

test('the trigger violation is recognised; an ordinary check violation is not', () => {
  assert.equal(isActiveCeilingViolation(triggerViolation()), true);

  // Both are SQLSTATE 23514. Matching on the code alone would turn a malformed
  // status into "two programmes are already active", which is a lie the client
  // would render as a pause prompt.
  assert.equal(isActiveCeilingViolation(ordinaryCheckViolation()), false);
  assert.equal(isActiveCeilingViolation(new Error('boom')), false);
  assert.equal(isActiveCeilingViolation(null), false);
});

test('a deferred trigger violation at COMMIT becomes the ceiling problem, not a 500', async () => {
  const hint = { wouldPause: 'tobacco' };

  await assert.rejects(
    withCeilingTranslation(hint, async () => {
      // The trigger is DEFERRABLE INITIALLY DEFERRED, so this is thrown by the
      // COMMIT inside `withPrincipal` — after the callback returned. That is
      // why the translation wraps the whole database call and reads a hint
      // captured earlier, rather than wrapping the INSERT.
      throw triggerViolation();
    }),
    (error: unknown) => {
      assert.ok(isProblem(error));
      assert.equal(error.type, ProblemType.atProgrammeCeiling);
      assert.equal(error.status, 409);
      assert.equal(error.extensions?.wouldPause, 'tobacco');
      assert.equal(error.toBody().wouldPause, 'tobacco');
      return true;
    },
  );
});

test('anything that is not the ceiling trigger is rethrown untouched', async () => {
  const original = ordinaryCheckViolation();

  await assert.rejects(
    withCeilingTranslation({ wouldPause: null }, async () => {
      throw original;
    }),
    (error: unknown) => {
      // Rethrown by identity: dressing an unrelated constraint failure up as a
      // ceiling refusal would hide a real bug behind a friendly screen.
      assert.equal(error, original);
      return true;
    },
  );
});

test('a successful call passes its value through', async () => {
  const value = await withCeilingTranslation({ wouldPause: null }, async () => 'joined');
  assert.equal(value, 'joined');
});
