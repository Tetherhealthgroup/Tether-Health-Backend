import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './support/harness.ts';

/**
 * `PRODUCTION_RELEASE_CHECKLIST.md`: "Offline actions synchronize once without
 * duplication."
 *
 * The phone cannot tell a lost response from a lost request, so it will re-send.
 * These tests are the server's half of that bargain.
 */

const KEY = 'batch-2026-05-01-0001';

const batch = (idempotencyKey = KEY) => ({
  version: 2 as const,
  idempotencyKey,
  enrolments: [{ area: 'tobacco', status: 'active' }],
  answers: {
    'tobacco/S13': { option: { '0': 2 }, chips: { '1': [3, 1] } },
  },
  lapses: [
    {
      area: 'tobacco',
      at: '2026-05-01T10:00:00.000Z',
      severity: 'one cigarette',
      context: ['stress', 'after a meal'],
    },
  ],
});

test('the same batch sent twice produces one set of rows', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const first = await harness.request('account-a', 'POST', '/sync', batch());
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);
  assert.deepEqual(first.body.applied, { answers: 2, lapses: 1, observations: 0 });

  assert.equal(harness.world.lapses.length, 1);
  assert.equal(harness.world.answers.length, 2);

  const second = await harness.request('account-a', 'POST', '/sync', batch());
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true, 'the second send must be recognised');

  // One set of rows, not two.
  assert.equal(harness.world.lapses.length, 1);
  assert.equal(harness.world.answers.length, 2);

  // And one receipt, byte for byte. A client comparing the two responses must
  // not see two different accounts of one event — `syncedAt` included.
  const { replayed: _first, ...firstReceipt } = first.body;
  const { replayed: _second, ...secondReceipt } = second.body;
  assert.deepEqual(secondReceipt, firstReceipt);

  // A replay writes nothing at all, audit trail included: the trail must grow
  // with what happened to the record, not with how flaky the network was.
  const syncEvents = harness.world.audit.filter((row) => row.action === 'record.sync');
  assert.equal(syncEvents.length, 1);
});

test('a fresh key over the same content still writes nothing new', async (t) => {
  // The batch receipt cannot help here — this is the reinstall / cleared-queue
  // case, where the client has genuinely forgotten the key. Per-item identity
  // is what has to hold.
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  await harness.request('account-a', 'POST', '/sync', batch('batch-first-000001'));
  const again = await harness.request(
    'account-a',
    'POST',
    '/sync',
    batch('batch-second-00001'),
  );

  assert.equal(again.body.replayed, false, 'a different key is a different batch');
  assert.equal(again.body.applied.lapses, 0);
  assert.equal(again.body.duplicates.lapses, 1);

  assert.equal(harness.world.lapses.length, 1, 'the lapse must not be duplicated');
  assert.equal(harness.world.answers.length, 2, 'answers upsert onto themselves');
});

test('a batch with no idempotency key is refused', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const { idempotencyKey: _dropped, ...keyless } = batch();
  const response = await harness.request('account-a', 'POST', '/sync', keyless);

  assert.equal(response.status, 400);
  assert.equal(response.body.title, 'validation-failed');
  assert.equal(harness.world.lapses.length, 0);
});

test('the key may travel in the Idempotency-Key header', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const { idempotencyKey: _dropped, ...keyless } = batch();
  const headers = { 'idempotency-key': 'header-supplied-0001' };

  const first = await harness.request('account-a', 'POST', '/sync', keyless, headers);
  const second = await harness.request('account-a', 'POST', '/sync', keyless, headers);

  assert.equal(first.body.replayed, false);
  assert.equal(second.body.replayed, true);
  assert.equal(harness.world.lapses.length, 1);
});

test('a version 1 document is refused rather than migrated', async (t) => {
  // The app takes exactly this position in `restoreFrom`, and for the reason
  // that matters here: a v1 answer key names a screen and no programme, and
  // `behavioral` and `digital` share every screen id, so attributing it means
  // guessing which programme a person's answer belongs to.
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const response = await harness.request('account-a', 'POST', '/sync', {
    ...batch(),
    version: 1,
  });

  assert.equal(response.status, 400);
  assert.equal(harness.world.answers.length, 0);
});

test('an answer key naming no programme is reported, not filed somewhere', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const response = await harness.request('account-a', 'POST', '/sync', {
    ...batch(),
    answers: { S13: { option: { '0': 2 } } },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.applied.answers, 0);
  assert.equal(harness.world.answers.length, 0);
  assert.match(response.body.rejected[0].reason, /names no programme/);
});

test('sync cannot reach a programme the caller is not enrolled in', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');
  harness.world.enrol('account-b', 'alcohol');

  const response = await harness.request('account-a', 'POST', '/sync', {
    ...batch(),
    answers: { 'alcohol/S13': { option: { '0': 9 } } },
    lapses: [{ area: 'alcohol', at: '2026-05-01T10:00:00.000Z', severity: 'x', context: [] }],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.applied.answers, 0);
  assert.equal(response.body.applied.lapses, 0);
  assert.equal(response.body.rejected.length, 2);
  assert.equal(harness.world.answers.length, 0);
  assert.equal(harness.world.lapses.length, 0);
});

test('one account cannot replay another account\'s batch receipt', async (t) => {
  // The receipt is looked up by `(account, key)`. Keyed by the key alone, a
  // guessed key would let one caller learn that another had synced.
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');
  harness.world.enrol('account-b', 'tobacco');

  await harness.request('account-a', 'POST', '/sync', batch());
  const other = await harness.request('account-b', 'POST', '/sync', batch());

  assert.equal(other.body.replayed, false);
  assert.equal(harness.world.lapses.length, 2, 'two people, two records');
});
