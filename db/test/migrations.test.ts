import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Invariants over the migration set itself.
 *
 * None of this executes SQL — there is no Postgres in the environment these
 * run in. What it does check is the set of properties that, when they broke in
 * the backend this repo is modelled on, were not noticed until a fresh
 * environment failed to build.
 *
 * These were enforced by a custom runner until the migrations moved to
 * `supabase/migrations/` so that the GitHub integration's preview branches
 * could see them. The Supabase CLI does not check any of them, so they are
 * enforced here and gated in CI instead. That is the whole reason this file
 * exists: the guards had to survive the move, or the move would have been a
 * quiet downgrade.
 *
 * Every one of these was a real defect here first. The transaction-control
 * check below is the one that matters most: all seven files were originally
 * written with their own `BEGIN`/`COMMIT`, which would have left every
 * migration applied-but-unrecorded on any failure.
 */

const MIGRATIONS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'supabase',
  'migrations',
);

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const read = (name: string): string =>
  readFileSync(path.join(MIGRATIONS, name), 'utf8');

test('there are migrations to check', () => {
  assert.ok(files.length > 0, 'no .sql files found');
});

test('no migration manages its own transaction', () => {
  // The Supabase CLI wraps each file in a transaction together with its
  // ledger row. A `COMMIT` inside a file ends that transaction early and the
  // ledger insert then commits separately — a failure in the gap leaves a
  // migration that has run and is not recorded, and the next run applies it
  // again. All seven files here were originally written this way.
  //
  // Anchored to the line start so `BEGIN … END` inside a plpgsql body, which
  // is block syntax rather than transaction control, is not matched.
  const offenders: string[] = [];

  for (const name of files) {
    read(name)
      .split('\n')
      .forEach((line, index) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(line.trim())) {
          offenders.push(`${name}:${index + 1} ${line.trim()}`);
        }
      });
  }

  assert.deepEqual(
    offenders,
    [],
    `migrations must not open or close transactions:\n${offenders.join('\n')}`,
  );
});

test('filenames sort into apply order', () => {
  // Supabase records the leading 14-digit UTC timestamp as the migration
  // version in `supabase_migrations.schema_migrations`, and applies files in
  // lexical order — so the prefix is what decides apply order, not a comment.
  const pattern = /^\d{14}_[a-z0-9_]+\.sql$/;
  const malformed = files.filter((name) => !pattern.test(name));
  assert.deepEqual(malformed, [], 'expected YYYYMMDDHHmmss_snake_case.sql');
});

test('no two migrations share a version', () => {
  // Two branches generating a migration in the same second. Supabase keys its
  // ledger on the version, so a collision means one of the two is recorded as
  // applied when it never ran.
  const byPrefix = new Map<string, string[]>();
  for (const name of files) {
    const prefix = name.slice(0, 14);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }

  const collisions = [...byPrefix.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([prefix, group]) => `${prefix}: ${group.join(', ')}`);

  assert.deepEqual(collisions, []);
});

test('every extension a migration relies on is created', () => {
  // `citext` was used for two email columns with no `CREATE EXTENSION`, so the
  // first migration would have failed on the first clean database it met.
  // `gen_random_uuid()` needs no extension on PostgreSQL 13+ and is therefore
  // not checked here.
  const all = files.map(read).join('\n');
  if (/\bcitext\b/i.test(all)) {
    assert.match(
      all,
      /CREATE EXTENSION IF NOT EXISTS citext/i,
      'citext is used but never created',
    );
  }
});

test('every table holding patient data has RLS enabled and forced', () => {
  // ENABLE alone is not enough: without FORCE the owning role bypasses every
  // policy, and the owner is what migrations and maintenance scripts connect
  // as. The model repo enabled RLS on one table, attached no policy to it, and
  // left ~138 tables of health and financial data with none at all.
  const all = files.map(read).join('\n');

  const phiTables = [
    'programme.enrolment',
    'programme.sharing_consent',
    'record.screen_answer',
    'record.lapse_event',
    'record.observation',
    'identity.child_profile',
  ];

  for (const table of phiTables) {
    const enabled = new RegExp(
      `ALTER TABLE ${table.replace('.', '\\.')}\\s+ENABLE ROW LEVEL SECURITY`,
      'i',
    );
    const forced = new RegExp(
      `ALTER TABLE ${table.replace('.', '\\.')}\\s+FORCE\\s+ROW LEVEL SECURITY`,
      'i',
    );
    assert.match(all, enabled, `${table} does not ENABLE row level security`);
    assert.match(all, forced, `${table} does not FORCE row level security`);
    assert.match(
      all,
      new RegExp(`CREATE POLICY[\\s\\S]{0,200}ON ${table.replace('.', '\\.')}`, 'i'),
      `${table} has RLS but no policy, which denies everything silently`,
    );
  }
});

