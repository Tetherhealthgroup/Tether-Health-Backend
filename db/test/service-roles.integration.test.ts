import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '@tether/core';
import { upsertAccount, deleteAccount, findAccount } from '../../services/auth-service/src/accounts.ts';
import { createSessionStore } from '../../services/auth-service/src/store.ts';
import { createPostgresStore as createCareStore } from '../../services/care-team-service/src/postgres-store.ts';
import { writeAudit as writeCareAudit } from '../../services/care-team-service/src/audit.ts';
import { loadAreas, loadBundle } from '../../services/catalogue-service/src/repository.ts';
import {
  createCondition,
  createMedication,
  createVital,
  deleteMedication,
  getProfile,
  listMedications,
  listVitals,
  upsertProfile,
} from '../../services/chronic-service/src/store.ts';
import {
  grantConsent,
  insertEnrolment,
  loadActiveCeiling,
  loadActiveProgrammes,
  loadArea,
  loadConsents,
  loadEnrolmentRow,
  loadEnrolments,
  loadPreviewSource,
  revokeLive,
  setHidden,
  setStatus,
} from '../../services/enrolment-service/src/repository.ts';
import {
  readPreference,
  recordDelivery,
  registerDevice,
  removeDevice,
  setPreference,
  tokensFor,
} from '../../services/notification-service/src/store.ts';
import { holdsLiveConsent, resolveAllowlist } from '../../services/realtime-service/src/allowlist.ts';
import {
  dispatch,
  parseNotification,
  type ChangeNotification,
  type Subscriber,
} from '../../services/realtime-service/src/subscriptions.ts';
import { createPostgresStore as createRecordsStore } from '../../services/records-service/src/postgres-store.ts';
import { writeAudit as writeRecordsAudit } from '../../services/records-service/src/audit.ts';
import { deleteEnquiry, purgeExpired, recordEnquiry } from '../../services/website-service/src/waitlist.ts';
import {
  PRE_EXISTING,
  SERVICES,
  groupRole,
  loginRole,
  startPostgres,
  type Service,
  type TestPostgres,
} from './support/postgres.ts';

/**
 * R-032 and R-033, against a real PostgreSQL.
 *
 * Every migration is applied to a disposable database and then each assertion is
 * made *as the service's own login role*, through the same `createDatabase` and
 * the same repository code the service runs. What this establishes, and what
 * nothing else in the repository can:
 *
 *   - the roles are not superusers and do not bypass RLS, and own nothing;
 *   - each role holds exactly the privileges its service's SQL needs (the matrix
 *     below is written independently of the migration and compared to it);
 *   - with those roles, row-level security really does stop one account reading,
 *     changing or deleting another's rows — including when a query forgets its
 *     predicate — and the policies that were unevaluable under a superuser
 *     (the enrolment/consent recursion) now run;
 *   - a clinician sees what their live consent covers and nothing wider;
 *   - the realtime stream's allow-list and fan-out deliver to the owner and the
 *     recipient of an enrolment and to nobody else.
 *
 * Skipped, with the reason shown, when there is no Docker. A skip is not a pass.
 * Synthetic data only.
 */

const started = await startPostgres();

if ('skip' in started) {
  void test('service-role integration suite', { skip: `NOT RUN: ${started.skip}` }, () => {});
} else {
  registerSuite(started.postgres);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const A = '11111111-1111-4111-8111-111111111111'; // a patient
const B = '22222222-2222-4222-8222-222222222222'; // another patient
const CLIN = '33333333-3333-4333-8333-333333333333'; // a clinician, who is also a patient
const CLIN2 = '44444444-4444-4444-8444-444444444444'; // a second clinician
const STRANGER = '55555555-5555-4555-8555-555555555555'; // an account with no shares

const ENR_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ENR_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const ENR_C = 'cccccccc-0000-4000-8000-000000000001';

const CONSENT_CLIN_TOTALS = 'c0000000-0000-4000-8000-000000000001'; // A -> CLIN, totals
const CONSENT_CLIN2_NOTES = 'c0000000-0000-4000-8000-000000000002'; // A -> CLIN2, notes
const CONSENT_B_CLIN_REVOKED = 'c0000000-0000-4000-8000-000000000003'; // B -> CLIN, revoked

const COND_A = 'd0000000-0000-4000-8000-00000000000a';
const COND_B = 'd0000000-0000-4000-8000-00000000000b';
const MED_B = 'e0000000-0000-4000-8000-00000000000b';

type Row = Record<string, unknown>;

async function seed(pg: TestPostgres): Promise<void> {
  await pg.admin(
    `TRUNCATE identity.account, ops.audit_event, ops.waitlist_enquiry RESTART IDENTITY CASCADE`,
  );
  await pg.admin(`
    INSERT INTO catalogue.area (id, name, scope, status, position) VALUES
      ('tobacco', 'Tobacco', 'synthetic', 'in_development', 1),
      ('alcohol', 'Alcohol', 'synthetic', 'in_development', 2),
      ('sleep', 'Sleep', 'synthetic', 'in_development', 3)
      ON CONFLICT DO NOTHING;
    INSERT INTO catalogue.product (id, name, area_id, status)
      VALUES ('breathefree', 'Synthetic product', 'tobacco', 'in_development')
      ON CONFLICT DO NOTHING;
    UPDATE catalogue.area SET product_id = 'breathefree';
    INSERT INTO catalogue.measure (id, area_id, label, unit)
      VALUES ('craving_intensity', 'tobacco', 'Craving', 'score')
      ON CONFLICT DO NOTHING;
    INSERT INTO catalogue.shell_rule (id, rule, why)
      VALUES ('two_active_max', 'At most 2 active programmes', 'synthetic')
      ON CONFLICT DO NOTHING;
    INSERT INTO care.escalation_policy
      (area_id, version, clinical_recipient_kind, clinical_contact, acknowledge_within_minutes, configured_by)
      VALUES ('tobacco', '1', 'clinician', 'rota', 60, 'synthetic lead')
      ON CONFLICT DO NOTHING;

    INSERT INTO identity.account (id, external_id, email) VALUES
      ('${A}', 'ext-a', 'a@example.test'),
      ('${B}', 'ext-b', 'b@example.test'),
      ('${CLIN}', 'ext-clin', 'clin@example.test'),
      ('${CLIN2}', 'ext-clin2', 'clin2@example.test'),
      ('${STRANGER}', 'ext-stranger', 'stranger@example.test');

    INSERT INTO programme.enrolment (id, account_id, area_id) VALUES
      ('${ENR_A}', '${A}', 'tobacco'),
      ('${ENR_B}', '${B}', 'tobacco'),
      ('${ENR_C}', '${CLIN}', 'tobacco');

    INSERT INTO programme.sharing_consent
      (id, enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text, revoked_at) VALUES
      ('${CONSENT_CLIN_TOTALS}', '${ENR_A}', 'totals_and_adherence', 'care_team', '${CLIN}', 'v1', 'synthetic wording', NULL),
      ('${CONSENT_CLIN2_NOTES}', '${ENR_A}', 'notes', 'care_team', '${CLIN2}', 'v1', 'synthetic wording', NULL),
      ('${CONSENT_B_CLIN_REVOKED}', '${ENR_B}', 'notes', 'care_team', '${CLIN}', 'v1', 'synthetic wording', now());

    INSERT INTO record.observation
      (enrolment_id, measure_id, value_num, value_text, unit, observed_at) VALUES
      ('${ENR_A}', 'craving_intensity', 7, NULL, 'score', '2026-06-01T08:00:00Z'),
      ('${ENR_A}', 'craving_intensity', NULL, 'synthetic private words', 'score', '2026-06-02T08:00:00Z'),
      ('${ENR_B}', 'craving_intensity', 3, NULL, 'score', '2026-06-01T08:00:00Z'),
      ('${ENR_C}', 'craving_intensity', 5, NULL, 'score', '2026-06-01T08:00:00Z');
    INSERT INTO record.screen_answer (enrolment_id, screen_id, block_index, kind, value) VALUES
      ('${ENR_A}', 'S01', 0, 'chips', '[1,2]'),
      ('${ENR_A}', 'S01', 1, 'text', '"synthetic private words"'),
      ('${ENR_B}', 'S01', 0, 'chips', '[3]'),
      ('${ENR_C}', 'S01', 0, 'chips', '[4]');
    INSERT INTO record.lapse_event (enrolment_id, occurred_at, severity, context) VALUES
      ('${ENR_A}', '2026-06-03T08:00:00Z', 'synthetic-severity', '{synthetic-context}'),
      ('${ENR_B}', '2026-06-03T08:00:00Z', 'synthetic-severity-b', '{synthetic-context-b}');

    INSERT INTO chronic.profile (id, account_id) VALUES
      ('f0000000-0000-4000-8000-00000000000a', '${A}'),
      ('f0000000-0000-4000-8000-00000000000b', '${B}');
    INSERT INTO chronic.condition (id, profile_id, kind) VALUES
      ('${COND_A}', 'f0000000-0000-4000-8000-00000000000a', 'diabetes'),
      ('${COND_B}', 'f0000000-0000-4000-8000-00000000000b', 'asthma');
    INSERT INTO chronic.vital_entry (condition_id, metric_key, label, value, unit, observed_at) VALUES
      ('${COND_A}', 'k_a', 'A reading', 1, 'u', '2026-06-01T08:00:00Z'),
      ('${COND_B}', 'k_b', 'B reading', 2, 'u', '2026-06-01T08:00:00Z');
    INSERT INTO chronic.medication (id, profile_id, name) VALUES
      ('${MED_B}', 'f0000000-0000-4000-8000-00000000000b', 'synthetic drug B'),
      ('e0000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000a', 'synthetic drug A');

    INSERT INTO ops.device_token (account_id, token, platform) VALUES
      ('${A}', 'token-a', 'android'),
      ('${B}', 'token-b', 'android');
    INSERT INTO ops.audit_event (account_id, actor_role, action, resource_type) VALUES
      ('${A}', 'patient', 'synthetic.a', 'x'),
      ('${B}', 'patient', 'synthetic.b', 'x');
    INSERT INTO ops.waitlist_enquiry (id, name, email) VALUES
      ('99999999-9999-4999-8999-999999999999', 'Synthetic Person', 'enquirer@example.test');
  `);
}

/** The SQLSTATE a statement fails with, or null when it succeeds. */
async function failsWith(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? `no-code: ${(error as Error).message}`;
  }
}

const PERMISSION_DENIED = '42501';

/**
 * A probe holding every privilege, so that the only thing between it and a row is
 * a policy. It is a member of `tether_care_team` because the recipient policies
 * are `TO tether_care_team`: a probe that was not would never see them apply.
 * Created here, never by a migration.
 */
const PROBE_SQL = `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_probe') THEN CREATE ROLE rls_probe NOLOGIN IN ROLE tether_care_team; END IF; END $$`;

const ids = (rows: readonly Row[], column = 'id'): string[] =>
  rows.map((row) => String(row[column])).sort();

const count = async (pg: TestPostgres, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await pg.admin<{ n: string | number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params))[0]?.n);

// ---------------------------------------------------------------------------
// The privilege matrix, written independently of the migration
// ---------------------------------------------------------------------------

/**
 * What each service's login role is meant to hold, and nothing else.
 *
 * `VERB` is table-wide; `VERB(a,b)` is those columns only. Anything not listed
 * is expected to be denied — on every table and every column in every schema —
 * so a grant that is added without being added here fails this test, as does a
 * grant that goes missing.
 */
