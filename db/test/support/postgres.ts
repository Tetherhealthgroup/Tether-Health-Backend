import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { createDatabase, createLogger, type Database, type Transaction } from '@tether/core';

/**
 * A disposable PostgreSQL for the suites that have to run real SQL under real
 * row-level security.
 *
 * Nothing here is a mock. The point of `service-roles.integration.test.ts` is to
 * apply every migration to a real server and then connect *as each service's
 * login role*, so that is what this does: a throwaway `postgres:16-alpine`
 * container, `supabase/migrations/*.sql` applied in order, a random password set
 * on every login role, and one `Database` per service built by the same
 * `createDatabase` the service itself uses.
 *
 * When Docker is not there the suite is *skipped*, with the reason, rather than
 * faked. A skipped suite and a passing suite look different in the TAP output,
 * and that difference is the whole of the honesty: the DB-level claims in this
 * repository are only claims when this ran.
 *
 * Two escape hatches, both for running the same assertions somewhere else:
 *
 *   TETHER_PG_TEST_DRIVER  path to a module exporting `start(): Promise<TestPostgres>`
 *                          — any server that can be made to satisfy the interface.
 *   TETHER_PG_TEST_SKIP=1  skip unconditionally (for a machine where `docker info`
 *                          answers but containers are not wanted).
 */

export const SERVICES = [
  'auth',
  'catalogue',
  'enrolment',
  'records',
  'care_team',
  'notification',
  'website',
  'chronic',
  'realtime',
] as const;

export type Service = (typeof SERVICES)[number];

export const groupRole = (service: Service): string => `tether_${service}`;
export const loginRole = (service: Service): string => `tether_${service}_login`;

export interface TestPostgres {
  /** What this is running on, for the test output. */
  readonly description: string;

  /**
   * True when a service's login role is really connected to with a password.
   * False for a driver that can only switch role inside one session, which
   * cannot exercise `LOGIN`, `VALID UNTIL` or password authentication.
   */
  readonly canLogin: boolean;

  /** As the superuser. Bypasses RLS; for seeding and for reading the truth back. */
  admin<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;

  /**
   * One transaction as `role`, with `app.account_id` set to `accountId`
   * (or unset, for null). Rolled back unless `commit` is true.
   *
   * Used for asking what a *policy* does, apart from what a *grant* does: the
   * role is typically a probe holding every privilege, so that the only thing
   * left between it and a row is RLS.
   */
  asRole<T>(
    role: string,
    accountId: string | null,
    fn: (tx: Transaction) => Promise<T>,
    options?: { commit?: boolean },
  ): Promise<T>;

  /** The service's own `Database`, connected as its login role. */
  databaseFor(service: Service): Database;

  /** Sets a password on one login role and leaves it locked: the operator who forgets the second half. */
  setPasswordOnly(service: Service): Promise<void>;

  /** Sets a password on every login role and clears the lock. The operator's step. */
  unlockLoginRoles(): Promise<void>;

  /** Whether `role` can open a connection with its current credentials. */
  canConnectAs(service: Service): Promise<boolean>;

  /** Subscribes, as the service's login role, to a NOTIFY channel. */
  listen(
    service: Service,
    channel: string,
    onPayload: (payload: string) => void,
  ): Promise<() => Promise<void>>;

  stop(): Promise<void>;
}

export type Started = { readonly postgres: TestPostgres } | { readonly skip: string };

const MIGRATIONS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
);

/** The last migration written before per-service roles existed. */
const LAST_PRE_ROLES = '20260914120700';

export function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
}

/**
 * Applies every migration, in order, each in its own transaction — the way the
 * Supabase CLI does — and stages what a hosted project would already contain.
 *
 * Staged between 0008 and 0009: the Supabase API roles, with the broad default
 * grants a hosted project can carry, and the `supabase_realtime` publication.
 * Migrations are not edited to suit this; `20260914120800_service_roles.sql` is
 * what has to take those grants away, and `20260914120700_realtime.sql` is what
 * has to cope with the publication being there.
 */
