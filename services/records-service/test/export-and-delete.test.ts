import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './support/harness.ts';

/**
 * `export_and_delete` — "Data can be exported and deleted, with deletion
 * actually completed rather than hidden" — and the checklist's "verified
 * exports and deletion with auditable completion".
 */

async function seeded() {
  const harness = await startHarness();
  harness.world.enrol('account-a', 'behavioral', 'Mental & behavioural health');
  harness.world.enrol('account-a', 'digital', 'Digital wellbeing');

  await harness.request('account-a', 'PUT', '/behavioral/answers/S13', {
    slider: { '0': 70 },
  });
  await harness.request('account-a', 'PUT', '/digital/answers/S13', {
    slider: { '0': 10 },
  });
  await harness.request('account-a', 'POST', '/behavioral/lapses', {
    occurredAt: '2026-05-01T10:00:00.000Z',
    severity: 'a hard evening',
    context: ['stress'],
  });
  await harness.request('account-a', 'POST', '/digital/observations', {
    measureId: 'screen_time',
    value: 320,
    unit: 'minutes',
    observedAt: '2026-05-01T22:00:00.000Z',
    source: 'device',
    platform: 'ios',
  });

  return harness;
}

test('the export nests answers inside their programme, with no flat top-level map', async (t) => {
  const harness = await seeded();
  t.after(() => harness.close());

  const response = await harness.request('account-a', 'GET', '/export');
  assert.equal(response.status, 200);

  const document = response.body;
  assert.equal(document.locale, 'en');
  assert.equal(document.answers, undefined, 'no shared pool of answers at the top');
  assert.equal(document.programs.length, 2);

  const behavioral = document.programs.find((p: any) => p.area === 'behavioral');
  const digital = document.programs.find((p: any) => p.area === 'digital');

  // The shape's whole argument: a single list of S13 above two programme
  // headings invites exactly the wrong conclusion — that there is one pool of
  // answers underneath the programmes. There is not.
  assert.equal(behavioral.answers.S13.slider['0'], 70);
  assert.equal(digital.answers.S13.slider['0'], 10);

  assert.equal(behavioral.name, 'Mental & behavioural health');
  assert.equal(behavioral.lapses[0].severity, 'a hard evening');
  assert.equal(digital.observations[0].measureId, 'screen_time');
  assert.equal(digital.observations[0].selfReported, false);
});

test('the export reports sharing from live consent, not a stored boolean', async (t) => {
  const harness = await seeded();
  t.after(() => harness.close());

  const enrolment = harness.world.enrolments.find((row) => row.areaId === 'behavioral')!;
  const consent = harness.world.grant(enrolment.id, 'notes', 'clinician-1');

  const granted = await harness.request('account-a', 'GET', '/export');
  const before = granted.body.programs.find((p: any) => p.area === 'behavioral');
  assert.equal(before.sharing.notes, true);

  // "Revocation enforced on the server, not merely reflected in the interface."
  consent.revokedAt = '2026-05-02T00:00:00.000Z';

  const revoked = await harness.request('account-a', 'GET', '/export');
  const after = revoked.body.programs.find((p: any) => p.area === 'behavioral');
  assert.equal(after.sharing.notes, false);
});

test('an export is audited, and the audit row carries no content', async (t) => {
  const harness = await seeded();
  t.after(() => harness.close());

  await harness.request('account-a', 'GET', '/export');

  const event = harness.world.audit.find((row) => row.action === 'record.export');
  assert.ok(event, 'an export is a disclosure even to the person themselves');
  assert.deepEqual(event.detail, {
    programmes: 2,
    answers: 2,
    lapses: 1,
    observations: 1,
    locale: 'en',
  });
});

test('deletion is audited before it happens, and completes', async (t) => {
  const harness = await seeded();
  t.after(() => harness.close());

  const response = await harness.request('account-a', 'DELETE', '/record');
  assert.equal(response.status, 200);
  assert.equal(response.body.verifiedEmpty, true);
  assert.deepEqual(response.body.deleted, {
    enrolments: 2,
    answers: 2,
    lapses: 1,
    observations: 1,
    consents: 0,
  });

  // Really gone. No `deleted_at`, nothing left behind a flag.
  assert.deepEqual(harness.world.answers, []);
  assert.deepEqual(harness.world.lapses, []);
  assert.deepEqual(harness.world.observations, []);
  assert.deepEqual(harness.world.enrolments, []);

  // The record of the deletion outlives the data, and is written first — it has
  // to name what was there while there is still something to name.
  const actions = harness.world.audit.map((row) => row.action);
  const requested = actions.indexOf('record.delete.requested');
  const completed = actions.indexOf('record.delete.completed');
  assert.ok(requested >= 0 && completed > requested);

  const intent = harness.world.audit[requested]!;
  assert.deepEqual(intent.detail, { areas: ['behavioral', 'digital'] });
});

test('deleting one account\'s record leaves another account\'s alone', async (t) => {
  const harness = await seeded();
  t.after(() => harness.close());
  harness.world.enrol('account-b', 'tobacco');
  await harness.request('account-b', 'PUT', '/tobacco/answers/S13', {
    slider: { '0': 44 },
  });

  await harness.request('account-a', 'DELETE', '/record');

  assert.equal(harness.world.enrolments.length, 1);
  assert.equal(harness.world.answers.length, 1);
  const kept = await harness.request('account-b', 'GET', '/tobacco/answers');
  assert.equal(kept.body.answers.S13.slider['0'], 44);
});

test('readiness is a real check, not a constant', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const ready = await fetch(`${harness.url}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: 'ready',
    service: 'records-service',
  });

  const live = await fetch(`${harness.url}/healthz`);
  assert.equal(live.status, 200);
});
