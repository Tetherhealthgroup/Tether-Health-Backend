import test from 'node:test';
import assert from 'node:assert/strict';
import { keysIn, startHarness } from './support/harness.ts';

/**
 * The consent boundary.
 *
 * `for-clinicians.astro` promises that "revocation is enforced rather than
 * merely recorded", and `per_program_sharing` puts the boundary at the
 * programme rather than the person: "a cessation coach has no business seeing
 * behavioural health data. Under 42 CFR Part 2, substance-use data must be
 * segregated regardless."
 */

const CLINICIAN = 'clinician:11111111-1111-4111-8111-111111111111';
const CLINICIAN_ID = '11111111-1111-4111-8111-111111111111';

void test('the patient list is derived from live consent, and a revocation removes it', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  const consent = harness.world.grant(enrolment.id, 'totals_and_adherence', CLINICIAN_ID);

  const listed = await harness.request(CLINICIAN, 'GET', '/patients');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.programmes.length, 1);
  assert.equal(listed.body.programmes[0].enrolmentId, enrolment.id);

  // Nothing in this response identifies the person, on purpose: an account id
  // would let a clinician join two programmes back into one patient.
  const keys = keysIn(listed.body);
  assert.ok(!keys.has('accountId'));
  assert.ok(!keys.has('account_id'));
  assert.ok(!keys.has('patientId'));

  consent.revokedAt = '2026-05-01T00:00:00.000Z';

  const afterRevocation = await harness.request(CLINICIAN, 'GET', '/patients');
  assert.deepEqual(afterRevocation.body.programmes, []);
});

void test('a revoked consent refuses the read immediately, with 403 consent-required', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  const consent = harness.world.grant(enrolment.id, 'notes', CLINICIAN_ID);
  harness.world.answer(enrolment.id, 'S13', 0, 'text', 'a bad week');

  const allowed = await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);
  assert.equal(allowed.status, 200);

  consent.revokedAt = '2026-05-01T00:00:00.000Z';

  const refused = await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.title, 'consent-required');
  assert.equal(refused.body.detail.includes('per'), true);
  // Nothing about the record leaks through the refusal.
  assert.doesNotMatch(JSON.stringify(refused.body), /bad week/);
});

void test('a refused read is still audited — the attempt is the thing to record', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');

  const refused = await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);
  assert.equal(refused.status, 403);

  // The row has to survive the 403. Written inside the transaction and thrown
  // outside it, or the evidence rolls back with the refusal.
  const event = harness.world.audit.find(
    (row) => row.action === 'care.patient.read.refused',
  );
  assert.ok(event, 'a refused read must leave a trail');
  assert.equal(event.programmeId, enrolment.id);
  assert.deepEqual(event.detail, {
    reason: 'no-live-consent',
    actorAccountId: CLINICIAN_ID,
  });
});

void test('a served read names the enrolment, the scope and the consent id', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  const consent = harness.world.grant(enrolment.id, 'totals_and_adherence', CLINICIAN_ID);

  await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);

  const event = harness.world.audit.find((row) => row.action === 'care.patient.read');
  assert.ok(event);
  assert.equal(event.programmeId, enrolment.id);
  // Filed under the patient, because "who has seen my record" is the question
  // this table exists to answer.
  assert.equal(event.accountId, 'patient-a');
  assert.equal(event.detail.scope, 'totals_and_adherence');
  assert.equal(event.detail.consentId, consent.id);
  assert.equal(event.detail.actorAccountId, CLINICIAN_ID);
});

void test('a totals_and_adherence consent does not leak notes', async (t) => {
  // "A coach seeing a total is a different disclosure from a coach reading a
  // note." Both layers are asserted here: the view never asks for text, and the
  // store returns none if it does.
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  harness.world.grant(enrolment.id, 'totals_and_adherence', CLINICIAN_ID);

  harness.world.answer(enrolment.id, 'S13', 0, 'slider', 70);
  harness.world.answer(enrolment.id, 'S17', 0, 'text', 'I relapsed after the funeral');
  harness.world.lapse(enrolment.id, '2026-04-02T18:00:00.000Z', 'two cigarettes', [
    'grief',
  ]);
  harness.world.observe(enrolment.id, {
    measureId: 'craving_intensity',
    valueNum: 8,
    valueText: null,
    unit: 'score',
    observedAt: '2026-04-02T19:00:00.000Z',
    source: 'self_report',
    platform: 'ios',
  });
  harness.world.observe(enrolment.id, {
    measureId: 'free_note',
    valueNum: null,
    valueText: 'could not sleep',
    unit: 'text',
    observedAt: '2026-04-03T07:00:00.000Z',
    source: 'self_report',
    platform: 'ios',
  });

  const response = await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);
  assert.equal(response.status, 200);
  const serialised = JSON.stringify(response.body);

  // Not one of the person's own words, by any route.
  assert.doesNotMatch(serialised, /funeral/);
  assert.doesNotMatch(serialised, /could not sleep/);
  assert.doesNotMatch(serialised, /two cigarettes/);
  assert.doesNotMatch(serialised, /grief/);

  // The content blocks are absent, not empty: an empty `notes: []` would say
  // there are no notes, and there are.
  assert.equal(response.body.notes, undefined);
  assert.equal(response.body.lapseEvents, undefined);
  assert.equal(response.body.textObservations, undefined);

  // What a totals consent does get: counts, dates, and the numbers.
  assert.equal(response.body.adherence.lapses.recorded, 1);
  assert.equal(response.body.adherence.lapses.byWeek.length, 1);
  assert.equal(response.body.measures[0].measureId, 'craving_intensity');
  assert.equal(response.body.measures[0].latestValue, 8);
  assert.equal(response.body.measures[0].selfReported, true);

  // And the text answer is not even counted, because the consent does not
  // cover it and reporting that it exists is itself a disclosure.
  assert.equal(response.body.adherence.blocksAnswered, 1);
});

