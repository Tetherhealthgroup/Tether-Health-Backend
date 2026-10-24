import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT, CONDITION, startHarness } from './support/harness.ts';

/**
 * R-033: "Health metric keys get logged (chronic index.ts:221,288)".
 *
 * Every assertion is on the text the service actually wrote, read back from the
 * log destination, after exercising the routes that used to log a condition
 * kind and a metric key. The canaries (`zz_canary_*`) are strings no part of
 * the system produces for any other reason, so a hit means a request or a row
 * reached the log.
 */

const CANARIES = [
  'zz_canary_metric',
  'zz canary label',
  'zz canary note',
  'zz canary drug',
  '123.4',
  // The condition kind. Not a canary, but the thing that was being logged.
  'diabetes',
];

void test('writing a condition, a vital and a medication logs ids and nothing about their contents', async () => {
  const h = await startHarness();
  try {
    const condition = await h.request('POST', '/conditions', { kind: 'diabetes' });
    assert.equal(condition.status, 201);

    const vital = await h.request('POST', `/conditions/${CONDITION}/vitals`, {
      metricKey: 'zz_canary_metric',
      label: 'zz canary label',
      value: 123.4,
      unit: 'zz',
      note: 'zz canary note',
    });
    assert.equal(vital.status, 201);

    const medication = await h.request('POST', '/medications', {
      name: 'zz canary drug',
      dosage: '1 zz',
    });
    assert.equal(medication.status, 201);

    const patch = await h.request('PATCH', '/profile', { displayName: 'Synthetic Person' });
    assert.equal(patch.status, 200);

    const logs = h.logs();
    assert.match(logs, /vital recorded/, 'the handler stopped logging at all');
    assert.match(logs, /chronic condition recorded/);

    for (const canary of CANARIES) {
      assert.ok(!logs.includes(canary), `the log contains "${canary}"`);
    }
    // The account is not in the lines either, so nothing here is attributable.
    assert.ok(!logs.includes(ACCOUNT), 'the account id is in the log');
  } finally {
    await h.close();
  }
});

void test('a database failure that carries the row does not put the row in the log', async () => {
  // The shape `pg` gives a violated constraint: a generic message, and `detail`
  // holding the failing row.
  const failure = Object.assign(new Error('new row violates check constraint'), {
    code: '23514',
    detail: 'Failing row contains (zz_canary_metric, 123.4, zz canary note).',
  });
  const h = await startHarness({ failWith: failure });
  try {
    const response = await h.request('POST', `/conditions/${CONDITION}/vitals`, {
      metricKey: 'zz_canary_metric',
      value: 123.4,
      note: 'zz canary note',
    });
    assert.equal(response.status, 500);

    const logs = h.logs();
    assert.match(logs, /request failed/, 'the failure was not logged at all');
    for (const canary of ['zz_canary_metric', '123.4', 'zz canary note']) {
      assert.ok(!logs.includes(canary), `the log contains "${canary}"`);
    }
  } finally {
    await h.close();
  }
});

void test('deleting a medication logs the id, which is not a name', async () => {
  const h = await startHarness();
  try {
    const response = await h.request(
      'DELETE',
      '/medications/55555555-5555-4555-8555-555555555555',
    );
    assert.equal(response.status, 204);
    assert.ok(!h.logs().includes('zz canary drug'));
  } finally {
    await h.close();
  }
});
