import type { Database } from './db.ts';
import { PRIVILEGED_ROLE_OVERRIDE } from './db.ts';
import type { Logger } from './logger.ts';

/**
 * The role check that runs before a service accepts traffic.
 *
 * `db.ping()` (behind `/readyz`) also checks the role, but Render health-checks
 * `/healthz`, which is liveness and always answers up, and `withPrincipal` never
 * consults the guard. So a service handed a superuser or BYPASSRLS DSN used to
 * come up and serve. This runs first, in every service that holds a database
 * connection, before the HTTP listener binds and before realtime issues LISTEN.
 *
 * A service that cannot read its own role is also refused (see ROLES.md): with
 * only `/healthz` checked by the platform, "continue and leave it to readiness"
 * would let a privileged DSN serve the moment the database came back.
 */

/** Thrown when the process must not start. Its message is safe to log and print. */
export class StartupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupRefusedError';
  }
}

export interface StartupRoleOptions {
  readonly logger: Logger;
  readonly serviceName: string;
  /** Reads of the catalogue before giving up. Default 3. */
  readonly attempts?: number;
  /** First back-off; doubles each retry. Default 1000. */
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function requireUnprivilegedRole(
  db: Pick<Database, 'verifyRole'>,
  options: StartupRoleOptions,
): Promise<void> {
  const { logger, serviceName } = options;
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delay = options.retryDelayMs ?? 1_000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const verdict = await db.verifyRole();

    if (verdict.status === 'ok') return;

    if (verdict.status === 'privileged') {
      if (verdict.overridden) {
        logger.error(
          { override: PRIVILEGED_ROLE_OVERRIDE },
          `${verdict.problem}. Starting anyway because ${PRIVILEGED_ROLE_OVERRIDE} is set. ` +
            'This must never be set outside local development.',
        );
        return;
      }
      const message = `${serviceName} refuses to start: ${verdict.problem}`;
      logger.fatal({ check: 'database role' }, message);
      throw new StartupRefusedError(message);
    }

    if (attempt < attempts) {
      logger.warn({ attempt, attempts }, 'database role could not be read; retrying');
      await sleep(delay);
      delay *= 2;
    }
  }

  const message =
    `${serviceName} refuses to start: the database role could not be verified ` +
    `after ${attempts} attempts`;
  logger.fatal({ check: 'database role' }, message);
  throw new StartupRefusedError(message);
}
