/**
 * The migration runner. One ledger, one order, one way to fail.
 *
 *     node --experimental-strip-types db/migrate.ts [--dry-run] [--verify-only]
 *
 * Why this file is fifty lines longer than "read the directory and run it":
 *
 * The backend this repo is modelled on had **three** competing ledgers —
 * Alembic's `alembic_version`, a hand-rolled `migrations` table, and a set of
 * `IF NOT EXISTS` scripts that recorded nothing at all. Because no single table
 * knew the truth, a run that failed halfway recorded nothing for the statements
 * it had already committed, and the next run started again from the top. On a
 * schema built from `CREATE TABLE IF NOT EXISTS` that looks like success; on one
 * with real constraints it is a wall of errors that somebody then "fixes" by
 * editing an old migration file in place.
 *
 * So four properties, in the order they matter:
 *
 *   1. **One ledger.** `ops.schema_migration`, and nothing else is consulted.
 *   2. **Each file in its own transaction, with its ledger row inside it.**
 *      Applying a migration and recording it either both happen or neither
 *      does. A partial apply is therefore not a state this can reach.
 *   3. **No migration may open or close a transaction of its own.** A `COMMIT`
 *      inside a file would end the transaction this runner opened and leave the
 *      ledger row to commit separately — reintroducing exactly the window
 *      property 2 closes. `0001_foundation.sql` states the rule;
 *      `assertNoTransactionControl`
 *      below is what makes it true, because a rule in a comment is a rule until
 *      somebody is in a hurry.
 *   4. **Checksums are verified before anything is applied.** Editing a
 *      committed migration is the failure this is built to catch: the file now
 *      says something the database has never been told, every fresh environment
 *      gets the new version, every existing one keeps the old, and the two
 *      diverge silently for as long as nobody looks. That is a hard stop, with
 *      the filename, both hashes and the instruction to write a new migration
 *      instead.
 *
 * Every check runs across the whole directory *first*. A drifted file at 0003
 * stops the run before 0006 is applied, rather than after — half-applying a set
 * you already know is inconsistent only makes the recovery harder.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Named import, matching `packages/core/src/db.ts`. `@types/pg` declares no
// default export and the repo does not enable `esModuleInterop`, so
// `import pg from 'pg'` would not typecheck here even though it runs.
import { Client } from 'pg';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/** Filenames must sort lexically into apply order, so the prefix is mandatory. */
const FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * A lock id, not a lock table.
 *
 * Two runners starting at once — a deploy and somebody's terminal — would each
 * read an empty ledger and each apply 0006. `pg_advisory_lock` is held for the
 * session and released when it ends, including when the process is killed, so
 * a crashed run cannot leave the lock behind for a human to clear. The number
 * is arbitrary but fixed; it only has to be the same in both processes.
 */
const ADVISORY_LOCK_ID = 4_919_231_071;

interface Migration {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

// A `type`, not an `interface`, on purpose: `pg`'s `query<R>` constrains R to
// `QueryResultRow`, which carries an index signature. TypeScript gives object
// *type aliases* an implicit index signature and interfaces none, so an
// interface here fails the constraint for reasons that have nothing to do with
// this file.
type LedgerRow = {
  filename: string;
  checksum: string;
  applied_at: Date;
};

/** sha256 over the bytes, so a whitespace-only edit is still an edit. */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Blanks out everything in `sql` that is not executable SQL.
 *
 * Comments, single-quoted literals and dollar-quoted blocks are replaced with
 * spaces of the same length, so offsets are preserved and a reported line
 * number still points at the right line.
 *
 * Dollar quoting is the part that has to be right. PL/pgSQL bodies are full of
 * `BEGIN … END`:
 *
 *     CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
 *       BEGIN NEW.updated_at := now(); RETURN NEW; END
 *     $$;
 *
 * That `BEGIN` is a block, not a transaction, and a check that could not tell
 * the two apart would reject `0001_foundation.sql` — which would make the rule
 * unusable and therefore make it disappear.
 */
function stripNonCode(sql: string): string {
  const out = sql.split('');
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      // Newlines are kept so line numbers survive.
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      // Postgres block comments nest, unlike C's.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2; // an escaped quote inside the literal
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === '$') {
      const tag = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const close = sql.indexOf(marker, i + marker.length);
        const stop = close === -1 ? sql.length : close + marker.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    i += 1;
  }

