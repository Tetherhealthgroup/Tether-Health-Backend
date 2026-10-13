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

void test('there are migrations to check', () => {
  assert.ok(files.length > 0, 'no .sql files found');
});

void test('no migration manages its own transaction', () => {
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

void test('filenames sort into apply order', () => {
  // Supabase records the leading 14-digit UTC timestamp as the migration
  // version in `supabase_migrations.schema_migrations`, and applies files in
  // lexical order — so the prefix is what decides apply order, not a comment.
  const pattern = /^\d{14}_[a-z0-9_]+\.sql$/;
  const malformed = files.filter((name) => !pattern.test(name));
  assert.deepEqual(malformed, [], 'expected YYYYMMDDHHmmss_snake_case.sql');
});

void test('no two migrations share a version', () => {
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

void test('every extension a migration relies on is created', () => {
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

void test('every table holding patient data has RLS enabled and forced', () => {
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

void test('no PHI table carries a soft-delete column', () => {
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
