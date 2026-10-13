import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Logger } from './logger.ts';

/**
 * Postgres access, scoped to the caller.
 *
 * The important part of this file is [withPrincipal]. The model repo connected
 * every service with Supabase's service-role key, which bypasses row-level
 * security entirely — so its RLS policies, such as they were, could never fire.
 * RLS you cannot reach is decoration.
 *
 * Here each service connects as its own least-privileged role, and every
 * request sets `app.account_id` on its transaction. Policies read that setting,
 * so a query that forgets its `WHERE account_id = …` returns nothing instead of
 * returning somebody else's rows.
 *
 * That is not hypothetical. In `chronic-care`'s existing FastAPI backend, 17 of
 * its 20 authenticated routes take a `user_id` and never use it —
 * `GET /profile` runs `select(Profile).order_by(created_at).limit(1)` and hands
 * the oldest profile in the table to whoever asked. Under RLS that bug returns
 * an empty set rather than another patient's record.
 */

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refuses anything that is not a UUID before it reaches `app.account_id`.
 *
 * Every policy reads the setting through `app_account_id()`, which casts it to
 * `uuid`. A value that does not cast makes that call raise on every statement,
 * which fails closed but reads as a database fault, and a value that is empty
 * silently turns the transaction into a principal-less one that matches no
 * patient row. Both are better stopped here, with a message that names the
 * cause, than discovered from a policy error three queries later.
 *
 * The value is never echoed: a malformed subject is attacker-controlled text.
 */
export function assertAccountId(accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error('principal account id is not a uuid; refusing to open a scoped transaction');
  }
  return accountId.toLowerCase();
}

/** What `current_user` is allowed to be, as the catalogue reports it. */
export interface RoleAttributes {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

/**
 * Why a connection's role may not serve requests, or null when it may.
 *
 * Row-level security is the control that keeps one patient's rows from another.
 * A superuser or a BYPASSRLS role is exempt from every policy, FORCE included, so
 * a service connected as one has no RLS at all — which is exactly how R-032
 * happened: every service was handed the project's superuser DSN and nothing in
 * any service noticed. This is the service noticing.
 */
export function privilegedRoleProblem(role: RoleAttributes | undefined): string | null {
  if (!role) return 'the connected role could not be read from pg_roles';
  const held = [role.rolsuper ? 'SUPERUSER' : null, role.rolbypassrls ? 'BYPASSRLS' : null].filter(
    (attribute): attribute is string => attribute !== null,
  );
  return held.length === 0
    ? null
    : `database role "${role.rolname}" holds ${held.join(' and ')}, which exempts it from row-level security`;
}

/**
 * The one explicit, local-development-only way past the check.
 *
 * It exists because a laptop running `docker compose` before anybody has created
 * the per-service roles connects as the container's superuser. It is refused in
 * production whatever the variable says, requires a value that cannot be set by
 * accident, and is logged at error level on every check, so it cannot become
 * invisible.
 */
export const PRIVILEGED_ROLE_OVERRIDE = 'TETHER_ALLOW_PRIVILEGED_DB_ROLE';
export const PRIVILEGED_ROLE_OVERRIDE_VALUE = 'local-development-only';

/** What the catalogue said about the connected role, for startup and readiness. */
export type RoleVerdict =
  | { readonly status: 'ok' }
  /** The role is exempt from RLS. `overridden` is the local-development escape. */
  | { readonly status: 'privileged'; readonly problem: string; readonly overridden: boolean }
  /** The catalogue could not be read, so nothing is known about the role. */
  | { readonly status: 'unreadable' };

export interface RoleGuard {
  /** What is known about the role right now. Never throws. */
  evaluate(): Promise<RoleVerdict>;
  /** Resolves true when the connection may serve requests. Never throws. */
  check(): Promise<boolean>;
}

export function createRoleGuard(options: {
  readonly readRole: () => Promise<RoleAttributes | undefined>;
  readonly logger: Logger;
  readonly environment?: string;
  readonly override?: string | undefined;
}): RoleGuard {
  const overridden =
    options.override === PRIVILEGED_ROLE_OVERRIDE_VALUE && options.environment !== 'production';
  let approved = false;

  async function evaluate(): Promise<RoleVerdict> {
    if (approved) return { status: 'ok' };

    let problem: string | null;
    try {
      problem = privilegedRoleProblem(await options.readRole());
    } catch {
      // Cannot read it: do not guess. The error is dropped on purpose; a driver
      // error can carry the connection string.
      return { status: 'unreadable' };
    }
    if (problem === null) {
      // Roles do not gain attributes on a live connection pool without a
      // reconnect, and the probe runs on every readiness request.
      approved = true;
      return { status: 'ok' };
    }
    return { status: 'privileged', problem, overridden };
  }

  return {
    evaluate,
    async check() {
      const verdict = await evaluate();
      if (verdict.status === 'ok') return true;
      // Not ready, and the next probe tries again.
      if (verdict.status === 'unreadable') return false;
      if (verdict.overridden) {
        options.logger.error(
          { override: PRIVILEGED_ROLE_OVERRIDE },
          `${verdict.problem}. Serving anyway because ${PRIVILEGED_ROLE_OVERRIDE} is set. ` +
            'This must never be set outside local development.',
        );
        return true;
      }
      options.logger.fatal(
        { check: 'database role' },
        `${verdict.problem}. Refusing to report ready.`,
      );
      return false;
    },
  };
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
  readonly logger: Logger;
}

export interface Database {
  /**
   * Runs `fn` inside a transaction scoped to one account.
   *
   * `SET LOCAL` rather than `SET`: the setting dies with the transaction, so a
   * pooled connection cannot carry one request's identity into the next. That
   * distinction is the whole safety property.
   */
  withPrincipal<T>(
    accountId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T>;

  /**
   * A connection with no account set.
   *
   * For non-PHI work only — the catalogue, health checks, the waitlist. Under
   * RLS this sees nothing belonging to a patient, which is the intended
   * outcome if it is ever pointed at one by mistake.
   */
  withoutPrincipal<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  /**
   * True when the database answers and the role it answers as is subject to RLS.
   * Used by readiness, not liveness.
   */
  ping(): Promise<boolean>;

  /**
   * What the connected role is, for the startup check in `requireUnprivilegedRole`.
   * Never throws and never carries a driver error.
   */
  verifyRole(): Promise<RoleVerdict>;

  close(): Promise<void>;
}

export interface Transaction {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;