  return out.join('');
}

/**
 * Statement-initial transaction control, with the line it is on.
 *
 * Anchored to the start of a statement — the beginning of the file or a
 * preceding `;` — because `END` also closes a `CASE`, and `BEGIN` also opens a
 * PL/pgSQL block. After [stripNonCode] the block bodies are gone, and the
 * anchor handles the rest.
 */
const TX_CONTROL =
  /(?:^|;)\s*(BEGIN|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|START\s+TRANSACTION|SET\s+TRANSACTION)\b/gi;

function findTxControl(sql: string): Array<{ line: number; keyword: string }> {
  const code = stripNonCode(sql);
  const found: Array<{ line: number; keyword: string }> = [];

  for (const match of code.matchAll(TX_CONTROL)) {
    const keyword = match[1];
    if (!keyword) continue;
    const at = (match.index ?? 0) + match[0].indexOf(keyword[0]!);
    const line = code.slice(0, at).split('\n').length;
    found.push({ line, keyword: keyword.toUpperCase().replace(/\s+/g, ' ') });
  }

  return found;
}

async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    // Plain lexical sort, and the filename pattern is what makes that a
    // sensible order. `localeCompare` is deliberately avoided: it is
    // locale-dependent, so the apply order would differ between a developer's
    // laptop and a container with a different LANG.
    .sort();

  const malformed = names.filter((name) => !FILENAME.test(name));
  if (malformed.length > 0) {
    throw new Error(
      `Migration filenames must look like 0001_name.sql — these do not:\n` +
        malformed.map((name) => `  ${name}`).join('\n'),
    );
  }

  const duplicates = new Map<string, string[]>();
  for (const name of names) {
    const prefix = name.slice(0, 4);
    duplicates.set(prefix, [...(duplicates.get(prefix) ?? []), name]);
  }
  const collisions = [...duplicates.entries()].filter(
    ([, group]) => group.length > 1,
  );
  if (collisions.length > 0) {
    // Two people numbered a migration 0006 on different branches. Lexical order
    // would silently pick one to go first, and which one depends on the rest of
    // the filename — a coin toss deciding schema order is not an order.
    throw new Error(
      `Two migrations share a number. Renumber one before merging:\n` +
        collisions
          .map(([prefix, group]) => `  ${prefix}: ${group.join(', ')}`)
          .join('\n'),
    );
  }

  const migrations = await Promise.all(
    names.map(async (filename) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: checksumOf(sql) };
    }),
  );

  // Checked across the whole directory before anything is applied, and checked
  // for files that are *already* applied too. A `COMMIT` added to 0003 after it
  // ran is still a rule that has stopped being enforced, and finding it now is
  // better than finding it the next time somebody builds an environment from
  // scratch. [apply] checks again, per file, as a last line of defence.
  for (const migration of migrations) assertNoTransactionControl(migration);

  return migrations;
}

/**
 * Creates the ledger if it is not there.
 *
 * `IF NOT EXISTS` is acceptable for exactly this one table and nowhere else in
 * the repo: it is the table that records whether the others exist, so it cannot
 * itself be recorded.
 */
