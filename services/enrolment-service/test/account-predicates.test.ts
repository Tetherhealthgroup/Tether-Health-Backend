import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertScopedTo,
  recordingTransaction,
} from '../../../packages/core/test/support/recording-tx.ts';
import {
  grantConsent,
  loadActiveProgrammes,
  loadConsents,
  loadEnrolment,
  loadEnrolmentRow,
  loadEnrolments,
  loadPreviewSource,
  revokeLive,
  setHidden,
  setStatus,
} from '../src/repository.ts';

/**
 * R-032: these queries used to rely on the RLS policy alone, and the policy is
 * not enough by itself. `0005_care.sql` lets a *recipient* read an enrolment and
 * its consents, so an account that is both a patient and a clinician would see
 * other people's shared programmes as its own. Every statement below must name
 * the account as well.
 *
 * The statements are recorded, not executed. That they also behave correctly
 * against real policies is `db/test/service-roles.integration.test.ts`.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ENROLMENT = 'aaaaaaaa-0000-4000-8000-000000000001';

/** A row shaped well enough for every mapper these functions run. */
const ROW = {
  id: ENROLMENT,
  areaId: 'tobacco',
  status: 'active',
  hidden: false,
  childProfileId: null,
  joinedOn: new Date('2026-06-01T00:00:00Z'),
  endedAt: null,
};

test('every enrolment read and write names the account', async () => {
  // Enrolment statements get a row; consent statements get none.
  const tx = recordingTransaction((s) =>
    /sharing_consent/.test(s.sql) ? [] : [ROW],
  );

  await loadEnrolments(tx, ACCOUNT);
  await loadEnrolmentRow(tx, ACCOUNT, 'tobacco');
  await loadEnrolment(tx, ACCOUNT, 'tobacco');
  await loadActiveProgrammes(tx, ACCOUNT);
  await setStatus(tx, ACCOUNT, 'tobacco', 'paused');
  await setHidden(tx, ACCOUNT, 'tobacco', true);

  const enrolmentStatements = tx.statements.filter((s) =>
    /FROM programme\.enrolment|UPDATE programme\.enrolment/.test(s.sql) &&
    !/sharing_consent/.test(s.sql),
  );
  assert.ok(enrolmentStatements.length >= 6, 'expected one statement per call');

  for (const statement of enrolmentStatements) {
    assertScopedTo(statement, 'account_id', ACCOUNT);
  }
});

test('consent reads, grants and revocations are scoped to the owner of the enrolment', async () => {
  const tx = recordingTransaction([]);

  await loadConsents(tx, ACCOUNT, ENROLMENT);
  await revokeLive(tx, ACCOUNT, {
    enrolmentId: ENROLMENT,
    scope: 'notes',
    recipientKind: 'care_team',
    recipientId: null,
  });

  assert.equal(tx.statements.length, 2);
  for (const statement of tx.statements) {
    assert.match(statement.sql, /programme\.sharing_consent/);
    assertScopedTo(statement, 'own.account_id', ACCOUNT);
  }
});

test('a grant is written only against an enrolment the account owns', async () => {
  const consentRow = {
    id: 'cccccccc-0000-4000-8000-000000000001',
    enrolmentId: ENROLMENT,
    scope: 'notes',
    recipientKind: 'care_team',
    recipientId: null,
    consentVersion: 'v1',
    consentText: 'synthetic wording',
    grantedAt: new Date('2026-06-01T00:00:00Z'),
    revokedAt: null,
  };
  // The lookup for an existing live grant finds nothing; the insert returns the row.
  const tx = recordingTransaction((s) =>
    /^\s*INSERT/.test(s.sql) ? [consentRow] : [],
  );

  const result = await grantConsent(tx, ACCOUNT, {
    enrolmentId: ENROLMENT,
    scope: 'notes',
    recipientKind: 'care_team',
    recipientId: null,
    consentVersion: 'v1',
    consentText: 'synthetic wording',
  });
  assert.equal(result.created, true);

  const lookup = tx.statements.find((s) => /^\s*SELECT/.test(s.sql));
  const insert = tx.statements.find((s) => /^\s*INSERT/.test(s.sql));
  assert.ok(lookup && insert);
  assertScopedTo(lookup, 'own.account_id', ACCOUNT, 'consent lookup');
  // The insert reads from the enrolment, filtered to the account, so it yields
  // nothing for an enrolment that is somebody else's.
  assert.match(insert.sql, /FROM programme\.enrolment e\s+WHERE e\.id = \$1 AND e\.account_id = \$7/);
  assert.equal(insert.params[6], ACCOUNT);
});

test('a grant against an enrolment that is not the account\'s fails rather than succeeding quietly', async () => {
  const tx = recordingTransaction([]);
  await assert.rejects(
    grantConsent(tx, ACCOUNT, {
      enrolmentId: ENROLMENT,
      scope: 'notes',
      recipientKind: 'care_team',
      recipientId: null,
      consentVersion: 'v1',
      consentText: 'synthetic wording',
    }),
    /consent insert returned no row/,
  );
});

test('the share preview reads only the account\'s own record', async () => {
  const tx = recordingTransaction([]);

  await loadPreviewSource(
    tx,
    ACCOUNT,
    {
      id: ENROLMENT,
      areaId: 'tobacco',
      status: 'active',
      hidden: false,
      childProfileId: null,
      joinedOn: '2026-06-01T00:00:00Z',
      endedAt: null,
    },
    'Tobacco',
  );

  const recordReads = tx.statements.filter((s) => /FROM record\./.test(s.sql));
  assert.equal(recordReads.length, 4, 'observation, answer count, lapse, notes');
  for (const statement of recordReads) {
    assertScopedTo(statement, 'own.account_id', ACCOUNT);
  }
});
