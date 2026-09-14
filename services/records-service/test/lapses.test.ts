import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './support/harness.ts';

/**
 * `slip_never_resets`: "A lapse is recorded in history. It never zeroes a
 * counter, streak or progress value."
 *
 * The safeguard is structural here — there is no counter column for a lapse to
 * reset and no route that edits or removes one — so these tests assert the
 * absence rather than a behaviour. That is the honest shape for a rule of this
 * kind: it is kept by there being nothing to break.
 */

const lapse = (at: string, severity = 'one cigarette') => ({
  occurredAt: at,
  severity,
  context: ['stress'],
});

test('recording a lapse never lowers anything derived from history', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const before = await harness.request('account-a', 'GET', '/tobacco/lapses');
  assert.deepEqual(before.body.history, { recorded: 0, firstAt: null, lastAt: null });

  await harness.request(
    'account-a',
    'POST',
    '/tobacco/lapses',
    lapse('2026-05-01T10:00:00.000Z'),
  );
  const afterOne = await harness.request('account-a', 'GET', '/tobacco/lapses');
  assert.equal(afterOne.body.history.recorded, 1);

  await harness.request(
    'account-a',
    'POST',
    '/tobacco/lapses',
    lapse('2026-05-02T10:00:00.000Z'),
  );
  const afterTwo = await harness.request('account-a', 'GET', '/tobacco/lapses');

  assert.equal(afterTwo.body.history.recorded, 2);
  assert.ok(
    afterTwo.body.history.recorded > afterOne.body.history.recorded,
    'the only number this service derives from lapses can only rise',
  );
  assert.equal(afterTwo.body.history.firstAt, '2026-05-01T10:00:00.000Z');
  assert.equal(afterTwo.body.history.lastAt, '2026-05-02T10:00:00.000Z');
});

test('no response about a lapse carries a streak, score or progress value', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const posted = await harness.request(
    'account-a',
    'POST',
    '/tobacco/lapses',
    lapse('2026-05-01T10:00:00.000Z'),
  );
  const listed = await harness.request('account-a', 'GET', '/tobacco/lapses');

  const forbidden = /"(streak|score|progress|risk|grade|interpretation)"/i;
  assert.doesNotMatch(JSON.stringify(posted.body), forbidden);
  assert.doesNotMatch(JSON.stringify(listed.body), forbidden);
});

test('lapses are append-only: there is no route that edits or removes one', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const posted = await harness.request(
    'account-a',
    'POST',
    '/tobacco/lapses',
    lapse('2026-05-01T10:00:00.000Z'),
  );
  const id = posted.body.lapse.id;

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const response = await harness.request(
      'account-a',
      method,
      `/tobacco/lapses/${id}`,
      method === 'DELETE' ? undefined : {},
    );
    assert.equal(response.status, 404, `${method} on a lapse must not exist`);
  }

  assert.equal(harness.world.lapses.length, 1);
});

test('a retried POST is the same event, not a second one', async (t) => {
  // A dropped response and a dropped request look identical to the client, so a
  // retried POST and a re-sent sync item are the same thing arriving twice and
  // must behave the same way. Duplicating a lapse would put an event in a
  // person's history that never happened.
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const first = await harness.request(
    'account-a',
    'POST',
    '/tobacco/lapses',
    lapse('2026-05-01T10:00:00.000Z'),
  );
  const retry = await harness.request(
    'account-a',
    'POST',
    '/tobacco/lapses',
    lapse('2026-05-01T10:00:00.000Z'),
  );

  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.lapse.id, first.body.lapse.id);
  assert.equal(harness.world.lapses.length, 1);
});

test('the audit row for a lapse carries no severity and no context', async (t) => {
  // `ops.audit_event` has no update and no delete path. What goes in it is
  // chosen rather than filtered, and the record must not be duplicated into a
  // table nothing can ever redact.
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  await harness.request(
    'account-a',
    'POST',
    '/tobacco/lapses',
    lapse('2026-05-01T10:00:00.000Z', 'a whole packet, alone, at 3am'),
  );

  const event = harness.world.audit.find((row) => row.action === 'record.lapse.append');
  assert.ok(event);
  assert.doesNotMatch(JSON.stringify(event.detail), /3am|packet|stress/);
  assert.deepEqual(event.detail, { areaId: 'tobacco', created: true });
});

test('an observation keeps its provenance and is never presented as measured', async (t) => {
  // `self_report_only`: "Ratings describe how someone felt. The product is
  // explicit that these are self-reports."
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const posted = await harness.request('account-a', 'POST', '/tobacco/observations', {
    measureId: 'craving_intensity',
    value: 7,
    unit: 'score',
    observedAt: '2026-05-01T10:00:00.000Z',
    source: 'self_report',
    platform: 'ios',
  });

  assert.equal(posted.status, 201);
  assert.equal(posted.body.observation.source, 'self_report');
  assert.equal(posted.body.observation.selfReported, true);

  const listed = await harness.request('account-a', 'GET', '/tobacco/observations');
  assert.equal(listed.body.observations[0].selfReported, true);
  // Platform travels with the value: iOS reports aggregate screen time where
  // Android reports per-app, so the same measure means different things.
  assert.equal(listed.body.observations[0].platform, 'ios');
});

test('an observation with no stated source is refused', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.enrol('account-a', 'tobacco');

  const response = await harness.request('account-a', 'POST', '/tobacco/observations', {
    measureId: 'craving_intensity',
    value: 7,
    unit: 'score',
    observedAt: '2026-05-01T10:00:00.000Z',
  });

  assert.equal(response.status, 400);
});