async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS ops;

    CREATE TABLE IF NOT EXISTS ops.schema_migration (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      applied_by  text NOT NULL DEFAULT current_user,
      duration_ms integer
    );
  `);
}

interface Drift {
  readonly filename: string;
  readonly recorded: string;
  readonly onDisk: string;
  readonly appliedAt: Date;
}

/**
 * Compares every ledger row against the file it names.
 *
 * Returns both kinds of divergence, because they mean different things and
 * both are fatal:
 *
 *   `edited`  — the file changed after it was applied. The database and the
 *               repository now disagree about what 0003 did.
 *   `missing` — the ledger names a file that is no longer in the directory.
 *               Usually a deleted or renamed migration, which makes every
 *               environment's history unreproducible from this checkout.
 */
function findDrift(
  migrations: readonly Migration[],
  ledger: readonly LedgerRow[],
): { edited: Drift[]; missing: LedgerRow[] } {
  const onDisk = new Map(migrations.map((m) => [m.filename, m]));
  const edited: Drift[] = [];
  const missing: LedgerRow[] = [];

  for (const row of ledger) {
    const file = onDisk.get(row.filename);
    if (!file) {
      missing.push(row);
      continue;
    }
    if (file.checksum !== row.checksum) {
      edited.push({
        filename: row.filename,
        recorded: row.checksum,
        onDisk: file.checksum,
        appliedAt: row.applied_at,
      });
    }
  }

  return { edited, missing };
}

function reportDrift(drift: {
  edited: Drift[];
  missing: LedgerRow[];
}): string {
  const lines: string[] = [];

  for (const item of drift.edited) {
    lines.push(
      `  ${item.filename} has changed since it was applied on ` +
        `${item.appliedAt.toISOString()}.`,
      `      recorded: ${item.recorded}`,
      `      on disk:  ${item.onDisk}`,
    );
  }

  for (const row of drift.missing) {
    lines.push(
      `  ${row.filename} is recorded as applied on ` +
        `${row.applied_at.toISOString()} but is not in db/migrations/.`,
    );
  }

  return lines.join('\n');
}

/**
 * Rejects a migration that manages its own transaction.
 *
 * Not a style rule. [apply] opens a transaction so the DDL and the ledger row
 * commit together; a `COMMIT` inside the file ends that transaction early, and
 * the ledger insert then commits separately afterwards. A failure in the gap
 * leaves a migration that has run and is not recorded — which the next run
 * applies a second time. The model repo had exactly this failure mode, across
 * three competing ledgers.
 *
 * It has to be caught here because Postgres only *warns* on a nested `BEGIN`
 * and on a `COMMIT` with no transaction open, so nothing announces it at
 * runtime. Every file in this repo was written with `BEGIN`/`COMMIT` and swept
 * once; this is what stops the eighth one reintroducing it.
 *
 * The detection is [findTxControl], not a line-by-line regular expression.
 * Matching on whole lines misses `CREATE INDEX …; COMMIT;` written on one line,
 * and it cannot tell a `plpgsql` body's `BEGIN … END` — block syntax, not
 * transaction control — from the real thing. [findTxControl] blanks comments,
 * string literals and dollar-quoted bodies first, then anchors to the start of
 * a statement, so both cases come out right.
 */
function assertNoTransactionControl(migration: Migration): void {
  const offending = findTxControl(migration.sql);
  if (offending.length === 0) return;

  const where = offending
    .map((hit) => `line ${hit.line}: ${hit.keyword}`)
    .join('; ');
  throw new Error(
    `${migration.filename} manages its own transaction (${where}). ` +
      'Migrations must not: the runner wraps each file together with its ' +
      'ledger row so that the two commit as one.',
  );
}

/**
 * Applies one file inside one transaction, with its ledger row.
 *
 * The pair commits or neither does, which is what makes a re-run after a
 * failed migration safe.
 */
async function apply(client: Client, migration: Migration): Promise<number> {
  assertNoTransactionControl(migration);

  const startedAt = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    const durationMs = Date.now() - startedAt;
    await client.query(
      `INSERT INTO ops.schema_migration (filename, checksum, duration_ms)
       VALUES ($1, $2, $3)`,
      [migration.filename, migration.checksum, durationMs],
    );
    await client.query('COMMIT');
    return durationMs;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      // The connection is already unusable; the original error is the one
      // worth surfacing, so a failed rollback is not allowed to mask it.
    });
    throw error;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const verifyOnly = args.has('--verify-only');

  // A separate DSN is honoured because migrations need DDL rights and the
  // services deliberately do not have them. Falling back to DATABASE_URL keeps
  // local development to one variable.
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      'Set MIGRATION_DATABASE_URL (preferred) or DATABASE_URL before running migrations.',
    );
  }

  const migrations = await loadMigrations();
  const client = new Client({
    connectionString,
    application_name: 'tether-migrate',
    // No statement timeout. A migration that adds an index to a large table is
    // supposed to take minutes, and killing it halfway is how you get a schema
    // nobody can describe.
    statement_timeout: 0,
  });

  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await ensureLedger(client);

    const ledger = await client.query<LedgerRow>(
      'SELECT filename, checksum, applied_at FROM ops.schema_migration ORDER BY filename',
    );

    const drift = findDrift(migrations, ledger.rows);
    if (drift.edited.length > 0 || drift.missing.length > 0) {
      // Loud, and specific about the remedy. The instinct on seeing a checksum
      // failure is to "fix" it by updating the ledger; that hides the
      // divergence instead of resolving it, and the next fresh environment
      // still gets a different schema from this one.
      throw new Error(
        'A migration that has already been applied no longer matches the file ' +
          'in this checkout.\n\n' +
          reportDrift(drift) +
          '\n\n' +
          'A committed migration is history and cannot be rewritten. Restore ' +
          'the file to the version that was applied and add a new migration ' +
          'with the change you meant to make. Do not update the checksum in ' +
          'ops.schema_migration: that makes the two environments agree on a ' +
          'record while they still disagree on a schema.',
      );
    }

    const applied = new Set(ledger.rows.map((row) => row.filename));
    const pending = migrations.filter((m) => !applied.has(m.filename));

    // An old file appearing after newer ones have already run — a migration
    // merged from a long-lived branch. Applying it out of order would mean the
    // schema a fresh database gets is not the schema this one has.
    const newest = [...applied].sort().at(-1);
    const outOfOrder = newest
      ? pending.filter((m) => m.filename < newest)
      : [];
    if (outOfOrder.length > 0) {
      throw new Error(
        `These migrations sort before ${newest}, which is already applied:\n` +
          outOfOrder.map((m) => `  ${m.filename}`).join('\n') +
          '\n\nRenumber them to the end so that a database built from scratch ' +
          'and this one end up the same. Order is part of the schema.',
      );
    }

    console.log(
      `${migrations.length} migration(s) on disk, ${applied.size} applied, ` +
        `${pending.length} pending.`,
    );

    if (verifyOnly) {
      console.log('Checksums verified. --verify-only, so nothing was applied.');
      // Pending work is not an error for a verification run, but it is
      // something CI should be able to see without reading the log.
      if (pending.length > 0) {
        console.log(
          'Pending:\n' + pending.map((m) => `  ${m.filename}`).join('\n'),
        );
      }
      return;
    }

    if (pending.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    for (const migration of pending) {
      if (dryRun) {
        console.log(`would apply ${migration.filename} (${migration.checksum.slice(0, 12)})`);
        continue;
      }
      process.stdout.write(`applying ${migration.filename} … `);
      const durationMs = await apply(client, migration);
      console.log(`ok (${durationMs} ms)`);
    }

    console.log(dryRun ? 'Dry run complete.' : 'Migrations applied.');
  } finally {
    // Advisory locks are session-scoped, so ending the client releases this
    // one; the explicit unlock is here so the intent survives somebody later
    // making the client long-lived.
    await client
      .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID])
      .catch(() => {});
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nMigration run failed.\n\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  // Non-zero, always. A migration step that exits 0 on failure is how the model
  // repo's pipeline reported a green deploy onto a schema that had not changed.
  process.exit(1);
});
