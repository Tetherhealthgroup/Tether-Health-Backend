import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertScopedTo,
  recordingTransaction,
} from '../../../packages/core/test/support/recording-tx.ts';
import { createPostgresStore } from '../src/postgres-store.ts';
import type { StoreContext } from '../src/store.ts';

/**
 * R-032: every statement that reads a patient's record on a clinician's behalf
 * must name the clinician's live consent itself.
 *
 * Leaning on the policy alone was wrong because the policies are OR'd: a
 * clinician who is also a patient reads their own enrolment through the `*_own`
 * policy, and a statement with no consent predicate of its own would serve that
 * as a shared record. These tests record the statements; the behaviour against
 * the real policies is `db/test/service-roles.integration.test.ts`.
 */

const CLINICIAN = '33333333-3333-4333-8333-333333333333';
const ENROLMENT = 'aaaaaaaa-0000-4000-8000-000000000001';

const store = createPostgresStore();

function context() {
  const tx = recordingTransaction([]);
  const ctx: StoreContext = { tx, clinicianId: CLINICIAN };
  return { tx, ctx };
}

test('every read of a shared record names the clinician', async () => {
  const { tx, ctx } = context();

  await store.enrolment(ctx, ENROLMENT);
  await store.adherence(ctx, ENROLMENT, new Date('2026-06-01T00:00:00Z'));
  await store.measureSummaries(ctx, ENROLMENT);
  await store.escalations(ctx, ENROLMENT);

  assert.ok(tx.statements.length >= 6);
  for (const statement of tx.statements) {
    assertScopedTo(statement, 'consent.recipient_id', CLINICIAN);
    assert.match(statement.sql, /consent\.revoked_at IS NULL/);
  }
});

test('free text is read only under a notes consent', async () => {
  const { tx, ctx } = context();

  await store.notes(ctx, ENROLMENT);
  await store.textObservations(ctx, ENROLMENT);

  assert.equal(tx.statements.length, 2);
  for (const statement of tx.statements) {
    assertScopedTo(statement, 'consent.recipient_id', CLINICIAN);
    assert.match(statement.sql, /consent\.scope = 'notes'/);
  }
});

test('a lapse\'s severity and context come only through the notes-scoped function', async () => {
  const { tx, ctx } = context();

  await store.lapseEvents(ctx, ENROLMENT);

  const [statement] = tx.statements;
  assert.ok(statement);
  assert.match(statement.sql, /FROM care\.lapse_details\(\$1\)/);
  // Not a direct read of the table: this role may select a lapse's date and
  // nothing else from it, so a direct read would be refused by the database.
  assert.doesNotMatch(statement.sql, /FROM record\.lapse_event/);
});

test('an escalation is inserted from the clinician\'s own live consent', async () => {
  const { tx, ctx } = context();

  await assert.rejects(
    store.raiseEscalation(ctx, {
      enrolmentId: ENROLMENT,
      consentId: 'cccccccc-0000-4000-8000-000000000001',
      signal: 'synthetic signal',
      detail: null,
      policy: {
        areaId: 'tobacco',
        version: '1',
        recipientKind: 'clinician',
        contact: 'rota',
        crisisContact: null,
        acknowledgeWithinMinutes: 60,
        configuredBy: 'lead',
        configuredAt: '2026-06-01T00:00:00Z',
        effectiveFrom: '2026-06-01T00:00:00Z',
        notes: null,
      },
    }),
    /escalation insert returned no row/,
  );

  const [insert] = tx.statements;
  assert.ok(insert);
  assert.match(insert.sql, /FROM programme\.sharing_consent c/);
  assertScopedTo(insert, 'c.recipient_id', CLINICIAN);
  assert.match(insert.sql, /c\.id = \$3/);
  assert.match(insert.sql, /c\.enrolment_id = \$1/);
  assert.match(insert.sql, /c\.revoked_at IS NULL/);
  // Raised by the caller, whatever the request said.
  assert.equal(insert.params[1], CLINICIAN);
});

test('the shared list and the live-consent lookup were already scoped, and stay so', async () => {
  const { tx, ctx } = context();

  await store.sharedProgrammes(ctx);
  await store.liveConsentsFor(ctx, ENROLMENT);

  assert.equal(tx.statements.length, 2);
  for (const statement of tx.statements) {
    assertScopedTo(statement, 'recipient_id', CLINICIAN);
  }
});