const MATRIX: Record<Service, Record<string, string[]>> = {
  auth: {
    'identity.account': ['SELECT', 'DELETE', 'INSERT(external_id,email,last_seen_at)', 'UPDATE(email,last_seen_at)'],
    'identity.refresh_session': [
      'SELECT',
      'INSERT(account_id,family_id,token_hash,issued_at,expires_at,user_agent,ip)',
      'UPDATE(revoked_at,revoked_reason)',
    ],
    'ops.audit_event': ['INSERT'],
  },
  catalogue: Object.fromEntries(
    [
      'area', 'service_line', 'measure', 'safeguard', 'area_safeguard',
      'shell_rule', 'archetype', 'product', 'product_screen', 'screen_content',
    ].map((table) => [`catalogue.${table}`, ['SELECT']]),
  ),
  enrolment: {
    'programme.enrolment': ['SELECT', 'INSERT(account_id,area_id,status)', 'UPDATE(status,ended_at,hidden)'],
    'programme.sharing_consent': [
      'SELECT',
      'INSERT(enrolment_id,scope,recipient_kind,recipient_id,consent_version,consent_text)',
      'UPDATE(revoked_at)',
    ],
    'record.observation': ['SELECT'],
    'record.screen_answer': ['SELECT'],
    'record.lapse_event': ['SELECT'],
    'catalogue.shell_rule': ['SELECT(id,rule)'],
    'catalogue.area': ['SELECT(id,name,product_id)'],
    'catalogue.measure': ['SELECT(id,label)'],
    'ops.audit_event': ['INSERT'],
  },
  records: {
    'programme.enrolment': ['SELECT', 'DELETE'],
    'programme.sharing_consent': ['SELECT', 'DELETE'],
    'record.screen_answer': ['SELECT', 'DELETE', 'INSERT(enrolment_id,screen_id,block_index,kind,value)', 'UPDATE(kind,value)'],
    'record.lapse_event': ['SELECT', 'DELETE', 'INSERT(enrolment_id,occurred_at,severity,context)'],
    'record.observation': [
      'SELECT', 'DELETE',
      'INSERT(enrolment_id,measure_id,value_num,value_text,unit,observed_at,source,platform)',
    ],
    'catalogue.area': ['SELECT(id,name)'],
    'ops.audit_event': ['SELECT', 'INSERT'],
  },
  care_team: {
    'programme.sharing_consent': [
      'SELECT(id,enrolment_id,scope,recipient_kind,recipient_id,consent_version,granted_at,revoked_at)',
    ],
    'programme.enrolment': ['SELECT(id,account_id,area_id,status,joined_on)'],
    'record.screen_answer': ['SELECT(id,enrolment_id,screen_id,block_index,kind,value,answered_at)'],
    'record.lapse_event': ['SELECT(id,enrolment_id,occurred_at)'],
    'record.observation': [
      'SELECT(id,enrolment_id,measure_id,value_num,value_text,unit,observed_at,source,platform)',
    ],
    'care.escalation_policy': ['SELECT'],
    'care.escalation': [
      'SELECT',
      'INSERT(enrolment_id,raised_by,consent_id,signal,detail,policy_area_id,policy_version,routed_to_kind,routed_to,acknowledge_by)',
    ],
    'ops.audit_event': ['INSERT'],
  },
  notification: {
    'ops.device_token': ['SELECT', 'DELETE', 'INSERT(account_id,token,platform,area_id)', 'UPDATE(account_id,platform,area_id,last_seen_at)'],
    'ops.notification_preference': [
      'SELECT',
      'INSERT(account_id,specific_content,opted_in_at,consent_text)',
      'UPDATE(specific_content,opted_in_at,consent_text)',
    ],
    'ops.notification_log': ['INSERT(account_id,kind,variant,device_count,delivered_count,failed_count,provider)'],
  },
  website: {
    'ops.waitlist_enquiry': ['SELECT(id,email,received_at,purge_after)', 'INSERT(name,email,role,interest,message,source)', 'DELETE'],
    'ops.audit_event': ['INSERT'],
  },
  chronic: {
    'chronic.profile': ['SELECT', 'INSERT(account_id)', 'UPDATE(display_name,avatar_emoji,dob,health_score)'],
    'chronic.condition': [
      'SELECT',
      'INSERT(profile_id,kind,status,goal_value,goal_unit,diagnosed_at)',
      'UPDATE(status,goal_value,goal_unit,diagnosed_at)',
    ],
    'chronic.vital_entry': ['SELECT', 'INSERT(condition_id,metric_key,label,value,unit,note,observed_at,source)'],
    'chronic.medication': [
      'SELECT', 'DELETE',
      'INSERT(profile_id,condition_id,name,dosage,schedule,times,reminders_enabled,last_taken_at,active)',
    ],
  },
  realtime: {
    'programme.enrolment': ['SELECT(id,account_id)'],
    'programme.sharing_consent': ['SELECT(enrolment_id,recipient_id,revoked_at)'],
  },
};

const SCHEMA_USAGE: Record<Service, string[]> = {
  auth: ['identity', 'ops'],
  catalogue: ['catalogue'],
  enrolment: ['programme', 'record', 'catalogue', 'ops'],
  records: ['programme', 'record', 'catalogue', 'ops'],
  care_team: ['programme', 'record', 'care', 'ops'],
  notification: ['ops'],
  website: ['ops'],
  chronic: ['chronic'],
  realtime: ['programme'],
};

const OUR_SCHEMAS = ['identity', 'catalogue', 'programme', 'record', 'care', 'chronic', 'ops'];

type Verb = 'SELECT' | 'INSERT' | 'UPDATE';

