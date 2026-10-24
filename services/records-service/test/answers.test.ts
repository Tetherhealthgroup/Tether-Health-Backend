import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './support/harness.ts';

/**
 * Answers are keyed by enrolment, never by screen id alone.
 *
 * `behavioral` and `digital` both resolve to the `lookup` product, so their 34
 * screen ids are identical, and `two_active_max` permits exactly that pair to
 * be running at once. The Flutter app shipped with this bug and was fixed for
 * it; these tests are the backend refusing to reintroduce it.
 */

void test('two programmes sharing a screen id keep separate records', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'behavioral');
  harness.world.enrol('account-a', 'digital');

  await harness.request('account-a', 'PUT', '/behavioral/answers/S13', {
    slider: { '0': 70 },
  });
  await harness.request('account-a', 'PUT', '/digital/answers/S13', {
    slider: { '0': 10 },
  });

  const behavioral = await harness.request('account-a', 'GET', '/behavioral/answers');
  const digital = await harness.request('account-a', 'GET', '/digital/answers');

  assert.equal(behavioral.body.answers.S13.slider['0'], 70);
  assert.equal(digital.body.answers.S13.slider['0'], 10);
  assert.equal(harness.world.answers.length, 2, 'two rows, not one merged row');
});

void test('an answer is returned in the shape the app encodes', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  await harness.request('account-a', 'PUT', '/tobacco/answers/S13', {
    chips: { '0': [3, 1] },
    option: { '1': 2 },
    text: { '2': 'after lunch, mostly' },
  });

  const response = await harness.request('account-a', 'GET', '/tobacco/answers');

  // All four maps present even when empty, as `_encodeAnswers` writes them.
  assert.deepEqual(response.body.answers.S13, {
    // Sorted: a Set has no order, and an unordered encoding turns an idempotent
    // re-send into a write.
    chips: { '0': [1, 3] },
    option: { '1': 2 },
    slider: {},
    text: { '2': 'after lunch, mostly' },
  });
});

void test('PUT replaces the screen rather than accumulating blocks', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  await harness.request('account-a', 'PUT', '/tobacco/answers/S13', {
    option: { '0': 1, '1': 2 },
  });
  const replaced = await harness.request('account-a', 'PUT', '/tobacco/answers/S13', {
    option: { '0': 5 },
  });

  assert.equal(replaced.body.written, 1);
  assert.equal(replaced.body.removed, 1);
  assert.equal(harness.world.answers.length, 1);
});

void test('one block cannot be two kinds at once', async (t) => {
  // `record.screen_answer` is unique on `(enrolment_id, screen_id, block_index)`,
  // so this body describes two rows that cannot both exist. Keeping whichever
  // came last would make the stored record depend on JSON key order.
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const response = await harness.request('account-a', 'PUT', '/tobacco/answers/S13', {
    chips: { '0': [1] },
    slider: { '0': 50 },
  });

  assert.equal(response.status, 400);
  assert.equal(harness.world.answers.length, 0);
});

void test('an unknown block kind is refused rather than dropped', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const response = await harness.request('account-a', 'PUT', '/tobacco/answers/S13', {
    freeform: { '0': 'hello' },
  });

  assert.equal(response.status, 400);
});

void test('an area the caller has not joined is a 404, not a 403', async (t) => {
  // `errors.ts`: not-found covers "the caller may not know that it does".
  // Whether somebody else is enrolled in an area is not this caller's business.
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-b', 'tobacco');

  const response = await harness.request('account-a', 'GET', '/tobacco/answers');
  assert.equal(response.status, 404);
});

void test('an unauthenticated request never reaches the record', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const response = await fetch(`${harness.url}/tobacco/answers`);
  assert.equal(response.status, 401);
});