export async function applyMigrations(
  run: (sql: string) => Promise<unknown>,
): Promise<void> {
  let staged = false;
  for (const { name, sql } of migrationFiles()) {
    if (!staged && name.slice(0, 14) > LAST_PRE_ROLES) {
      await run(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        END $$;
        GRANT USAGE ON SCHEMA identity, catalogue, programme, record, care, chronic, ops TO anon, authenticated;
        GRANT ALL ON ALL TABLES IN SCHEMA identity, catalogue, programme, record, care, chronic, ops TO anon, authenticated;
      `);
      staged = true;
    }
    await run(`BEGIN;\n${sql}\nCOMMIT;`).catch(async (error: unknown) => {
      await run('ROLLBACK').catch(() => undefined);
      throw new Error(`migration ${name} failed: ${(error as Error).message}`, { cause: error });
    });
  }
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

const IMAGE = 'postgres:16-alpine';

/**
 * The container could not be started at all — typically no network to pull the
 * image, or a daemon that answers `info` but refuses to run. That is "no
 * database here", which is a skip; anything that goes wrong *after* the
 * container exists is a real failure and is thrown as one.
 */
class ContainerNotStarted extends Error {}

function dockerUnavailable(): string | null {
  if (process.env.TETHER_PG_TEST_SKIP === '1') {
    return 'TETHER_PG_TEST_SKIP=1';
  }
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (probe.error) {
    return `docker is not installed or not runnable (${probe.error.message})`;
  }
  if (probe.status !== 0) {
    return `the docker daemon is not answering (${probe.stderr.trim().split('\n')[0] ?? 'no output'})`;
  }
  return null;
}

const silent = createLogger({ serviceName: 'pg-test', level: 'silent', environment: 'test' });

function wrap(client: pg.ClientBase): Transaction {
  return {
    async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      return (await client.query<R>(sql, params as unknown[])).rows;
    },
    async one<R extends pg.QueryResultRow = pg.QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R | null> {
      const rows = (await client.query<R>(sql, params as unknown[])).rows;
      if (rows.length > 1) throw new Error(`expected at most one row, received ${rows.length}`);
      return rows[0] ?? null;
    },
  };
}

async function startDocker(): Promise<TestPostgres> {
  const containerName = `tether-rls-test-${randomBytes(4).toString('hex')}`;
  const superuserPassword = randomBytes(18).toString('hex');
  const rolePasswords = new Map<Service, string>(
    SERVICES.map((service) => [service, randomBytes(18).toString('hex')]),
  );

  const run = spawnSync(
    'docker',
    [
      'run', '--detach', '--rm',
      '--name', containerName,
      '--publish', '127.0.0.1::5432',
      '--env', `POSTGRES_PASSWORD=${superuserPassword}`,
      '--env', 'POSTGRES_DB=tether',
      '--env', 'POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8',
      IMAGE,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  );
  if (run.status !== 0) {
    throw new ContainerNotStarted(`docker run failed: ${run.stderr.trim().split('\n').pop() ?? ''}`);
  }

  const stopContainer = (): void => {
    spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
  };
  // A suite killed half way must not leave a database running.
  process.once('exit', stopContainer);

  const mapping = spawnSync('docker', ['port', containerName, '5432/tcp'], { encoding: 'utf8' });
  const port = Number(/:(\d+)\s*$/m.exec(mapping.stdout)?.[1]);
  if (!Number.isInteger(port)) {
    stopContainer();
    throw new Error(`could not read the published port: ${mapping.stdout}${mapping.stderr}`);
  }

  const dsn = (user: string, password: string): string =>
    `postgres://${user}:${password}@127.0.0.1:${port}/tether`;

  const adminPool = new pg.Pool({
    connectionString: dsn('postgres', superuserPassword),
    max: 2,
    connectionTimeoutMillis: 3_000,
  });
  adminPool.on('error', () => undefined);

  // `initdb` starts and stops a server before the real one, so the first
  // successful connection can be followed by a restart. Waiting for two in a
  // row is the cheap way to be past it.
  const deadline = Date.now() + 90_000;
  let consecutive = 0;
  for (;;) {
    try {
      await adminPool.query('SELECT 1');
      consecutive += 1;
      if (consecutive >= 2) break;
    } catch {
      consecutive = 0;
    }
    if (Date.now() > deadline) {
      stopContainer();
      throw new Error('postgres did not become ready within 90 seconds');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const admin = async <R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> => (await adminPool.query<R>(sql, params as unknown[])).rows;

  // Migrations run on one dedicated connection so BEGIN/COMMIT mean something.
  const migrator = await adminPool.connect();
  try {
    await applyMigrations((sql) => migrator.query(sql));
  } finally {
    migrator.release();
  }

  const databases = new Map<Service, Database>();
  const listeners = new Set<pg.Client>();

  const postgres: TestPostgres = {
    description: `${IMAGE} in docker (${containerName}), connecting as each service's login role`,
    canLogin: true,
    admin,

    async asRole(role, accountId, fn, options = {}) {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${pg.escapeIdentifier(role)}`);
        if (accountId !== null) {
          await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
        }
        const result = await fn(wrap(client));
        await client.query(options.commit ? 'COMMIT' : 'ROLLBACK');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    databaseFor(service) {
      let database = databases.get(service);
      if (!database) {
        database = createDatabase({
          connectionString: dsn(loginRole(service), rolePasswords.get(service) ?? ''),
          max: 2,
          statementTimeoutMs: 15_000,
          applicationName: `pg-test-${service}`,
          logger: silent,
        });
        databases.set(service, database);
      }
      return database;
    },

    async setPasswordOnly(service) {
      await admin(
        `ALTER ROLE ${pg.escapeIdentifier(loginRole(service))} PASSWORD ${pg.escapeLiteral(rolePasswords.get(service) ?? '')}`,
      );
    },

    async unlockLoginRoles() {
      for (const service of SERVICES) {
        // Exactly what db/ROLES.md tells an operator to run.
        await admin(
          `ALTER ROLE ${pg.escapeIdentifier(loginRole(service))} PASSWORD ${pg.escapeLiteral(rolePasswords.get(service) ?? '')} VALID UNTIL 'infinity'`,
        );
      }
    },

    async canConnectAs(service) {
      const client = new pg.Client({
        connectionString: dsn(loginRole(service), rolePasswords.get(service) ?? ''),
        connectionTimeoutMillis: 5_000,
      });
      client.on('error', () => undefined);
      try {
        await client.connect();
        return true;
      } catch {
        return false;
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async listen(service, channel, onPayload) {
      const client = new pg.Client({
        connectionString: dsn(loginRole(service), rolePasswords.get(service) ?? ''),
      });
      client.on('error', () => undefined);
      client.on('notification', (message) => {
        if (message.channel === channel && message.payload) onPayload(message.payload);
      });
      await client.connect();
      await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      listeners.add(client);
      return async () => {
        listeners.delete(client);
        await client.end().catch(() => undefined);
      };
    },

    async stop() {
      for (const client of listeners) await client.end().catch(() => undefined);
      for (const database of databases.values()) await database.close().catch(() => undefined);
      await adminPool.end().catch(() => undefined);
      stopContainer();
      process.removeListener('exit', stopContainer);
    },
  };

  return postgres;
}

/**
 * A running test database, or the reason there is not one.
 */
export async function startPostgres(): Promise<Started> {
  const driver = process.env.TETHER_PG_TEST_DRIVER;
  if (driver) {
    const module = (await import(pathToFileURL(path.resolve(driver)).href)) as {
      start: () => Promise<TestPostgres>;
    };
    return { postgres: await module.start() };
  }

  const reason = dockerUnavailable();
  if (reason) return { skip: reason };

  try {
    return { postgres: await startDocker() };
  } catch (error) {
    if (error instanceof ContainerNotStarted) return { skip: error.message };
    throw error;
  }
}