void test('a notes consent includes the free text, and says what it was served under', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  const consent = harness.world.grant(enrolment.id, 'notes', CLINICIAN_ID);
  harness.world.answer(enrolment.id, 'S17', 0, 'text', 'I relapsed after the funeral');
  harness.world.lapse(enrolment.id, '2026-04-02T18:00:00.000Z', 'two cigarettes', [
    'grief',
  ]);

  const response = await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);

  assert.equal(response.body.notes.length, 1);
  assert.equal(response.body.notes[0].text, 'I relapsed after the funeral');
  assert.equal(response.body.lapseEvents[0].severity, 'two cigarettes');
  assert.deepEqual(response.body.servedUnder, {
    scope: 'notes',
    consentId: consent.id,
    consentVersion: '2026-01',
    grantedAt: '2026-01-02T00:00:00.000Z',
  });
});

void test('a clinician consented to one programme cannot read another', async (t) => {
  // The same patient, two programmes, one consent. The second must be as
  // unreachable as a stranger's — `per_program_sharing` is about the programme,
  // not the person, and 42 CFR Part 2 makes that non-negotiable for
  // substance-use data.
  const harness = await startHarness();
  t.after(() => harness.close());

  const behavioral = harness.world.enrol('patient-a', 'behavioral');
  const alcohol = harness.world.enrol('patient-a', 'alcohol');
  harness.world.grant(behavioral.id, 'notes', CLINICIAN_ID);
  harness.world.answer(alcohol.id, 'S04', 0, 'text', 'drinking most evenings');

  const permitted = await harness.request(CLINICIAN, 'GET', `/patients/${behavioral.id}`);
  assert.equal(permitted.status, 200);

  const forbidden = await harness.request(CLINICIAN, 'GET', `/patients/${alcohol.id}`);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.title, 'consent-required');
  assert.doesNotMatch(JSON.stringify(forbidden.body), /drinking/);

  // And the listing shows one programme, not two — so the second is not even
  // discoverable, let alone readable.
  const listed = await harness.request(CLINICIAN, 'GET', '/patients');
  assert.equal(listed.body.programmes.length, 1);
  assert.equal(listed.body.programmes[0].areaId, 'behavioral');
});

void test('another clinician\'s consent is not this clinician\'s', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  harness.world.grant(enrolment.id, 'notes', '99999999-9999-4999-8999-999999999999');

  const response = await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);
  assert.equal(response.status, 403);
});

void test('no response carries a risk score, a grade or an interpretation', async (t) => {
  // `no_risk_score`, `no_result_interpretation`, `never_diagnose`. This service
  // returns values and trends; a clinician is what interprets them.
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  harness.world.grant(enrolment.id, 'notes', CLINICIAN_ID);
  harness.world.answer(enrolment.id, 'S17', 0, 'text', 'a hard month');
  harness.world.lapse(enrolment.id, '2026-04-02T18:00:00.000Z', 'a relapse', ['grief']);
  harness.world.observe(enrolment.id, {
    measureId: 'phq9_total',
    valueNum: 19,
    valueText: null,
    unit: 'score',
    observedAt: '2026-04-02T19:00:00.000Z',
    source: 'self_report',
    platform: 'ios',
  });

  const view = await harness.request(CLINICIAN, 'GET', `/patients/${enrolment.id}`);
  const listed = await harness.request(CLINICIAN, 'GET', '/patients');

  const forbidden = [
    'risk',
    'riskScore',
    'riskBand',
    'grade',
    'interpretation',
    'verdict',
    'diagnosis',
    'condition',
    'severityScore',
    'flag',
  ];
  for (const document of [view.body, listed.body]) {
    const keys = keysIn(document);
    for (const key of forbidden) {
      assert.ok(!keys.has(key), `${key} must not appear in a clinician response`);
    }
  }

  // A raw value of 19 on a PHQ-9 is returned. What it means is not.
  assert.equal(view.body.measures[0].latestValue, 19);
});

void test('a caller without the clinician role gets nothing', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  harness.world.grant(enrolment.id, 'notes', 'patient-a');

  // Even the patient, holding a consent naming themselves, comes through the
  // patient surface rather than this one. The role gets a caller through the
  // door; the consent decides what is behind it.
  const response = await harness.request(
    'patient:patient-a',
    'GET',
    `/patients/${enrolment.id}`,
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.title, 'forbidden');
  assert.equal(harness.world.audit.length, 0);
});

void test('readiness is a real check', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const ready = await fetch(`${harness.url}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: 'ready',
    service: 'care-team-service',
  });
});