/** Expands a clause list into the effective privilege on one column. */
function allows(clauses: string[] | undefined, verb: Verb | 'DELETE', column: string | null): boolean {
  for (const clause of clauses ?? []) {
    const [, name = '', cols] = /^([A-Z]+)(?:\((.*)\))?$/.exec(clause) ?? [];
    if (name !== verb) continue;
    if (cols === undefined) return true; // table-wide
    if (column !== null && cols.split(',').includes(column)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

function registerSuite(pg: TestPostgres): void {
  after(async () => {
    await pg.stop();
  });

  // The database as it is when it is first migrated, before any operator step.
  void test(`[setup] ${pg.description}`, async () => {
    const [row] = await pg.admin<{ version: string }>('SELECT version() AS version');
    assert.ok(row?.version, 'the server did not answer');
  });

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  void test('the roles are exactly the eighteen intended, none of them a superuser, none bypassing RLS', async () => {
    const roles = await pg.admin<Row>(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
              rolreplication, rolinherit, rolconnlimit
         FROM pg_roles WHERE rolname LIKE 'tether\\_%' ORDER BY rolname`,
    );

    const expected = SERVICES.flatMap((s) => [groupRole(s), loginRole(s)]).sort();
    assert.deepEqual(roles.map((r) => r.rolname), expected, 'unexpected or missing tether_ roles');

    for (const role of roles) {
      const name = String(role.rolname);
      assert.equal(role.rolsuper, false, `${name} is a superuser`);
      assert.equal(role.rolbypassrls, false, `${name} bypasses row-level security`);
      assert.equal(role.rolcreatedb, false, `${name} can create databases`);
      assert.equal(role.rolcreaterole, false, `${name} can create roles`);
      assert.equal(role.rolreplication, false, `${name} can replicate`);
      assert.equal(role.rolcanlogin, name.endsWith('_login'), `${name}: LOGIN is on the wrong role`);
    }
  });

  void test('each login role is a member of its own group and of nothing else', async () => {
    for (const service of SERVICES) {
      const memberships = await pg.admin<{ role: string }>(
        `SELECT g.rolname AS role
           FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.member
           JOIN pg_roles g ON g.oid = m.roleid
          WHERE r.rolname = $1`,
        [loginRole(service)],
      );
      assert.deepEqual(memberships.map((m) => m.role), [groupRole(service)], loginRole(service));
    }

    const groupsInGroups = await pg.admin(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname LIKE 'tether\\_%' AND r.rolname NOT LIKE '%\\_login'`,
    );
    assert.equal(groupsInGroups.length, 0, 'a group role is a member of another role');
  });

  void test('no service role owns a schema, relation, function or type', async () => {
    const owned = await pg.admin<{ what: string }>(
      `SELECT 'relation ' || c.relname AS what FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname LIKE 'tether\\_%'
       UNION ALL SELECT 'schema ' || n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname LIKE 'tether\\_%'
       UNION ALL SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE r.rolname LIKE 'tether\\_%'
       UNION ALL SELECT 'type ' || t.typname FROM pg_type t JOIN pg_roles r ON r.oid = t.typowner WHERE r.rolname LIKE 'tether\\_%'`,
    );
    assert.deepEqual(owned, [], 'an owner is exempt from non-FORCEd RLS and can change its own grants');
  });

  void test('the login roles are created locked, with no password and no way in until an operator acts', async () => {
    const roles = await pg.admin<{ rolname: string; valid_until: string; has_password: boolean }>(
      `SELECT r.rolname, r.rolvaliduntil::text AS valid_until, (a.rolpassword IS NOT NULL) AS has_password
         FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid
        WHERE r.rolname LIKE 'tether\\_%\\_login'`,
    );
    assert.equal(roles.length, SERVICES.length);
    for (const role of roles) {
      assert.equal(role.has_password, false, `${role.rolname} shipped with a password`);
      assert.equal(role.valid_until, '-infinity', `${role.rolname} is not locked`);
    }
  });

  void test('a locked role cannot connect even once it has a password; unlocking it is what db/ROLES.md says', { skip: pg.canLogin ? false : 'NOT RUN: this driver switches role in one session and cannot authenticate' }, async () => {
    // The operator sets a password but forgets VALID UNTIL: still no way in.
    await pg.setPasswordOnly('catalogue');
    assert.equal(await pg.canConnectAs('catalogue'), false, 'connected while locked');

    await pg.unlockLoginRoles();
    for (const service of SERVICES) {
      assert.equal(await pg.canConnectAs(service), true, `${service} could not connect once unlocked`);
    }
  });

  void test('the service roles can connect and are not superusers once connected', async () => {
    await pg.unlockLoginRoles();
    for (const service of SERVICES) {
      const rows = await pg.databaseFor(service).withoutPrincipal((tx) =>
        tx.query<{ u: string; su: string; bypass: boolean }>(
          `SELECT current_user AS u,
                  current_setting('is_superuser') AS su,
                  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
        ),
      );
      assert.equal(rows[0]?.u, loginRole(service));
      assert.equal(rows[0]?.su, 'off', `${service} is connected as a superuser`);
      assert.equal(rows[0]?.bypass, false, `${service} bypasses RLS`);
    }
  });

  // -------------------------------------------------------------------------
  // RLS is on, and forced, everywhere it should be
  // -------------------------------------------------------------------------

  void test('every table that holds or gates personal data has RLS enabled, forced, and a policy', async () => {
    const unprotected = await pg.admin<{ t: string; problem: string }>(
      `SELECT n.nspname || '.' || c.relname AS t,
              CASE WHEN NOT c.relrowsecurity THEN 'not enabled'
                   WHEN NOT c.relforcerowsecurity THEN 'not forced'
                   ELSE 'no policy' END AS problem
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname IN ('identity','programme','record','care','chronic','ops')
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
               OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))`,
    );
    assert.deepEqual(unprotected, [], 'tables without enabled+forced RLS and a policy');
  });

  // -------------------------------------------------------------------------
  // Grants: least privilege, compared with an independent statement of it
  // -------------------------------------------------------------------------

  void test('the privilege matrix: every role holds exactly what its service uses, on every table and column', async () => {
    const columns = await pg.admin<{ t: string; c: string }>(
      `SELECT n.nspname || '.' || cl.relname AS t, a.attname AS c
         FROM pg_attribute a
         JOIN pg_class cl ON cl.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE cl.relkind = 'r' AND n.nspname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2`,
      [OUR_SCHEMAS],
    );
    const tables = [...new Set(columns.map((row) => row.t))];

    const mismatches: string[] = [];
    for (const service of SERVICES) {
      const role = loginRole(service);
      const spec = MATRIX[service];

      // One round trip per role: every (table, column, verb) the server will
      // actually allow, as the role itself would be judged.
      const effective = await pg.admin<{ t: string; c: string | null; verb: string; ok: boolean }>(
        `SELECT t.t, NULL AS c, v.verb, has_table_privilege($1, t.t, v.verb) AS ok
           FROM unnest($2::text[]) AS t(t)
           CROSS JOIN unnest(ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS v(verb)
         UNION ALL
         SELECT x.t, x.c, v.verb, has_column_privilege($1, x.t, x.c, v.verb)
           FROM unnest($3::text[], $4::text[]) AS x(t, c)
           CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) AS v(verb)`,
        [role, tables, columns.map((row) => row.t), columns.map((row) => row.c)],
      );
      for (const { t, c, verb, ok } of effective) {
        const expected =
          c === null
            ? verb === 'DELETE' && allows(spec[t], 'DELETE', null)
            : allows(spec[t], verb as Verb, c);
        if (ok !== expected) {
          mismatches.push(`${service} ${verb} ${c === null ? t : `${t}.${c}`}: ${ok ? 'granted' : 'missing'}`);
        }
      }

      for (const schema of OUR_SCHEMAS.concat('public')) {
        const [{ usage, create } = { usage: false, create: false }] = await pg.admin<{ usage: boolean; create: boolean }>(
          `SELECT has_schema_privilege($1, $2, 'USAGE') AS usage, has_schema_privilege($1, $2, 'CREATE') AS "create"`,
          [role, schema],
        );
        if (schema !== 'public' && usage !== SCHEMA_USAGE[service].includes(schema)) {
          mismatches.push(`${service} USAGE ${schema}: ${usage ? 'granted' : 'missing'}`);
        }
        if (create) mismatches.push(`${service} CREATE ${schema}: granted`);
      }

      const [{ db_create } = { db_create: false }] = await pg.admin<{ db_create: boolean }>(
        `SELECT has_database_privilege($1, current_database(), 'CREATE') AS db_create`,
        [role],
      );
      if (db_create) mismatches.push(`${service} CREATE on the database: granted`);
    }

    assert.deepEqual(mismatches, [], 'grants differ from the matrix in this file');
  });

  void test('the two SECURITY DEFINER helpers are executable by their one service and nobody else', async () => {
    const expected: Record<string, Service> = {
      'care.lapse_details(uuid)': 'care_team',
      'ops.release_device_token(text)': 'notification',
    };
    for (const [fn, owner] of Object.entries(expected)) {
      for (const service of SERVICES) {
        const [row] = await pg.admin<{ ok: boolean }>(
          `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`,
          [loginRole(service), fn],
        );
        assert.equal(row?.ok, service === owner, `${service} EXECUTE ${fn}`);
      }
    }
  });

  void test('PUBLIC holds nothing in these schemas, and the Supabase API roles lost what the hosted defaults gave them', async () => {
    const publicGrants = await pg.admin<{ t: string }>(
      `SELECT n.nspname || '.' || c.relname AS t
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE n.nspname = ANY($1) AND a.grantee = 0`,
      [OUR_SCHEMAS],
    );
    assert.deepEqual(publicGrants, [], 'PUBLIC has a privilege on a table');

    for (const apiRole of ['anon', 'authenticated']) {
      const [row] = await pg.admin<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname = ANY($1)
            AND (has_any_column_privilege($2, c.oid, 'SELECT')
              OR has_any_column_privilege($2, c.oid, 'INSERT')
              OR has_any_column_privilege($2, c.oid, 'UPDATE')
              OR has_table_privilege($2, c.oid, 'DELETE'))`,
        [OUR_SCHEMAS, apiRole],
      );
      assert.equal(row?.n, 0, `${apiRole} can still reach a table`);
    }
  });

  // -------------------------------------------------------------------------
  // Policies that could not run under a superuser
  // -------------------------------------------------------------------------

  void test('0010 backfills owner_account_id on rows that existed before it, and puts FORCE back', async () => {
    // Seeded by applyMigrations before 0010 ran. Must run before any test truncates.
    const [row] = await pg.admin<{ owner_account_id: string }>(
      `SELECT owner_account_id FROM programme.sharing_consent WHERE id = $1`,
      [PRE_EXISTING.consent],
    );
    assert.equal(row?.owner_account_id, PRE_EXISTING.account, 'the backfill did not run, or ran wrong');

    const forced = await pg.admin<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'programme' AND c.relname IN ('enrolment', 'sharing_consent')`,
    );
    assert.equal(forced.length, 2);
    for (const table of forced) {
      assert.equal(table.relrowsecurity, true, `${table.relname}: RLS lost`);
      assert.equal(table.relforcerowsecurity, true, `${table.relname}: FORCE was not restored after the backfill`);
    }
    const [nullable] = await pg.admin<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'programme' AND table_name = 'sharing_consent' AND column_name = 'owner_account_id'`,
    );
    assert.equal(nullable?.is_nullable, 'NO');
  });

  void test('the SECURITY DEFINER functions run with an empty search_path and are not executable by the API roles', async () => {
    const functions = await pg.admin<{ name: string; config: string[] | null }>(
      `SELECT n.nspname || '.' || p.proname AS name, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND n.nspname IN ('care', 'ops', 'programme', 'record')
        ORDER BY 1`,
    );
    const mine = functions.filter((f) => ['care.lapse_details', 'ops.release_device_token', 'programme.notify_consent_change'].includes(f.name));
    assert.equal(mine.length, 3);
    for (const fn of mine) {
      assert.ok(fn.config?.some((c) => /^search_path=("")?$/.test(c)), `${fn.name} does not pin an empty search_path (${String(fn.config)})`);
    }
    for (const apiRole of ['anon', 'authenticated']) {
      for (const fn of ['care.lapse_details(uuid)', 'ops.release_device_token(text)', 'programme.notify_consent_change()']) {
        const [row] = await pg.admin<{ ok: boolean }>(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [apiRole, fn]);
        assert.equal(row?.ok, false, `${apiRole} can execute ${fn}`);
      }
    }
  });

  void test('R-032: the enrolment/consent policies evaluate for a role that is subject to them', async () => {
    // Before 0010 every one of these raised 42P17, "infinite recursion detected
    // in policy". A superuser never evaluates policies, so nothing had noticed.
    await seed(pg);
    for (const service of ['enrolment', 'records', 'care_team', 'realtime'] as const) {
      await pg.databaseFor(service).withPrincipal(A, async (tx) => {
        await tx.query('SELECT enrolment_id FROM programme.sharing_consent');
        await tx.query('SELECT id FROM programme.enrolment');
      });
    }
    await pg.databaseFor('enrolment').withPrincipal(A, async (tx) => {
      await tx.query('SELECT enrolment_id FROM record.observation');
      await tx.query('SELECT enrolment_id FROM record.screen_answer');
      await tx.query('SELECT enrolment_id FROM record.lapse_event');
    });
    await pg.databaseFor('care_team').withPrincipal(CLIN, async (tx) => {
      await tx.query('SELECT id FROM care.escalation');
    });
  });

  // -------------------------------------------------------------------------
  // enrolment-service
  // -------------------------------------------------------------------------

  void test('enrolment: an account reads its own enrolments with their live consents', async () => {
    await seed(pg);
    const enrolments = await pg.databaseFor('enrolment').withPrincipal(A, (tx) => loadEnrolments(tx, A));

    assert.deepEqual(enrolments.map((e) => e.id), [ENR_A]);
    assert.deepEqual(enrolments[0]?.consents.map((c) => c.id).sort(), [CONSENT_CLIN2_NOTES, CONSENT_CLIN_TOTALS].sort());
  });

  void test('enrolment: cross-account reads, updates and deletes reach nothing', async () => {
    await seed(pg);
    const db = pg.databaseFor('enrolment');

    // The statements the service issues, handed somebody else's account id.
    assert.deepEqual(await db.withPrincipal(A, (tx) => loadEnrolments(tx, B)), []);
    assert.equal(await db.withPrincipal(A, (tx) => loadEnrolmentRow(tx, B, 'tobacco')), null);

    // The statements it would issue if a predicate were forgotten: RLS alone.
    const touched = await db.withPrincipal(A, (tx) =>
      tx.query<{ id: string }>(`UPDATE programme.enrolment SET hidden = true RETURNING id`),
    );
    assert.deepEqual(touched.map((r) => r.id), [ENR_A], 'an unqualified UPDATE reached another account');
    assert.equal(await count(pg, `SELECT 1 FROM programme.enrolment WHERE hidden`), 1);

    assert.equal(
      await failsWith(db.withPrincipal(A, (tx) => tx.query(`DELETE FROM programme.enrolment`))),
      PERMISSION_DENIED,
      'enrolment-service can delete enrolments',
    );
  });

  void test('enrolment: a patient who is also a recipient does not see shared programmes as their own', async () => {
    // The reason the policy alone is not enough. CLIN holds a live consent on
    // ENR_A, so the recipient policy lets CLIN SELECT it; and CLIN has an
    // enrolment of their own in the same area.
    await seed(pg);
    const db = pg.databaseFor('enrolment');

    // enrolment-service does not get the recipient policy at all (R-060)...
    const unqualified = await db.withPrincipal(CLIN, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM programme.enrolment`),
    );
    assert.deepEqual(ids(unqualified), [ENR_C], 'enrolment-service received a recipient-scoped row');

    // ...care-team does, which is why its own statements must name the consent.
    const clinicianSurface = await pg.databaseFor('care_team').withPrincipal(CLIN, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM programme.enrolment`),
    );
    assert.deepEqual(ids(clinicianSurface), [ENR_A, ENR_C].sort(), 'the recipient policy no longer widens care-team\'s read');

    assert.deepEqual(
      (await db.withPrincipal(CLIN, (tx) => loadEnrolments(tx, CLIN))).map((e) => e.id),
      [ENR_C],
    );
    // `tx.one` throws on two rows, which is what an unqualified area lookup did.
    const row = await db.withPrincipal(CLIN, (tx) => loadEnrolmentRow(tx, CLIN, 'tobacco'));
    assert.equal(row?.id, ENR_C);
  });

  void test('enrolment: a consent can be granted and revoked on one\'s own enrolment, and on nobody else\'s', async () => {
    await seed(pg);
    const db = pg.databaseFor('enrolment');
    const wording = {
      scope: 'totals_and_adherence' as const,
      recipientKind: 'coach' as const,
      recipientId: STRANGER,
      consentVersion: 'v9',
      consentText: 'synthetic wording',
    };

    const granted = await db.withPrincipal(A, (tx) => grantConsent(tx, A, { enrolmentId: ENR_A, ...wording }));
    assert.equal(granted.created, true);
    assert.equal(
      (await pg.admin<{ o: string }>(`SELECT owner_account_id AS o FROM programme.sharing_consent WHERE id = $1`, [granted.consent.id]))[0]?.o,
      A,
      'owner_account_id was not derived from the enrolment',
    );

    // Against somebody else's enrolment: nothing is produced.
    await assert.rejects(
      db.withPrincipal(A, (tx) => grantConsent(tx, A, { enrolmentId: ENR_B, ...wording })),
      /consent insert returned no row/,
    );
    // And if the predicate were forgotten, RLS refuses the insert outright.
    assert.equal(
      await failsWith(
        db.withPrincipal(A, (tx) =>
          tx.query(
            `INSERT INTO programme.sharing_consent (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
             VALUES ($1, 'notes', 'coach', $2, 'v1', 'x')`,
            [ENR_B, A],
          ),
        ),
      ),
      '42501',
    );
    // The owner column is not something a service may write.
    assert.equal(
      await failsWith(
        db.withPrincipal(A, (tx) =>
          tx.query(
            `INSERT INTO programme.sharing_consent (enrolment_id, scope, recipient_kind, consent_version, consent_text, owner_account_id)
             VALUES ($1, 'notes', 'coach', 'v1', 'x', $2)`,
            [ENR_A, B],
          ),
        ),
      ),
      PERMISSION_DENIED,
    );

    const revokedOwn = await db.withPrincipal(A, (tx) =>
      revokeLive(tx, A, { enrolmentId: ENR_A, scope: 'notes', recipientKind: 'care_team', recipientId: CLIN2 }),
    );
    assert.deepEqual(revokedOwn, [CONSENT_CLIN2_NOTES]);

    const revokedOther = await db.withPrincipal(A, (tx) =>
      revokeLive(tx, A, { enrolmentId: ENR_B, scope: 'notes', recipientKind: 'care_team', recipientId: CLIN }),
    );
    assert.deepEqual(revokedOther, []);
    assert.deepEqual(
      (await db.withPrincipal(A, (tx) => loadConsents(tx, B, ENR_B))),
      [],
      'another account\'s consents were readable',
    );
  });

  void test('enrolment: the share preview reads only the caller\'s own record', async () => {
    await seed(pg);
    const db = pg.databaseFor('enrolment');
    const enrolment = await db.withPrincipal(A, (tx) => loadEnrolmentRow(tx, A, 'tobacco'));
    assert.ok(enrolment);

    const own = await db.withPrincipal(A, (tx) => loadPreviewSource(tx, A, enrolment, 'Tobacco'));
    assert.equal(own.totals.length, 1);
    assert.equal(own.answersRecorded, 2);
    assert.equal(own.lapseDates.length, 1);

    // The same enrolment row, a different account: the record is not reachable.
    const other = await db.withPrincipal(B, (tx) => loadPreviewSource(tx, B, enrolment, 'Tobacco'));
    assert.equal(other.totals.length, 0);
    assert.equal(other.answersRecorded, 0);
    assert.equal(other.lapseDates.length, 0);
  });

  // -------------------------------------------------------------------------
  // The consent-recipient policy
  // -------------------------------------------------------------------------

  void test('consent: a recipient sees only their own live grant, never another recipient\'s, a revoked one, or a stranger\'s', async () => {
    await seed(pg);
    const db = pg.databaseFor('care_team');
    const visible = async (who: string): Promise<string[]> =>
      ids(await db.withPrincipal(who, (tx) => tx.query(`SELECT id FROM programme.sharing_consent`)));

    assert.deepEqual(await visible(CLIN), [CONSENT_CLIN_TOTALS], 'CLIN sees more than their one live grant');
    assert.deepEqual(await visible(CLIN2), [CONSENT_CLIN2_NOTES]);
    assert.deepEqual(await visible(STRANGER), []);
  });

  void test('consent: an owner sees every consent on their own enrolments, revoked ones included, and nobody else\'s', async () => {
    await seed(pg);
    const db = pg.databaseFor('enrolment');
    const visible = async (who: string): Promise<string[]> =>
      ids(await db.withPrincipal(who, (tx) => tx.query(`SELECT id FROM programme.sharing_consent`)));

    assert.deepEqual(await visible(A), [CONSENT_CLIN2_NOTES, CONSENT_CLIN_TOTALS].sort());
    assert.deepEqual(await visible(B), [CONSENT_B_CLIN_REVOKED]);
    assert.deepEqual(await visible(STRANGER), []);
  });

  void test('consent: the policy layer on its own — a recipient cannot write, change or delete a consent', async () => {
    // A probe role holding every privilege, so the only thing between it and a
    // row is the policy. Created here, never by a migration.
    await seed(pg);
    await pg.admin(PROBE_SQL);
    await pg.admin(`GRANT USAGE ON SCHEMA identity, programme, record, care, ops, catalogue TO rls_probe`);
    await pg.admin(`GRANT ALL ON ALL TABLES IN SCHEMA identity, programme, record, care, ops, catalogue TO rls_probe`);

    const result = await pg.asRole('rls_probe', CLIN, async (tx) => {
      const updated = await tx.query(`UPDATE programme.sharing_consent SET revoked_at = now() WHERE id = $1 RETURNING id`, [CONSENT_CLIN_TOTALS]);
      const deleted = await tx.query(`DELETE FROM programme.sharing_consent WHERE id = $1 RETURNING id`, [CONSENT_CLIN_TOTALS]);
      return { updated: updated.length, deleted: deleted.length };
    });
    assert.deepEqual(result, { updated: 0, deleted: 0 }, 'a recipient changed or removed a consent');

    assert.equal(
      await failsWith(
        pg.asRole('rls_probe', CLIN, (tx) =>
          tx.query(
            `INSERT INTO programme.sharing_consent (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
             VALUES ($1, 'notes', 'care_team', $2, 'v1', 'x')`,
            [ENR_A, CLIN],
          ),
        ),
      ),
      '42501',
      'a recipient granted themselves a consent',
    );
  });

  void test('consent: under a totals_and_adherence grant, free text and lapse detail are not readable', async () => {
    await seed(pg);
    const db = pg.databaseFor('care_team');
    const store = createCareStore();

    await db.withPrincipal(CLIN, async (tx) => {
      const ctx = { tx, clinicianId: CLIN };

      // Rows: chips and numeric readings are within the grant...
      const on = [ENR_A];
      assert.equal((await tx.query(`SELECT 1 FROM record.screen_answer WHERE kind = 'chips' AND enrolment_id = $1`, on)).length, 1);
      assert.equal((await tx.query(`SELECT 1 FROM record.observation WHERE value_num IS NOT NULL AND enrolment_id = $1`, on)).length, 1);
      // ...the person's own words are not.
      assert.equal((await tx.query(`SELECT 1 FROM record.screen_answer WHERE kind = 'text' AND enrolment_id = $1`, on)).length, 0);
      assert.equal((await tx.query(`SELECT 1 FROM record.observation WHERE value_text IS NOT NULL AND enrolment_id = $1`, on)).length, 0);

      // And through the service's own methods.
      assert.deepEqual(await store.notes(ctx, ENR_A), []);
      assert.deepEqual(await store.textObservations(ctx, ENR_A), []);
      assert.deepEqual(await store.lapseEvents(ctx, ENR_A), [], 'a totals recipient read lapse severity/context');

      const adherence = await store.adherence(ctx, ENR_A, new Date('2026-06-10T00:00:00Z'));
      assert.equal(adherence.lapses.recorded, 1);
    });

    // The severity column itself is refused by grant, not merely hidden by a query.
    assert.equal(
      await failsWith(db.withPrincipal(CLIN, (tx) => tx.query(`SELECT severity FROM record.lapse_event`))),
      PERMISSION_DENIED,
    );
  });

  void test('consent: under a notes grant the free text and lapse detail are readable, for that enrolment only', async () => {
    await seed(pg);
    const store = createCareStore();

    await pg.databaseFor('care_team').withPrincipal(CLIN2, async (tx) => {
      const ctx = { tx, clinicianId: CLIN2 };
      assert.equal((await store.notes(ctx, ENR_A)).length, 1);
      assert.equal((await store.textObservations(ctx, ENR_A)).length, 1);
      const lapses = await store.lapseEvents(ctx, ENR_A);
      assert.equal(lapses.length, 1);
      assert.equal(lapses[0]?.severity, 'synthetic-severity');

      // Another programme is not covered by this consent.
      assert.deepEqual(await store.notes(ctx, ENR_B), []);
      assert.deepEqual(await store.lapseEvents(ctx, ENR_B), []);
      assert.equal(await store.enrolment(ctx, ENR_B), null);
    });
  });

  void test('consent: revocation takes effect on the next statement', async () => {
    await seed(pg);
    const db = pg.databaseFor('care_team');
    const store = createCareStore();

    const before = await db.withPrincipal(CLIN, (tx) => store.sharedProgrammes({ tx, clinicianId: CLIN }));
    assert.deepEqual(before.map((p) => p.enrolmentId), [ENR_A]);

    await pg.admin(`UPDATE programme.sharing_consent SET revoked_at = now() WHERE id = $1`, [CONSENT_CLIN_TOTALS]);

    await db.withPrincipal(CLIN, async (tx) => {
      const ctx = { tx, clinicianId: CLIN };
      assert.deepEqual(await store.sharedProgrammes(ctx), []);
      assert.equal(await store.enrolment(ctx, ENR_A), null);
      assert.deepEqual(await store.liveConsentsFor(ctx, ENR_A), []);
      assert.equal((await store.adherence(ctx, ENR_A, new Date())).lapses.recorded, 0);
      assert.deepEqual(await store.measureSummaries(ctx, ENR_A), []);
    });
  });

  void test('consent: a clinician who is also a patient is not served their own enrolment as a shared one', async () => {
    await seed(pg);
    const store = createCareStore();

    await pg.databaseFor('care_team').withPrincipal(CLIN, async (tx) => {
      // RLS lets CLIN read ENR_C — it is theirs — so only the statement's own
      // consent predicate stands between this and a "shared" record.
      assert.equal((await tx.query(`SELECT 1 FROM programme.enrolment WHERE id = $1`, [ENR_C])).length, 1);
      assert.equal(await store.enrolment({ tx, clinicianId: CLIN }, ENR_C), null);
      assert.deepEqual(await store.measureSummaries({ tx, clinicianId: CLIN }, ENR_C), []);
    });
  });

  void test('consent: an escalation is raised against the clinician\'s own live consent, and cannot be edited or removed', async () => {
    await seed(pg);
    const store = createCareStore();
    const policy = {
      areaId: 'tobacco', version: '1', recipientKind: 'clinician' as const, contact: 'rota',
      crisisContact: null, acknowledgeWithinMinutes: 60, configuredBy: 'synthetic lead',
      configuredAt: '2026-06-01T00:00:00Z', effectiveFrom: '2026-06-01T00:00:00Z', notes: null,
    };
    const raise = (consentId: string) => (tx: Transaction) =>
      store.raiseEscalation(
        { tx, clinicianId: CLIN },
        { enrolmentId: ENR_A, consentId, signal: 'synthetic signal', detail: null, policy },
      );
    const db = pg.databaseFor('care_team');

    const raised = await db.withPrincipal(CLIN, raise(CONSENT_CLIN_TOTALS));
    assert.equal(raised.enrolmentId, ENR_A);
    assert.equal((await pg.admin<{ r: string }>(`SELECT raised_by AS r FROM care.escalation WHERE id = $1`, [raised.id]))[0]?.r, CLIN);

    // Another clinician's consent, a revoked consent, and another enrolment's.
    await assert.rejects(db.withPrincipal(CLIN, raise(CONSENT_CLIN2_NOTES)), /escalation insert returned no row/);
    await assert.rejects(db.withPrincipal(CLIN, raise(CONSENT_B_CLIN_REVOKED)), /escalation insert returned no row/);

    // No UPDATE and no DELETE grant at all.
    for (const sql of [`UPDATE care.escalation SET signal = 'x'`, `DELETE FROM care.escalation`]) {
      assert.equal(await failsWith(db.withPrincipal(CLIN, (tx) => tx.query(sql))), PERMISSION_DENIED, sql);
    }

    // And at the policy layer, with every privilege in hand: still nothing.
    await pg.admin(PROBE_SQL);
    await pg.admin(`GRANT USAGE ON SCHEMA programme, care TO rls_probe`);
    await pg.admin(`GRANT ALL ON ALL TABLES IN SCHEMA programme, care TO rls_probe`);
    const probed = await pg.asRole('rls_probe', CLIN, async (tx) => ({
      updated: (await tx.query(`UPDATE care.escalation SET signal = 'x' RETURNING id`)).length,
      deleted: (await tx.query(`DELETE FROM care.escalation RETURNING id`)).length,
    }));
    assert.deepEqual(probed, { updated: 0, deleted: 0 }, 'a recipient edited or removed an escalation');

    assert.equal(
      await failsWith(
        pg.asRole('rls_probe', CLIN, (tx) =>
          tx.query(
            `INSERT INTO care.escalation (enrolment_id, raised_by, consent_id, signal, policy_area_id, policy_version, routed_to_kind, routed_to, acknowledge_by)
             VALUES ($1, $2, $3, 's', 'tobacco', '1', 'clinician', 'rota', now())`,
            [ENR_A, B, CONSENT_CLIN_TOTALS],
          ),
        ),
      ),
      '42501',
      'a clinician raised an escalation in somebody else\'s name',
    );
  });

  void test('audit: a clinician\'s disclosure is filed under the patient\'s account, and an account reads only its own trail', async () => {
    await seed(pg);

    // care-team appends a row about A while acting as CLIN.
    await pg.databaseFor('care_team').withPrincipal(CLIN, (tx) =>
      writeCareAudit(tx, {
        accountId: A, actorRole: 'clinician', actorAccountId: CLIN, action: 'care.patient.read',
        resourceType: 'enrolment', resourceId: ENR_A, programmeId: ENR_A, detail: { scope: 'totals_and_adherence' },
      }),
    );
    assert.equal(await count(pg, `SELECT 1 FROM ops.audit_event WHERE action = 'care.patient.read' AND account_id = '${A}'`), 1);

    // records-service can read an audit trail (for sync receipts) — its own only.
    const db = pg.databaseFor('records');
    await db.withPrincipal(A, (tx) =>
      writeRecordsAudit(tx, { accountId: A, actorRole: 'patient', action: 'record.sync', resourceType: 'sync_batch', resourceId: 'k1', detail: {} }),
    );
    const own = await db.withPrincipal(A, (tx) => tx.query<{ account_id: string }>(`SELECT account_id FROM ops.audit_event`));
    assert.ok(own.length >= 2 && own.every((r) => r.account_id === A), 'an account read another\'s audit rows');
    assert.deepEqual(await db.withPrincipal(STRANGER, (tx) => tx.query(`SELECT 1 FROM ops.audit_event`)), []);

    // Append-only. 0001 puts DO INSTEAD NOTHING rules on UPDATE and DELETE, which
    // turn the statement into a silent no-op before any privilege is checked, so
    // what is asserted is that nothing changed, not that an error was raised.
    const before = await count(pg, `SELECT 1 FROM ops.audit_event`);
    await db.withPrincipal(A, (tx) => tx.query(`UPDATE ops.audit_event SET action = 'x'`));
    await db.withPrincipal(A, (tx) => tx.query(`DELETE FROM ops.audit_event`));
    assert.equal(await count(pg, `SELECT 1 FROM ops.audit_event WHERE action = 'x'`), 0, 'an audit row was edited');
    assert.equal(await count(pg, `SELECT 1 FROM ops.audit_event`), before, 'an audit row was deleted');
  });

  void test('R-059: no service can forge another service\'s audit rows, and none can forge a sync receipt but records, for itself', async () => {
    await seed(pg);
    const forge = (service: Service, principal: string | null, account: string | null, action: string) =>
      failsWith(
        (principal === null
          ? pg.databaseFor(service).withoutPrincipal.bind(pg.databaseFor(service))
          : (fn: (tx: Transaction) => Promise<unknown>) => pg.databaseFor(service).withPrincipal(principal, fn))((tx) =>
          tx.query(
            `INSERT INTO ops.audit_event (account_id, actor_role, action, resource_type, resource_id) VALUES ($1, 'x', $2, 'sync_batch', 'forged')`,
            [account, action],
          ),
        ),
      );

    // Every role that may append at all, trying to write a receipt for A.
    for (const service of ['auth', 'enrolment', 'care_team', 'website'] as const) {
      assert.equal(await forge(service, A, A, 'record.sync'), '42501', `${service} forged a record.sync row`);
    }
    // Roles with no INSERT grant: refused by grant.
    for (const service of ['catalogue', 'notification', 'chronic', 'realtime'] as const) {
      assert.equal(await forge(service, A, A, 'record.sync'), PERMISSION_DENIED, `${service}`);
    }
    // records: only about its own caller.
    assert.equal(await forge('records', A, A, 'record.sync'), null, 'records could not write its own receipt');
    assert.equal(await forge('records', A, B, 'record.sync'), '42501', 'records wrote a receipt for another account');
    assert.equal(await forge('records', A, null, 'record.sync'), '42501', 'records wrote an unattributed receipt');

    // The receipt a forger would have planted for B is not there.
    assert.equal(await count(pg, `SELECT 1 FROM ops.audit_event WHERE action = 'record.sync' AND account_id = '${B}'`), 0);
    // ...and records-service, asking for A's receipt, finds exactly the one it wrote.
    assert.equal(await count(pg, `SELECT 1 FROM ops.audit_event WHERE action = 'record.sync' AND account_id = '${A}'`), 1);
  });

  void test('R-059: each service can write the audit rows it authors, about the account it is allowed to', async () => {
    await seed(pg);
    const row = (account: string | null, action: string) => [account, action] as const;
    const insert = (tx: Transaction, [account, action]: readonly [string | null, string]) =>
      tx.query(`INSERT INTO ops.audit_event (account_id, actor_role, action, resource_type) VALUES ($1, 'x', $2, 'y')`, [account, action]);

    // enrolment: programme.* and consent.* about the caller; not another's, not another family.
    const enrol = pg.databaseFor('enrolment');
    await enrol.withPrincipal(A, (tx) => insert(tx, row(A, 'programme.join')));
    await enrol.withPrincipal(A, (tx) => insert(tx, row(A, 'consent.grant')));
    assert.equal(await failsWith(enrol.withPrincipal(A, (tx) => insert(tx, row(B, 'programme.join')))), '42501');
    assert.equal(await failsWith(enrol.withPrincipal(A, (tx) => insert(tx, row(A, 'account.delete')))), '42501');
    assert.equal(await failsWith(enrol.withPrincipal(A, (tx) => insert(tx, row(A, 'care.patient.read')))), '42501');

    // auth: account.* about the caller.
    const auth = pg.databaseFor('auth');
    await auth.withPrincipal(A, (tx) => insert(tx, row(A, 'account.delete')));
    assert.equal(await failsWith(auth.withPrincipal(A, (tx) => insert(tx, row(B, 'account.delete')))), '42501');
    assert.equal(await failsWith(auth.withPrincipal(A, (tx) => insert(tx, row(A, 'programme.join')))), '42501');

    // care-team: care.* about the patient (not the caller), or nobody.
    const care = pg.databaseFor('care_team');
    await care.withPrincipal(CLIN, (tx) => insert(tx, row(A, 'care.patient.read')));
    await care.withPrincipal(CLIN, (tx) => insert(tx, row(null, 'care.patient.read.refused')));
    assert.equal(await failsWith(care.withPrincipal(CLIN, (tx) => insert(tx, row(A, 'consent.grant')))), '42501');

    // website: waitlist.* and no account.
    const web = pg.databaseFor('website');
    await web.withoutPrincipal((tx) => insert(tx, row(null, 'waitlist.delete')));
    assert.equal(await failsWith(web.withoutPrincipal((tx) => insert(tx, row(A, 'waitlist.delete')))), '42501');
    assert.equal(await failsWith(web.withoutPrincipal((tx) => insert(tx, row(null, 'care.patient.read')))), '42501');

    // records: anything, about its caller.
    await pg.databaseFor('records').withPrincipal(A, (tx) => insert(tx, row(A, 'record.delete')));
  });

  void test('R-060: enrolment-service and records-service, as a recipient, see nothing of another account\'s record', async () => {
    // CLIN holds a live totals consent on ENR_A (and a notes-scope consent exists for CLIN2).
    // Neither service is the clinician surface, so the recipient policies do not apply to them.
    await seed(pg);
    const probes: [Service, string][] = [
      ['enrolment', 'record.observation'],
      ['enrolment', 'record.screen_answer'],
      ['enrolment', 'record.lapse_event'],
      ['enrolment', 'programme.enrolment'],
      ['records', 'record.observation'],
      ['records', 'record.screen_answer'],
      ['records', 'record.lapse_event'],
      ['records', 'programme.enrolment'],
    ];
    for (const [service, table] of probes) {
      const column = table === 'programme.enrolment' ? 'id' : 'enrolment_id';
      const rows = await pg.databaseFor(service).withPrincipal(CLIN, (tx) =>
        tx.query<{ e: string }>(`SELECT ${column} AS e FROM ${table}`),
      );
      assert.ok(rows.every((r) => r.e === ENR_C), `${service} read ${table} rows that are not CLIN's own: ${JSON.stringify(rows)}`);
      assert.ok(!rows.some((r) => r.e === ENR_A), `${service} read A's ${table} as a recipient`);
    }

    // Lapse severity and context in particular, with the notes consent too.
    const notesClinician = await pg.databaseFor('records').withPrincipal(CLIN2, (tx) =>
      tx.query(`SELECT severity, context FROM record.lapse_event`),
    );
    assert.deepEqual(notesClinician, [], 'records-service handed a notes-scope recipient lapse severity/context');
    const viaEnrolment = await pg.databaseFor('enrolment').withPrincipal(CLIN2, (tx) =>
      tx.query(`SELECT severity, context FROM record.lapse_event`),
    );
    assert.deepEqual(viaEnrolment, []);

    // The consent rows too: a recipient-scoped consent is not visible to either.
    for (const service of ['enrolment', 'records'] as const) {
      const consents = await pg.databaseFor(service).withPrincipal(CLIN, (tx) => tx.query(`SELECT id FROM programme.sharing_consent`));
      assert.deepEqual(consents, [], `${service} saw a consent that names CLIN as recipient`);
    }
  });

  void test('R-060: the clinician surface and the stream are the only roles the recipient policies apply to', async () => {
    const rows = await pg.admin<{ tablename: string; policyname: string; roles: string[] }>(
      `SELECT tablename, policyname, roles FROM pg_policies
        WHERE policyname LIKE '%recipient%' OR policyname LIKE '%consented%' ORDER BY 1, 2`,
    );
    assert.ok(rows.length >= 7);
    for (const row of rows) {
      assert.ok(!row.roles.includes('public'), `${row.tablename}.${row.policyname} still applies to PUBLIC`);
      for (const role of row.roles) {
        assert.ok(['tether_care_team', 'tether_realtime'].includes(role), `${row.policyname} names ${role}`);
      }
    }
    // The stream gets the consent row and nothing else.
    const realtime = rows.filter((r) => r.roles.includes('tether_realtime')).map((r) => r.policyname);
    assert.deepEqual(realtime, ['sharing_consent_recipient']);
  });

  void test('device release: it needs a principal, and works for an owner that does not bypass RLS', async () => {
    await seed(pg);
    const notify = pg.databaseFor('notification');

    // No principal: nothing is released, whoever holds the token.
    await notify.withoutPrincipal((tx) => tx.query(`SELECT ops.release_device_token('token-a')`));
    assert.equal(await count(pg, `SELECT 1 FROM ops.device_token WHERE token = 'token-a'`), 1, 'released with no principal set');

    // Now make the function's owner an ordinary role (no superuser, no BYPASSRLS)
    // and point the two policies at it, exactly as the migration does for whoever
    // ran it. The release must still work: it depends on the policy, not on the
    // owner's attributes.
    const [{ owner } = { owner: '' }] = await pg.admin<{ owner: string }>(
      `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'ops.release_device_token(text)'::regprocedure`,
    );
    const [policy] = await pg.admin<{ roles: string[] }>(
      `SELECT roles FROM pg_policies WHERE tablename = 'device_token' AND policyname = 'device_token_release'`,
    );
    assert.deepEqual(policy?.roles, [owner], 'the release policy is not named for the function owner');

    // A fresh role, created here and dropped in `finally`: nothing it holds
    // outlives the test, so no later test (the role-census ones in particular)
    // can see it, and a failed assertion cannot leave it owning the function.
    await pg.admin(`DROP ROLE IF EXISTS rls_owner`);
    await pg.admin(`CREATE ROLE rls_owner NOLOGIN`);
    const [{ q: ownerIdent } = { q: '' }] = await pg.admin<{ q: string }>(`SELECT quote_ident($1) AS q`, [owner]);
    await pg.admin(`GRANT USAGE, CREATE ON SCHEMA ops TO rls_owner`);
    await pg.admin(`GRANT USAGE ON SCHEMA public TO rls_owner`);
    await pg.admin(`GRANT SELECT, DELETE ON ops.device_token TO rls_owner`);
    try {
      await pg.admin(`ALTER FUNCTION ops.release_device_token(text) OWNER TO rls_owner`);
      await pg.admin(`ALTER POLICY device_token_release ON ops.device_token TO rls_owner`);
      await pg.admin(`ALTER POLICY device_token_release_select ON ops.device_token TO rls_owner`);

      const [privileged] = await pg.admin<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rls_owner'`,
      );
      assert.deepEqual(privileged, { rolsuper: false, rolbypassrls: false });

      await notify.withPrincipal(B, (tx) => tx.query(`SELECT ops.release_device_token('token-a')`));
      assert.equal(await count(pg, `SELECT 1 FROM ops.device_token WHERE token = 'token-a'`), 0, 'a non-bypassing owner could not release the token');
      assert.equal(await count(pg, `SELECT 1 FROM ops.device_token WHERE token = 'token-b'`), 1, 'it released the caller\'s own');

      // Without the policy the same owner can release nothing: the dependency is real.
      await pg.admin(`INSERT INTO ops.device_token (account_id, token, platform) VALUES ('${A}', 'token-a2', 'android')`);
      await pg.admin(`ALTER POLICY device_token_release ON ops.device_token TO ${ownerIdent}`);
      await pg.admin(`ALTER POLICY device_token_release_select ON ops.device_token TO ${ownerIdent}`);
      await notify.withPrincipal(B, (tx) => tx.query(`SELECT ops.release_device_token('token-a2')`));
      assert.equal(await count(pg, `SELECT 1 FROM ops.device_token WHERE token = 'token-a2'`), 1, 'the policy is not what makes it work');
    } finally {
      await pg.admin(`ALTER FUNCTION ops.release_device_token(text) OWNER TO ${ownerIdent}`);
      await pg.admin(`ALTER POLICY device_token_release ON ops.device_token TO ${ownerIdent}`);
      await pg.admin(`ALTER POLICY device_token_release_select ON ops.device_token TO ${ownerIdent}`);
      await pg.admin(`DROP OWNED BY rls_owner`);
      await pg.admin(`DROP ROLE rls_owner`);
    }
  });

  void test('B1: care.lapse_details returns the notes recipient\'s rows for an owner that does not bypass RLS, and only theirs', async () => {
    await seed(pg);
    const care = pg.databaseFor('care_team');
    const detail = (clinician: string, enrolment: string) =>
      care.withPrincipal(clinician, (tx) =>
        tx.query<{ severity: string }>(`SELECT severity FROM care.lapse_details($1)`, [enrolment]),
      );

    const [{ owner } = { owner: '' }] = await pg.admin<{ owner: string }>(
      `SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'care.lapse_details(uuid)'::regprocedure`,
    );
    const policies = await pg.admin<{ policyname: string; roles: string[] }>(
      `SELECT policyname, roles FROM pg_policies
        WHERE policyname IN ('sharing_consent_lapse_details', 'lapse_event_lapse_details') ORDER BY 1`,
    );
    assert.deepEqual(
      policies.map((p) => [p.policyname, p.roles]),
      [
        ['lapse_event_lapse_details', [owner]],
        ['sharing_consent_lapse_details', [owner]],
      ],
      'the lapse-detail policies are not named for the function owner alone',
    );

    // Whoever ran the migration, as the harness does.
    assert.equal((await detail(CLIN2, ENR_A)).length, 1);

    // Now an owner that is neither a superuser nor BYPASSRLS, with the policies
    // pointed at it. The function must still return the notes recipient's rows.
    await pg.admin(`DROP ROLE IF EXISTS rls_owner`);
    await pg.admin(`CREATE ROLE rls_owner NOLOGIN`);
    await pg.admin(`GRANT USAGE ON SCHEMA public, programme, record TO rls_owner`);
    await pg.admin(`GRANT USAGE, CREATE ON SCHEMA care TO rls_owner`);
    await pg.admin(`GRANT SELECT ON programme.sharing_consent, record.lapse_event TO rls_owner`);
    const [{ q: ownerIdent } = { q: '' }] = await pg.admin<{ q: string }>(`SELECT quote_ident($1) AS q`, [owner]);
    const repoint = async (target: string) => {
      const role = await pg.admin<{ q: string }>(`SELECT quote_ident($1) AS q`, [target]);
      const quoted = role[0]?.q ?? '';
      await pg.admin(`ALTER POLICY sharing_consent_lapse_details ON programme.sharing_consent TO ${quoted}`);
      await pg.admin(`ALTER POLICY lapse_event_lapse_details ON record.lapse_event TO ${quoted}`);
    };
    try {
      await pg.admin(`ALTER FUNCTION care.lapse_details(uuid) OWNER TO rls_owner`);
      await repoint('rls_owner');
      const [privileged] = await pg.admin<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rls_owner'`,
      );
      assert.deepEqual(privileged, { rolsuper: false, rolbypassrls: false });

      const rows = await detail(CLIN2, ENR_A);
      assert.equal(rows.length, 1, 'a non-bypassing owner returned no lapse detail to a notes recipient');
      assert.equal(rows[0]?.severity, 'synthetic-severity');

      // Still closed to everyone else: a totals-only recipient, a stranger,
      // another programme, no principal at all, and a revoked consent.
      assert.equal((await detail(CLIN, ENR_A)).length, 0, 'a totals-only recipient read lapse detail');
      assert.equal((await detail(STRANGER, ENR_A)).length, 0, 'a stranger read lapse detail');
      assert.equal((await detail(CLIN2, ENR_B)).length, 0, 'a notes consent on one programme reached another');
      assert.equal(
        (await care.withoutPrincipal((tx) => tx.query(`SELECT 1 FROM care.lapse_details($1)`, [ENR_A]))).length,
        0,
        'lapse detail returned with no principal',
      );
      await pg.admin(`UPDATE programme.sharing_consent SET revoked_at = now() WHERE id = $1`, [CONSENT_CLIN2_NOTES]);
      assert.equal((await detail(CLIN2, ENR_A)).length, 0, 'a revoked consent still returned lapse detail');
      await pg.admin(`UPDATE programme.sharing_consent SET revoked_at = NULL WHERE id = $1`, [CONSENT_CLIN2_NOTES]);

      // The dependency is real: with the policies named for somebody else the same
      // owner sees nothing, which is the failure this test exists to catch.
      await repoint(owner);
      assert.equal((await detail(CLIN2, ENR_A)).length, 0, 'the policies are not what makes it work');
    } finally {
      await pg.admin(`ALTER FUNCTION care.lapse_details(uuid) OWNER TO ${ownerIdent}`);
      await repoint(owner);
      await pg.admin(`DROP OWNED BY rls_owner`);
      await pg.admin(`DROP ROLE rls_owner`);
    }
  });

  // -------------------------------------------------------------------------
  // records-service
  // -------------------------------------------------------------------------

  void test('records: reads are the caller\'s own, and writes against another account\'s enrolment are refused', async () => {
    await seed(pg);
    const db = pg.databaseFor('records');
    const store = createRecordsStore();

    await db.withPrincipal(A, async (tx) => {
      const ctx = { tx, accountId: A };
      assert.deepEqual((await store.enrolments(ctx)).map((e) => e.id), [ENR_A]);
      assert.equal((await store.answers(ctx, ENR_A)).length, 2);
      assert.equal((await store.observations(ctx, ENR_A)).length, 2);

      // Somebody else's enrolment id, with the account predicates in place.
      assert.deepEqual(await store.answers(ctx, ENR_B), []);
      assert.deepEqual(await store.lapses(ctx, ENR_B), []);
      assert.deepEqual(await store.observations(ctx, ENR_B), []);
    });

    // Writes against another account's enrolment: the RLS check refuses them.
    const written = (fn: (tx: Transaction) => Promise<unknown>) => failsWith(db.withPrincipal(A, fn));
    assert.equal(await written((tx) => store.replaceScreenAnswers({ tx, accountId: A }, ENR_B, 'S02', [{ blockIndex: 0, kind: 'chips', value: [1] }])), '42501');
    assert.equal(
      await written((tx) =>
        store.appendObservation({ tx, accountId: A }, ENR_B, {
          measureId: 'craving_intensity', value: 9, unit: 'score', observedAt: '2026-06-04T00:00:00Z', source: 'self_report', platform: null,
        }),
      ),
      '42501',
    );
    assert.equal(await count(pg, `SELECT 1 FROM record.observation WHERE enrolment_id = '${ENR_B}'`), 1, 'B\'s record changed');
  });

  void test('records: unqualified deletes and updates touch only the caller\'s rows, or are refused outright', async () => {
    await seed(pg);
    const db = pg.databaseFor('records');

    const deleted = await db.withPrincipal(A, (tx) => tx.query(`DELETE FROM record.observation RETURNING id`));
    assert.equal(deleted.length, 2, 'A\'s two observations');
    assert.equal(await count(pg, `SELECT 1 FROM record.observation WHERE enrolment_id = '${ENR_B}'`), 1);

    // No UPDATE on an observation, by grant. A lapse has a DO INSTEAD NOTHING
    // rule (0003) that turns an UPDATE into a no-op before privileges are
    // checked, so for that one the assertion is that nothing changed.
    assert.equal(
      await failsWith(db.withPrincipal(A, (tx) => tx.query(`UPDATE record.observation SET unit = 'x'`))),
      PERMISSION_DENIED,
    );
    await db.withPrincipal(A, (tx) => tx.query(`UPDATE record.lapse_event SET severity = 'x'`));
    assert.equal(await count(pg, `SELECT 1 FROM record.lapse_event WHERE severity = 'x'`), 0, 'a lapse was edited');
    // And it cannot reach another service's tables.
    assert.equal(await failsWith(db.withPrincipal(A, (tx) => tx.query(`SELECT 1 FROM chronic.profile`))), PERMISSION_DENIED);
    assert.equal(await failsWith(db.withPrincipal(A, (tx) => tx.query(`SELECT 1 FROM identity.account`))), PERMISSION_DENIED);
  });

  void test('records: erasing a record removes the caller\'s data and nobody else\'s', async () => {
    await seed(pg);
    const store = createRecordsStore();

    const counts = await pg.databaseFor('records').withPrincipal(A, (tx) => store.deleteEverything({ tx, accountId: A }));
    assert.deepEqual(counts, { enrolments: 1, answers: 2, lapses: 1, observations: 2, consents: 2 });

    assert.equal(await count(pg, `SELECT 1 FROM programme.enrolment WHERE account_id = '${A}'`), 0);
    assert.equal(await count(pg, `SELECT 1 FROM programme.enrolment WHERE account_id IN ('${B}', '${CLIN}')`), 2);
    assert.equal(await count(pg, `SELECT 1 FROM record.observation WHERE enrolment_id IN ('${ENR_B}', '${ENR_C}')`), 2);
    assert.equal(await count(pg, `SELECT 1 FROM programme.sharing_consent WHERE id = '${CONSENT_B_CLIN_REVOKED}'`), 1);
  });

  // -------------------------------------------------------------------------
  // chronic-service
  // -------------------------------------------------------------------------

  void test('chronic: an account reads and writes its own conditions, readings and medications', async () => {
    await seed(pg);
    await pg.databaseFor('chronic').withPrincipal(A, async (tx) => {
      assert.equal((await listVitals(tx, A, COND_A, 50)).length, 1);
      const vital = await createVital(tx, A, COND_A, {
        metricKey: 'k_a2', label: 'again', value: 4, unit: 'u', note: '', source: 'manual',
      });
      assert.equal(vital.conditionId, COND_A);
      assert.equal((await listMedications(tx, A)).length, 1);

      const created = await createCondition(tx, A, { kind: 'hypertension', status: 'unknown' });
      assert.equal(created.kind, 'hypertension');
      const medication = await createMedication(tx, A, {
        name: 'synthetic drug', dosage: '', schedule: '', times: ['08:00'], remindersEnabled: true,
        takenToday: false, conditionId: created.id, active: true,
      });
      assert.equal(medication.conditionId, created.id);
    });
  });

  void test('chronic: another account\'s condition, readings and medication are unreachable', async () => {
    await seed(pg);
    const db = pg.databaseFor('chronic');

    await db.withPrincipal(A, async (tx) => {
      assert.deepEqual(await listVitals(tx, A, COND_B, 50), []);
      assert.equal(await deleteMedication(tx, A, MED_B), false);
    });

    await assert.rejects(
      db.withPrincipal(A, (tx) => createVital(tx, A, COND_B, { metricKey: 'k', label: '', value: 1, unit: '', note: '', source: 'manual' })),
      /vital insert returned no row/,
    );
    await assert.rejects(
      db.withPrincipal(A, (tx) =>
        createMedication(tx, A, {
          name: 'x', dosage: '', schedule: '', times: [], remindersEnabled: true, takenToday: false, conditionId: COND_B, active: true,
        }),
      ),
      /No such condition/,
    );

    // With no predicate at all, RLS alone.
    const vitals = await db.withPrincipal(A, (tx) => tx.query<{ condition_id: string }>(`SELECT condition_id FROM chronic.vital_entry`));
    assert.deepEqual(vitals.map((v) => v.condition_id), [COND_A]);
    const removed = await db.withPrincipal(A, (tx) => tx.query(`DELETE FROM chronic.medication RETURNING id`));
    assert.equal(removed.length, 1, 'an unqualified DELETE reached another account\'s medication');
    assert.equal(await count(pg, `SELECT 1 FROM chronic.medication WHERE id = '${MED_B}'`), 1);

    // The same RLS, without the predicate, for a write.
    assert.equal(
      await failsWith(db.withPrincipal(A, (tx) => tx.query(`INSERT INTO chronic.vital_entry (condition_id, metric_key, label, value, unit, observed_at) VALUES ($1, 'k', '', 1, '', now())`, [COND_B]))),
      '42501',
    );
  });

  void test('chronic: it holds no grant on any other service\'s tables', async () => {
    const db = pg.databaseFor('chronic');
    for (const table of ['programme.enrolment', 'record.observation', 'identity.account', 'ops.device_token', 'ops.audit_event']) {
      assert.equal(await failsWith(db.withPrincipal(A, (tx) => tx.query(`SELECT 1 FROM ${table}`))), PERMISSION_DENIED, table);
    }
  });

  // -------------------------------------------------------------------------
  // notification-service
  // -------------------------------------------------------------------------

  void test('notification: a device token belongs to its account, and moves with the device', async () => {
    await seed(pg);
    const db = pg.databaseFor('notification');

    assert.deepEqual(await db.withPrincipal(A, (tx) => tx.query<{ token: string }>(`SELECT token FROM ops.device_token`)).then((r) => r.map((x) => x.token)), ['token-a']);
    assert.equal(await db.withPrincipal(A, (tx) => removeDevice(tx, A, 'token-b')), false, 'A removed B\'s device');
    assert.equal((await db.withPrincipal(A, (tx) => tx.query(`DELETE FROM ops.device_token RETURNING id`))).length, 1);
    assert.equal(await count(pg, `SELECT 1 FROM ops.device_token WHERE token = 'token-b'`), 1);

    // B signs in on a phone that A used: the token ends up on B alone.
    await seed(pg);
    await db.withPrincipal(B, (tx) => registerDevice(tx, B, { token: 'token-a', platform: 'android', areaId: null }));
    assert.deepEqual(await db.withPrincipal(A, (tx) => tokensFor(tx, A)), []);
    assert.deepEqual((await db.withPrincipal(B, (tx) => tokensFor(tx, B))).sort(), ['token-a', 'token-b']);
  });

  void test('notification: the release function removes only the row holding the presented token, and only from another account', async () => {
    await seed(pg);
    const db = pg.databaseFor('notification');

    await db.withPrincipal(A, (tx) => tx.query(`SELECT ops.release_device_token('token-a')`));
    assert.equal(await count(pg, `SELECT 1 FROM ops.device_token WHERE token = 'token-a'`), 1, 'it removed the caller\'s own row');
    await db.withPrincipal(A, (tx) => tx.query(`SELECT ops.release_device_token('token-b')`));
    assert.equal(await count(pg, `SELECT 1 FROM ops.device_token WHERE token = 'token-b'`), 0);
    assert.equal(await count(pg, `SELECT 1 FROM ops.device_token`), 1, 'it removed an unrelated row');
  });

  // -------------------------------------------------------------------------
  // website-service
  // -------------------------------------------------------------------------

  void test('website: the waitlist works, and is invisible to every other service', async () => {
    await seed(pg);
    const db = pg.databaseFor('website');

    const created = await db.withoutPrincipal((tx) =>
      recordEnquiry(tx, { name: 'Synthetic Two', email: 'two@example.test', role: 'patient', interest: 'general', message: 'hi' }, 900_000),
    );
    assert.equal(created.created, true);
    assert.equal(await db.withoutPrincipal((tx) => deleteEnquiry(tx, created.id)), true);
    assert.equal(await db.withoutPrincipal((tx) => purgeExpired(tx, 10)), 0);

    for (const service of SERVICES.filter((s) => s !== 'website')) {
      assert.equal(
        await failsWith(pg.databaseFor(service).withoutPrincipal((tx) => tx.query(`SELECT email FROM ops.waitlist_enquiry`))),
        PERMISSION_DENIED,
        `${service} can read the waitlist`,
      );
    }
    // website-service holds no grant on anything else personal.
    for (const table of ['identity.account', 'programme.enrolment', 'ops.device_token', 'chronic.profile']) {
      assert.equal(await failsWith(db.withoutPrincipal((tx) => tx.query(`SELECT 1 FROM ${table}`))), PERMISSION_DENIED, table);
    }
  });

  void test('website: the waitlist is denied by policy as well as by grant, to a role that is granted everything', async () => {
    await seed(pg);
    await pg.admin(PROBE_SQL);
    await pg.admin(`GRANT USAGE ON SCHEMA identity, ops TO rls_probe`);
    await pg.admin(`GRANT ALL ON ALL TABLES IN SCHEMA identity, ops TO rls_probe`);

    const seen = await pg.asRole('rls_probe', A, async (tx) => ({
      waitlist: (await tx.query(`SELECT 1 FROM ops.waitlist_enquiry`)).length,
      accounts: (await tx.query(`SELECT 1 FROM identity.account`)).length,
      sessions: (await tx.query(`SELECT 1 FROM identity.refresh_session`)).length,
    }));
    assert.deepEqual(seen, { waitlist: 0, accounts: 0, sessions: 0 });
  });

  // -------------------------------------------------------------------------
  // auth-service
  // -------------------------------------------------------------------------

  void test('auth: sign-in, sessions and account deletion work, and deletion cascades to nothing but the account\'s own data', async () => {
    await seed(pg);
    const db = pg.databaseFor('auth');

    const account = await upsertAccount(db, { externalId: 'ext-new', email: 'new@example.test' });
    assert.equal((await findAccount(db, account.id))?.id, account.id);
    const again = await upsertAccount(db, { externalId: 'ext-new', email: null });
    assert.equal(again.id, account.id, 'the upsert created a second account');

    const sessions = createSessionStore(db);
    const issued = await sessions.transact((tx) =>
      tx.insert({ accountId: account.id, familyId: 'f0000000-0000-4000-8000-000000000001', tokenHash: 'a'.repeat(64), issuedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), userAgent: null, ip: null }),
    );
    assert.equal((await sessions.transact((tx) => tx.lockByHash('a'.repeat(64))))?.id, issued.id);
    await sessions.transact((tx) => tx.revoke(issued.id, 'signed-out', new Date()));

    // DELETE /me for A: A's enrolment and everything under it goes; B's does not.
    await deleteAccount(db, { accountId: A, requestId: 'req-1', ip: null, userAgent: null });
    assert.equal(await count(pg, `SELECT 1 FROM identity.account WHERE id = '${A}'`), 0);
    assert.equal(await count(pg, `SELECT 1 FROM programme.enrolment WHERE account_id = '${A}'`), 0);
    assert.equal(await count(pg, `SELECT 1 FROM record.observation WHERE enrolment_id = '${ENR_A}'`), 0);
    assert.equal(await count(pg, `SELECT 1 FROM identity.account WHERE id = '${B}'`), 1);
    assert.equal(await count(pg, `SELECT 1 FROM record.observation WHERE enrolment_id = '${ENR_B}'`), 1);
    assert.equal(await count(pg, `SELECT 1 FROM ops.audit_event WHERE action = 'account.delete' AND account_id = '${A}'`), 1, 'the deletion left no proof');
  });

  void test('auth: it cannot read any patient record, and the refresh-session table is its own alone', async () => {
    await seed(pg);
    const db = pg.databaseFor('auth');
    for (const table of ['programme.enrolment', 'record.observation', 'chronic.profile', 'ops.device_token', 'ops.waitlist_enquiry']) {
      assert.equal(await failsWith(db.withoutPrincipal((tx) => tx.query(`SELECT 1 FROM ${table}`))), PERMISSION_DENIED, table);
    }
    for (const service of SERVICES.filter((s) => s !== 'auth')) {
      assert.equal(
        await failsWith(pg.databaseFor(service).withoutPrincipal((tx) => tx.query(`SELECT 1 FROM identity.refresh_session`))),
        PERMISSION_DENIED,
        `${service} can read refresh sessions`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // catalogue-service
  // -------------------------------------------------------------------------

  void test('catalogue: it reads the bundle and cannot write it, nor read anything personal', async () => {
    await seed(pg);
    const db = pg.databaseFor('catalogue');

    assert.equal((await db.withoutPrincipal((tx) => tx.query(`SELECT id FROM catalogue.area`))).length, 3);
    assert.equal(await failsWith(db.withoutPrincipal((tx) => tx.query(`INSERT INTO catalogue.area (id, name, scope, status, position) VALUES ('x','x','x','planned',9)`))), PERMISSION_DENIED);
    assert.equal(await failsWith(db.withoutPrincipal((tx) => tx.query(`UPDATE catalogue.area SET name = 'x'`))), PERMISSION_DENIED);
    assert.equal(await failsWith(db.withoutPrincipal((tx) => tx.query(`DELETE FROM catalogue.area`))), PERMISSION_DENIED);
    for (const table of ['identity.account', 'programme.enrolment', 'ops.audit_event']) {
      assert.equal(await failsWith(db.withoutPrincipal((tx) => tx.query(`SELECT 1 FROM ${table}`))), PERMISSION_DENIED, table);
    }
  });

  // -------------------------------------------------------------------------
  // Every statement a service issues is inside its grants
  // -------------------------------------------------------------------------

  void test('enrolment: joining, pausing, hiding and the two-active ceiling all work under the service role', async () => {
    // The ceiling is a deferred constraint trigger that reads `catalogue.shell_rule`
    // and `programme.enrolment` as the *invoking* role, so it is only right if the
    // grants and policies let that role read both.
    await seed(pg);
    const db = pg.databaseFor('enrolment');

    assert.equal(await db.withPrincipal(STRANGER, (tx) => loadActiveCeiling(tx)), 2);
    assert.equal((await db.withPrincipal(STRANGER, (tx) => loadArea(tx, 'tobacco')))?.productId, 'breathefree');

    await db.withPrincipal(STRANGER, async (tx) => {
      await insertEnrolment(tx, STRANGER, 'tobacco');
      await insertEnrolment(tx, STRANGER, 'alcohol');
    });
    assert.equal((await db.withPrincipal(STRANGER, (tx) => loadActiveProgrammes(tx, STRANGER))).length, 2);

    // A third at once breaches the ceiling, and the refusal comes from the database.
    assert.equal(
      await failsWith(db.withPrincipal(STRANGER, (tx) => insertEnrolment(tx, STRANGER, 'sleep'))),
      '23514',
      'the two_active_max trigger did not fire for the service role',
    );

    // Pausing one frees a place, in the same transaction as the join.
    await db.withPrincipal(STRANGER, async (tx) => {
      assert.equal((await setStatus(tx, STRANGER, 'tobacco', 'paused'))?.status, 'paused');
      await insertEnrolment(tx, STRANGER, 'sleep');
    });
    const hidden = await db.withPrincipal(STRANGER, (tx) => setHidden(tx, STRANGER, 'alcohol', true));
    assert.equal(hidden?.hidden, true);
    assert.equal((await db.withPrincipal(STRANGER, (tx) => loadEnrolments(tx, STRANGER))).length, 3);
  });

  void test('records: appending, replacing, syncing and reading the export all work under the service role', async () => {
    await seed(pg);
    const db = pg.databaseFor('records');
    const store = createRecordsStore();

    await db.withPrincipal(A, async (tx) => {
      const ctx = { tx, accountId: A };

      const lapse = { occurredAt: '2026-06-05T00:00:00.000Z', severity: 'synthetic', context: ['c'] };
      assert.equal((await store.appendLapse(ctx, ENR_A, lapse)).created, true);
      assert.equal((await store.appendLapse(ctx, ENR_A, lapse)).created, false, 'a replay must not write twice');

      const observation = {
        measureId: 'craving_intensity', value: 4, unit: 'score',
        observedAt: '2026-06-05T00:00:00.000Z', source: 'self_report' as const, platform: null,
      };
      assert.equal((await store.appendObservation(ctx, ENR_A, observation)).created, true);
      assert.equal((await store.appendObservation(ctx, ENR_A, observation)).created, false);

      const replaced = await store.replaceScreenAnswers(ctx, ENR_A, 'S02', [
        { blockIndex: 0, kind: 'chips', value: [1] },
        { blockIndex: 1, kind: 'slider', value: 5 },
      ]);
      assert.deepEqual(replaced, { written: 2, removed: 0 });
      assert.deepEqual(
        await store.replaceScreenAnswers(ctx, ENR_A, 'S02', [{ blockIndex: 0, kind: 'chips', value: [2] }]),
        { written: 1, removed: 1 },
      );
      assert.equal((await store.mergeScreenAnswers(ctx, ENR_A, 'S02', [{ blockIndex: 3, kind: 'slider', value: 1 }])).written, 1);

      assert.equal((await store.lapses(ctx, ENR_A)).length, 2);
      assert.equal((await store.observations(ctx, ENR_A)).length, 3);
      assert.equal((await store.enrolmentForArea(ctx, 'tobacco'))?.id, ENR_A);
      assert.deepEqual([...(await store.areaNames(ctx, ['tobacco'])).entries()], [['tobacco', 'Tobacco']]);
      assert.equal((await store.liveConsents(ctx)).length, 2);

      // A sync receipt is an audit row, found again by the same role.
      await store.lockSyncBatch(ctx, 'batch-1');
      assert.equal(await store.findSyncReceipt(ctx, 'batch-1'), null);
      await writeRecordsAudit(tx, {
        accountId: A, actorRole: 'patient', action: 'record.sync', resourceType: 'sync_batch',
        resourceId: 'batch-1', detail: { idempotencyKey: 'batch-1' },
      });
      assert.equal((await store.findSyncReceipt(ctx, 'batch-1'))?.idempotencyKey, 'batch-1');
    });
    // Another account cannot find A's receipt.
    await db.withPrincipal(B, async (tx) => {
      assert.equal(await store.findSyncReceipt({ tx, accountId: B }, 'batch-1'), null);
    });
  });

  void test('care-team: the routing policy is readable, and an escalation raised under a notes consent is listed', async () => {
    await seed(pg);
    const store = createCareStore();

    await pg.databaseFor('care_team').withPrincipal(CLIN2, async (tx) => {
      const ctx = { tx, clinicianId: CLIN2 };
      const policy = await store.escalationPolicy(ctx, 'tobacco');
      assert.equal(policy?.recipientKind, 'clinician');
      assert.equal(await store.escalationPolicy(ctx, 'sleep'), null);

      assert.deepEqual(await store.escalations(ctx, ENR_A), []);
      assert.ok(policy);
      const raised = await store.raiseEscalation(ctx, {
        enrolmentId: ENR_A, consentId: CONSENT_CLIN2_NOTES, signal: 'synthetic signal', detail: 'synthetic detail', policy,
      });
      assert.deepEqual((await store.escalations(ctx, ENR_A)).map((e) => e.id), [raised.id]);
    });

    // The patient it is about can read it; a stranger cannot.
    const asPatient = (who: string) =>
      pg.asRole('rls_probe', who, (tx) => tx.query(`SELECT id FROM care.escalation`));
    await pg.admin(PROBE_SQL);
    await pg.admin(`GRANT USAGE ON SCHEMA programme, care TO rls_probe`);
    await pg.admin(`GRANT ALL ON ALL TABLES IN SCHEMA programme, care TO rls_probe`);
    assert.equal((await asPatient(A)).length, 1, 'the person an escalation is about cannot see it');
    assert.equal((await asPatient(STRANGER)).length, 0);
    assert.equal((await asPatient(B)).length, 0);
  });

  void test('chronic: a first write creates the profile, and the profile patch reaches only that account\'s row', async () => {
    await seed(pg);
    const db = pg.databaseFor('chronic');

    assert.equal(await db.withPrincipal(STRANGER, (tx) => getProfile(tx, STRANGER)), null);
    const profile = await db.withPrincipal(STRANGER, (tx) =>
      upsertProfile(tx, STRANGER, { displayName: 'Synthetic Person', healthScore: 40 }),
    );
    assert.equal(profile.displayName, 'Synthetic Person');
    assert.equal(profile.healthScore, 40);
    assert.equal(await count(pg, `SELECT 1 FROM chronic.profile WHERE display_name = 'Synthetic Person'`), 1);
    assert.equal(await count(pg, `SELECT 1 FROM chronic.profile`), 3);
  });

  void test('notification: preferences and the delivery log work under the service role, and the log holds no body', async () => {
    await seed(pg);
    const db = pg.databaseFor('notification');

    assert.deepEqual(await db.withPrincipal(A, (tx) => readPreference(tx, A)), { specificContent: false, optedInAt: null });
    const on = await db.withPrincipal(A, (tx) => setPreference(tx, A, true, 'synthetic wording'));
    assert.equal(on.specificContent, true);
    assert.ok(on.optedInAt);
    const off = await db.withPrincipal(A, (tx) => setPreference(tx, A, false, null));
    assert.equal(off.specificContent, false);
    assert.equal(off.optedInAt, null);

    await db.withPrincipal(A, (tx) =>
      recordDelivery(tx, { accountId: A, kind: 'check_in_due', variant: 'generic', deviceCount: 1, delivered: 1, failed: 0, provider: 'fcm' }),
    );
    assert.equal(await count(pg, `SELECT 1 FROM ops.notification_log WHERE account_id = '${A}'`), 1);
    // Append-only: no DELETE grant, and 0006's DO INSTEAD NOTHING rule makes an
    // UPDATE a silent no-op before privileges are checked.
    assert.equal(await failsWith(db.withPrincipal(A, (tx) => tx.query(`DELETE FROM ops.notification_log`))), PERMISSION_DENIED);
    await db.withPrincipal(A, (tx) => tx.query(`UPDATE ops.notification_log SET kind = 'x'`));
    assert.equal(await count(pg, `SELECT 1 FROM ops.notification_log WHERE kind = 'x'`), 0, 'a delivery-log row was edited');
    // And one account cannot write a log row for another (the policy, with the grant in place).
    assert.equal(
      await failsWith(
        db.withPrincipal(A, (tx) =>
          recordDelivery(tx, { accountId: B, kind: 'x', variant: 'generic', deviceCount: 0, delivered: 0, failed: 0, provider: 'fcm' }),
        ),
      ),
      '42501',
    );
  });

  void test('catalogue: every statement the service issues for the bundle is inside its grants', async () => {
    await seed(pg);
    const db = pg.databaseFor('catalogue');

    const bundle = await db.withoutPrincipal((tx) => loadBundle(tx, 'en'));
    assert.equal(bundle.areas.length, 3);
    assert.equal((await db.withoutPrincipal((tx) => loadAreas(tx))).length, 3);
  });

  // -------------------------------------------------------------------------
  // Services cannot touch each other's tables
  // -------------------------------------------------------------------------

  void test('no service can read a table that belongs to another service', async () => {
    await seed(pg);
    const probes: [Service, string][] = [
      ['enrolment', 'chronic.profile'],
      ['enrolment', 'identity.account'],
      ['records', 'ops.device_token'],
      ['records', 'care.escalation'],
      ['care_team', 'identity.account'],
      ['care_team', 'chronic.condition'],
      ['notification', 'record.observation'],
      ['notification', 'programme.enrolment'],
      ['realtime', 'record.observation'],
      ['realtime', 'identity.account'],
      ['realtime', 'ops.audit_event'],
      ['catalogue', 'chronic.medication'],
    ];
    for (const [service, table] of probes) {
      assert.equal(
        await failsWith(pg.databaseFor(service).withPrincipal(A, (tx) => tx.query(`SELECT 1 FROM ${table}`))),
        PERMISSION_DENIED,
        `${service} -> ${table}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // realtime-service
  // -------------------------------------------------------------------------

  void test('R-063: a consent\'s recipient must be a lowercase uuid or NULL, whoever writes it', async () => {
    await seed(pg);
    const rejected = ['someone@example.invalid', 'Jane Example', 'coach-4417', CLIN.toUpperCase(), ''];
    for (const recipient of rejected) {
      await assert.rejects(
        pg.admin(
          `INSERT INTO programme.sharing_consent (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
           VALUES ($1, 'notes', 'supporter', $2, 'v1', 'synthetic wording')`,
          [ENR_C, recipient],
        ),
        (error: { code?: string }) => error.code === '23514',
        `recipient_id ${JSON.stringify(recipient)} was accepted`,
      );
    }
    // A lowercase uuid, and NULL ("any recipient of this kind"), are accepted.
    await pg.admin(
      `INSERT INTO programme.sharing_consent (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
       VALUES ($1, 'notes', 'care_team', $2, 'v1', 'synthetic wording'), ($1, 'totals_and_adherence', 'care_team', NULL, 'v1', 'synthetic wording')`,
      [ENR_C, STRANGER],
    );
    // And the service role that writes consents is held to it too.
    await assert.rejects(
      pg.databaseFor('enrolment').withPrincipal(CLIN, (tx) =>
        tx.query(
          `INSERT INTO programme.sharing_consent (enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text)
           VALUES ($1, 'notes', 'supporter', 'someone@example.invalid', 'v1', 'synthetic wording')`,
          [ENR_C],
        ),
      ),
      (error: { code?: string }) => error.code === '23514',
      'the enrolment service wrote a non-uuid recipient',
    );
  });

  void test('realtime: the allow-list is the account\'s own enrolments plus those a live consent names it recipient of', async () => {
    await seed(pg);
    const db = pg.databaseFor('realtime');
    const list = async (who: string) => {
      const a = await db.withPrincipal(who, (tx) => resolveAllowlist(tx, who));
      return { owned: [...a.owned].sort(), shared: [...a.shared].sort() };
    };

    assert.deepEqual(await list(A), { owned: [ENR_A], shared: [] });
    assert.deepEqual(await list(B), { owned: [ENR_B], shared: [] }, 'B\'s revoked consent must not make ENR_B "shared" with CLIN');
    assert.deepEqual(await list(CLIN), { owned: [ENR_C], shared: [ENR_A] });
    assert.deepEqual(await list(CLIN2), { owned: [], shared: [ENR_A] });
    assert.deepEqual(await list(STRANGER), { owned: [], shared: [] });
  });

  void test('realtime: events from the database reach the owner and the recipient of an enrolment, and nobody else', async () => {
    await seed(pg);
    const db = pg.databaseFor('realtime');
    const received: ChangeNotification[] = [];
    const rawPayloads: string[] = [];
    const stop = await pg.listen('realtime', 'tether_change', (payload) => {
      rawPayloads.push(payload);
      const parsed = parseNotification(payload);
      if (parsed) received.push(parsed);
    });

    const who = [A, B, CLIN, CLIN2, STRANGER];
    const sinks = new Map<string, ChangeNotification[]>(who.map((w) => [w, []]));
    const subscribers: Subscriber[] = [];
    for (const account of who) {
      const list = await db.withPrincipal(account, (tx) => resolveAllowlist(tx, account));
      subscribers.push({
        accountId: account,
        owned: list.owned,
        shared: list.shared,
        send: (event) => {
          sinks.get(account)?.push(event);
          return true;
        },
      });
    }

    const waitFor = async (want: number): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (received.length < want) {
        if (Date.now() > deadline) throw new Error(`expected ${want} notifications, received ${received.length}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    // The real settle step: a revocation is resolved per recipient by asking the
    // database, under that recipient's own principal, whether their consent lives.
    const deliverNew = async (from: number): Promise<void> => {
      for (const event of received.slice(from)) {
        await dispatch(subscribers, event, (account, enrolment) =>
          db.withPrincipal(account, (tx) => holdsLiveConsent(tx, account, enrolment)),
        );
      }
    };
    const heard = (account: string): string[] => (sinks.get(account) ?? []).map((e) => `${e.table}:${e.op}${e.revoked === undefined ? '' : e.revoked ? ':revoked' : ':granted'}`);

    try {
      // A change to A's record.
      await pg.admin(`INSERT INTO record.observation (enrolment_id, measure_id, value_num, unit, observed_at) VALUES ('${ENR_A}', 'craving_intensity', 1, 'score', now())`);
      await waitFor(1);
      await deliverNew(0);
      assert.deepEqual(heard(A), ['record.observation:insert']);
      assert.deepEqual(heard(CLIN), ['record.observation:insert'], 'a recipient with a live consent hears changes');
      assert.deepEqual(heard(CLIN2), ['record.observation:insert']);
      assert.deepEqual(heard(B), [], 'B heard about A\'s record');
      assert.deepEqual(heard(STRANGER), []);

      // A change to B's record: only B.
      await pg.admin(`INSERT INTO record.observation (enrolment_id, measure_id, value_num, unit, observed_at) VALUES ('${ENR_B}', 'craving_intensity', 1, 'score', now())`);
      await waitFor(2);
      await deliverNew(1);
      assert.deepEqual(heard(B), ['record.observation:insert']);
      assert.deepEqual(heard(A).length, 1);
      assert.deepEqual(heard(CLIN).length, 1, 'CLIN\'s consent on B is revoked; it must not hear B\'s record');

      // R-033: A revokes CLIN's consent. The owner and the people holding a
      // consent on that enrolment hear it. B, who has no part in it, does not.
      await pg.admin(`UPDATE programme.sharing_consent SET revoked_at = now() WHERE id = '${CONSENT_CLIN_TOTALS}'`);
      await waitFor(3);
      await deliverNew(2);
      assert.ok(heard(A).includes('programme.sharing_consent:update:revoked'), 'the owner was not told');
      assert.ok(heard(CLIN).includes('programme.sharing_consent:update:revoked'), 'the recipient was not told its access ended');
      assert.deepEqual(heard(B).filter((h) => h.startsWith('programme.sharing_consent')), [], 'a stranger heard a consent revocation');
      assert.deepEqual(heard(CLIN2).filter((h) => h.startsWith('programme.sharing_consent')), [], 'another recipient was told somebody else\'s consent was withdrawn');
      assert.deepEqual(heard(STRANGER), [], 'an unrelated account heard a consent revocation');
      // R-063: the NOTIFY itself names no recipient, only the enrolment.
      assert.ok(rawPayloads.every((p) => !/recipient/i.test(p) && !p.includes(CLIN)), 'a recipient identifier was broadcast on tether_change');

      // After the revocation, CLIN hears nothing more about A's record...
      const before = heard(CLIN).length;
      await pg.admin(`INSERT INTO record.observation (enrolment_id, measure_id, value_num, unit, observed_at) VALUES ('${ENR_A}', 'craving_intensity', 2, 'score', now())`);
      await waitFor(4);
      await deliverNew(3);
      assert.equal(heard(CLIN).length, before, 'a withdrawn record is still being announced to its former recipient');
      // ...and the owner still does.
      assert.equal(heard(A).filter((h) => h === 'record.observation:insert').length, 2);
      // ...and so does the other recipient, whose own consent is still live.
      assert.equal(heard(CLIN2).filter((h) => h === 'record.observation:insert').length, 2, 'another recipient lost their view');
    } finally {
      await stop();
    }
  });

  void test('realtime: it holds no grant on the contents of any row it hears about', async () => {
    const db = pg.databaseFor('realtime');
    assert.equal(await failsWith(db.withPrincipal(A, (tx) => tx.query(`SELECT value_num FROM record.observation`))), PERMISSION_DENIED);
    assert.equal(await failsWith(db.withPrincipal(A, (tx) => tx.query(`SELECT consent_text FROM programme.sharing_consent`))), PERMISSION_DENIED);
  });

  // -------------------------------------------------------------------------
  // The principal
  // -------------------------------------------------------------------------

  void test('a transaction with no principal sees no patient row, whatever the role', async () => {
    await seed(pg);
    for (const [service, table] of [
      ['enrolment', 'programme.enrolment'],
      ['records', 'record.observation'],
      ['chronic', 'chronic.profile'],
      ['notification', 'ops.device_token'],
    ] as [Service, string][]) {
      const rows = await pg.databaseFor(service).withoutPrincipal((tx) => tx.query(`SELECT 1 FROM ${table}`));
      assert.deepEqual(rows, [], `${service} saw ${table} with no account set`);
    }
  });

  // Last on purpose: the role census at the top runs before the tests that make
  // a temporary owner, so it cannot see one left behind.
  void test('S4: no test leaves its helper role behind, and the function owners are back as they were', async () => {
    const leftover = await pg.admin<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname = 'rls_owner'`);
    assert.deepEqual(leftover, [], 'rls_owner was not dropped');
    const owners = await pg.admin<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(proowner) AS owner FROM pg_proc
        WHERE oid IN ('care.lapse_details(uuid)'::regprocedure, 'ops.release_device_token(text)'::regprocedure)`,
    );
    assert.equal(owners.length, 1, 'the two functions no longer share an owner');
  });
}