  /** Exactly one row, or null. Throws if the query returns more than one. */
  one<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R | null>;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs,
    // A connection that cannot be established in five seconds is not going to
    // help this request; failing fast keeps the pool from filling with waiters.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  const roleGuard = createRoleGuard({
    logger: options.logger,
    environment: process.env.NODE_ENV,
    override: process.env[PRIVILEGED_ROLE_OVERRIDE],
    readRole: async () =>
      (
        await pool.query<RoleAttributes>(
          'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        )
      ).rows[0],
  });

  pool.on('error', (error) => {
    // An idle client erroring is a pool-level event with no request attached,
    // so it is logged rather than thrown — throwing here would take the process
    // down for something the pool recovers from.
    options.logger.error({ err: error }, 'idle database client errored');
  });

  async function run<T>(
    accountId: string | null,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (accountId !== null) {
        // Parameterised. `SET LOCAL` does not accept a bind parameter directly,
        // so this goes through set_config, which does — string-interpolating an
        // account id into SQL would be an injection point on the one value that
        // decides what the caller can see.
        await client.query('SELECT set_config($1, $2, true)', [
          'app.account_id',
          accountId,
        ]);
      }
      const result = await fn(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        options.logger.error(
          { err: rollbackError },
          'rollback failed; releasing the connection anyway',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    withPrincipal: (accountId, fn) => run(assertAccountId(accountId), fn),
    withoutPrincipal: (fn) => run(null, fn),

    async ping() {
      try {
        const client = await pool.connect();
        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }
        // Readiness is "the database answers *and* it is a connection RLS applies
        // to". A privileged role is reported not-ready, so the orchestrator never
        // routes a request to a service that would bypass every policy.
        return await roleGuard.check();
      } catch {
        return false;
      }
    },

    verifyRole: () => roleGuard.evaluate(),

    close: () => pool.end(),
  };
}

function wrap(client: PoolClient): Transaction {
  return {
    async query<R extends QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      const result = await client.query<R>(sql, params as unknown[]);
      return result.rows;
    },

    async one<R extends QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R | null> {
      const result = await client.query<R>(sql, params as unknown[]);
      if (result.rows.length > 1) {
        // A query that was meant to identify one row and found several has a
        // missing predicate. Returning `rows[0]` would hide it — and hiding it
        // is how the chronic-care `/profile` bug reads as working code.
        throw new Error(
          `expected at most one row, received ${result.rows.length}`,
        );
      }
      return result.rows[0] ?? null;
    },
  };
}
