import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './support/harness.ts';

/**
 * `distress_escalation`: "A distress signal never terminates at a non-clinical
 * coach. Routing is configured per program by clinical leadership."
 *
 * The safeguard's `requires` list names `escalation_policy_ref`, which is why
 * routing is a row rather than a branch — clinical leadership can configure a
 * table and cannot configure a `switch` statement.
 */

const CLINICIAN = 'clinician:11111111-1111-4111-8111-111111111111';
const CLINICIAN_ID = '11111111-1111-4111-8111-111111111111';

test('a programme with no configured policy cannot accept an escalation', async (t) => {
  // The tempting fallback — route it to the recipient on the consent, or to
  // whoever is nearest — is the exact failure the safeguard names, because the
  // nearest recipient in a cessation programme is a coach. Refusing is visible;
  // accepting would be a signal that looks delivered and is not.
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'tobacco');
  harness.world.grant(enrolment.id, 'notes', CLINICIAN_ID);

  const response = await harness.request(CLINICIAN, 'POST', '/escalations', {
    enrolmentId: enrolment.id,
    signal: 'expressed hopelessness',
    detail: 'said there was no point continuing',
  });

  assert.equal(response.status, 409);
  assert.match(response.body.detail, /no escalation policy configured/);
  assert.match(response.body.detail, /clinical leadership/);
  assert.equal(harness.world.escalations.length, 0);

  // The refusal is recorded. A distress signal that was raised and not accepted
  // is precisely the event somebody will need to find afterwards.
  const event = harness.world.audit.find(
    (row) => row.action === 'care.escalation.refused',
  );
  assert.ok(event);
  assert.equal(event.detail.reason, 'no-escalation-policy');
  assert.equal(event.detail.areaId, 'tobacco');
});

test('a configured policy routes the signal and snapshots where it went', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  const consent = harness.world.grant(enrolment.id, 'notes', CLINICIAN_ID);
  harness.world.policy('behavioral', {
    version: '2026.2',
    recipientKind: 'clinician',
    contact: 'duty-psychiatrist',
    acknowledgeWithinMinutes: 30,
  });

  const response = await harness.request(CLINICIAN, 'POST', '/escalations', {
    enrolmentId: enrolment.id,
    signal: 'expressed hopelessness',
    detail: 'said there was no point continuing',
  });

  assert.equal(response.status, 201);
  const escalation = response.body.escalation;
  assert.equal(escalation.routedToKind, 'clinician');
  assert.equal(escalation.routedTo, 'duty-psychiatrist');
  assert.equal(escalation.policyVersion, '2026.2');
  // Copied onto the row rather than referenced: where a signal went is a
  // historical fact, and a policy edited next month must not rewrite it.
  assert.equal(escalation.policyAreaId, 'behavioral');
  assert.equal(escalation.acknowledgeBy, '2026-06-01T12:30:00.000Z');

  const event = harness.world.audit.find(
    (row) => row.action === 'care.escalation.raised',
  );
  assert.ok(event);
  assert.equal(event.accountId, 'patient-a');
  assert.equal(event.detail.consentId, consent.id);
  assert.equal(event.detail.routedToKind, 'clinician');
});

test('an escalation needs a live consent, like every other read', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  harness.world.policy('behavioral');

  const response = await harness.request(CLINICIAN, 'POST', '/escalations', {
    enrolmentId: enrolment.id,
    signal: 'expressed hopelessness',
    detail: null,
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.title, 'consent-required');
  assert.equal(harness.world.escalations.length, 0);
  assert.ok(
    harness.world.audit.some((row) => row.action === 'care.escalation.refused'),
  );
});

test('a revoked consent stops an escalation being raised at all', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  const consent = harness.world.grant(enrolment.id, 'notes', CLINICIAN_ID);
  harness.world.policy('behavioral');

  consent.revokedAt = '2026-05-01T00:00:00.000Z';

  const response = await harness.request(CLINICIAN, 'POST', '/escalations', {
    enrolmentId: enrolment.id,
    signal: 'expressed hopelessness',
    detail: null,
  });

  assert.equal(response.status, 403);
  assert.equal(harness.world.escalations.length, 0);
});

test('an escalation cannot carry a risk score by any name', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  harness.world.grant(enrolment.id, 'notes', CLINICIAN_ID);
  harness.world.policy('behavioral');

  const response = await harness.request(CLINICIAN, 'POST', '/escalations', {
    enrolmentId: enrolment.id,
    signal: 'expressed hopelessness',
    detail: null,
    riskScore: 9,
  });

  // `.strict()` on the schema. There is nowhere to put a score, which is how
  // `no_risk_score` is honoured rather than remembered.
  assert.equal(response.status, 400);
  assert.equal(harness.world.escalations.length, 0);
});

test('the routing policy is readable, so a clinician knows where a signal goes', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  harness.world.policy('behavioral', { crisisContact: '988' });

  const response = await harness.request(
    CLINICIAN,
    'GET',
    '/escalation-policy/behavioral',
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.policy.areaId, 'behavioral');
  assert.equal(response.body.policy.configuredBy, 'Dr A. Clinical-Lead');
  // `crisis_routing_first`: the crisis route is held beside the ordinary one so
  // it survives a change to it, and is never reordered or collapsed away.
  assert.equal(response.body.policy.crisisContact, '988');
});

test('an unconfigured programme reports that it is unconfigured', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const response = await harness.request(CLINICIAN, 'GET', '/escalation-policy/tobacco');
  assert.equal(response.status, 404);
  assert.match(response.body.detail, /no escalation policy configured/);
});

test('a non-clinician cannot raise an escalation', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());
  const enrolment = harness.world.enrol('patient-a', 'behavioral');
  harness.world.grant(enrolment.id, 'notes', 'patient-a');
  harness.world.policy('behavioral');

  const response = await harness.request('patient:patient-a', 'POST', '/escalations', {
    enrolmentId: enrolment.id,
    signal: 'expressed hopelessness',
    detail: null,
  });

  assert.equal(response.status, 403);
  assert.equal(harness.world.escalations.length, 0);
});
