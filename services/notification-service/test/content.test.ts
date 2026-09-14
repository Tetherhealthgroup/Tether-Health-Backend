import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '@tether/core';
import {
  dataFor,
  readSpecificContentGrant,
  render,
  type SpecificContentGrant,
} from '../src/content.ts';
import { NOTIFICATION_LOG_SQL } from '../src/store.ts';

/**
 * `sensitive_notifications_off` — "A lock screen shows that a reminder exists,
 * never what it is about." These tests are the executable half of that
 * sentence. Every one of them is about a way the specific wording could escape.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** A transaction whose single-row read returns whatever the test hands it. */
function txReturning(row: unknown): Transaction {
  return {
    query: async () => [],
    one: async () => row,
  } as unknown as Transaction;
}

test('with no grant the payload is generic', () => {
  const result = render('medication_reminder', ACCOUNT, null, {
    name: 'Naltrexone',
    dosage: '50 mg',
  });

  assert.equal(result.variant, 'generic');
  assert.equal(result.payload.title, 'Tether Health');
  assert.equal(result.payload.body, 'You have a reminder');
});

test('the variables a caller supplied do not appear anywhere in a generic payload', () => {
  const result = render('medication_reminder', ACCOUNT, null, {
    name: 'Naltrexone',
  });
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes('Naltrexone'), false);
});

test('every kind produces the same generic payload', () => {
  // Per-kind generic wording ("You have a medication reminder") would leak the
  // category, which is what the safeguard forbids.
  const kinds = [
    'medication_reminder',
    'check_in_due',
    'programme_message',
    'care_team_message',
    'lapse_support',
  ] as const;

  const bodies = new Set(
    kinds.map((kind) => JSON.stringify(render(kind, ACCOUNT, null).payload)),
  );
  assert.equal(bodies.size, 1);
});

test('a forged grant does not unlock the specific payload', () => {
  // TypeScript branding alone is defeated by exactly this cast, which is why
  // `render` also checks a module-private WeakSet.
  const forged = {
    accountId: ACCOUNT,
    optedInAt: new Date(),
  } as unknown as SpecificContentGrant;

  const result = render('medication_reminder', ACCOUNT, forged, {
    name: 'Naltrexone',
  });
  assert.equal(result.variant, 'generic');
});

test('no row means off, because defaultOff is the whole point', async () => {
  const grant = await readSpecificContentGrant(txReturning(null), ACCOUNT);
  assert.equal(grant, null);
});

test('specific_content = false means off', async () => {
  const grant = await readSpecificContentGrant(
    txReturning({ specific_content: false, opted_in_at: null }),
    ACCOUNT,
  );
  assert.equal(grant, null);
});

test('a real grant, and only then, produces the specific wording', async () => {
  const grant = await readSpecificContentGrant(
    txReturning({ specific_content: true, opted_in_at: new Date() }),
    ACCOUNT,
  );
  assert.notEqual(grant, null);

  const result = render('medication_reminder', ACCOUNT, grant, {
    name: 'Naltrexone',
    dosage: '50 mg',
  });
  assert.equal(result.variant, 'specific');
  assert.equal(result.payload.body, 'Naltrexone · 50 mg');
});

test("one account's opt-in does not authorise another account's lock screen", async () => {
  const grant = await readSpecificContentGrant(
    txReturning({ specific_content: true, opted_in_at: new Date() }),
    ACCOUNT,
  );

  const result = render('medication_reminder', OTHER, grant, { name: 'Naltrexone' });
  assert.equal(result.variant, 'generic');
});

test('the data block carries no template variables', () => {
  const data = dataFor('medication_reminder', 'med-123');
  assert.deepEqual(data, { kind: 'medication_reminder', refId: 'med-123', fetch: 'true' });
});

test('the delivery record has nowhere to put the text', () => {
  // `ops.notification_log` has no body column and this statement names no such
  // parameter. Asserted rather than assumed: the absence is the safeguard, and
  // an absence is what quietly stops being true.
  for (const forbidden of ['body', 'title', 'payload', 'message', 'content']) {
    assert.equal(
      NOTIFICATION_LOG_SQL.includes(forbidden),
      false,
      `the notification log statement must not mention "${forbidden}"`,
    );
  }
});