test('no PHI table carries a soft-delete column', () => {
  // `export_and_delete` asks that deletion be "completed rather than hidden".
  // A `deleted_at` on a health row is precisely the hidden kind.
  const record = files
    .filter((name) => /record|chronic/.test(name))
    .map(read)
    .join('\n');

  assert.doesNotMatch(
    record,
    /\bdeleted_at\b/i,
    'a PHI table has a soft-delete column',
  );
});

// ---------------------------------------------------------------------------
// Service roles (R-032). Static checks on the text of the migrations; what the
// roles can actually do is `service-roles.integration.test.ts`, against a real
// Postgres, and is skipped where there is none.
// ---------------------------------------------------------------------------

/** The SQL with `--` comments removed, so prose cannot satisfy or trip a check. */
const code = (name: string): string =>
  read(name)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

test('no migration sets a password or carries a credential', () => {
  // A password in a migration is a password in every clone of the repository.
  // Roles are created locked and the operator sets the password out of band.
  for (const name of files) {
    const sql = code(name);
    assert.doesNotMatch(sql, /\bPASSWORD\b/i, `${name} mentions PASSWORD`);
    assert.doesNotMatch(sql, /postgres(ql)?:\/\/[^\s]*:[^\s@]+@/i, `${name} contains a connection string`);
  }
});

test('no migration creates or alters a role to be a superuser, to bypass RLS, or to create roles', () => {
  const offenders: string[] = [];
  for (const name of files) {
    // `NOSUPERUSER` and friends are the point; a bare `SUPERUSER` is not.
    for (const match of code(name).matchAll(/(?<!NO)\b(SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB|REPLICATION)\b/gi)) {
      offenders.push(`${name}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every login role is created locked and is never given a password here', () => {
  const sql = code('20260914120800_service_roles.sql');
  assert.match(sql, /LOGIN VALID UNTIL %L/, 'login roles are not created with a VALID UNTIL');
  assert.match(sql, /'-infinity'/, 'login roles are not created locked');
  // The re-assertion on every apply must not touch VALID UNTIL, or applying a
  // migration would lock a service out of its own database.
  const alter = /ALTER ROLE %I LOGIN[^']*'/.exec(sql)?.[0] ?? '';
  assert.doesNotMatch(alter, /VALID UNTIL/i);
  for (const attribute of ['NOSUPERUSER', 'NOBYPASSRLS', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION']) {
    assert.match(sql, new RegExp(attribute), `the roles migration never states ${attribute}`);
  }
});

test('grants to service roles are explicit: no GRANT ALL, no grant option, no schema CREATE', () => {
  const sql = code('20260914121000_service_grants.sql');
  assert.doesNotMatch(sql, /GRANT\s+ALL\b/i, 'a service role is granted ALL');
  assert.doesNotMatch(sql, /WITH\s+GRANT\s+OPTION/i);
  assert.doesNotMatch(sql, /GRANT\s+(USAGE,\s*)?CREATE\b/i);
  assert.doesNotMatch(sql, /\bTO\s+PUBLIC\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b|\bREFERENCES\b|\bTRIGGER\b/);
});

test('no existing migration was edited to make room for the service roles', () => {
  // The roles, grants and policy fixes are new files. 0001 to 0008 are the
  // history other environments have already applied.
  const added = files.filter((name) => name.slice(0, 14) > '20260914120700');
  assert.deepEqual(added, [
    '20260914120800_service_roles.sql',
    '20260914120900_rls_consent_policies.sql',
    '20260914121000_service_grants.sql',
  ]);
});

test('every table the new policies protect still has RLS forced', () => {
  const all = files.map(read).join('\n');
  for (const table of ['ops.audit_event', 'identity.account', 'ops.waitlist_enquiry']) {
    const escaped = table.replace('.', '\\.');
    assert.match(all, new RegExp(`ALTER TABLE ${escaped}\\s+ENABLE ROW LEVEL SECURITY`, 'i'), table);
    assert.match(all, new RegExp(`ALTER TABLE ${escaped}\\s+FORCE\\s+ROW LEVEL SECURITY`, 'i'), table);
  }
});

test('the SECURITY DEFINER functions pin their search_path and are not executable by PUBLIC', () => {
  const sql = code('20260914120900_rls_consent_policies.sql');
  // One chunk per function, so one function's text cannot satisfy another's check.
  const definers = sql
    .split(/CREATE OR REPLACE FUNCTION /i)
    .slice(1)
    .filter((chunk) => /SECURITY DEFINER/i.test(chunk.split(/\$\$/)[0] ?? ''));

  const names = definers.map((chunk) => /^([\w.]+)\(/.exec(chunk)?.[1]);
  assert.deepEqual(names, ['care.lapse_details', 'ops.release_device_token']);

  for (const chunk of definers) {
    const name = /^([\w.]+)\(/.exec(chunk)?.[1] ?? '';
    assert.match(chunk, /SET search_path = pg_catalog, public/, `${name} does not pin its search_path`);
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON FUNCTION ${name.replace('.', '\\.')}\\([^)]*\\) FROM PUBLIC`),
      `${name} is executable by PUBLIC`,
    );
  }
});
