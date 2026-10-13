import {
  requireUnprivilegedRole,
  type Logger,
  type StartupRoleOptions,
  type Database,
} from '@tether/core';

/** The slice of a `pg` Client that boot needs. */
export interface ListenerConnection {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
}

export interface RealtimeStartup extends Omit<StartupRoleOptions, 'logger'> {
  readonly db: Pick<Database, 'verifyRole'>;
  readonly logger: Logger;
  readonly listener: ListenerConnection;
  /** Binds the HTTP listener. */
  readonly serve: () => void;
}

/**
 * The boot order, which is the safety property: role check, then the dedicated
 * connection and `LISTEN`, then the HTTP listener. A role that bypasses RLS never
 * gets as far as subscribing to change notifications.
 */
export async function startRealtime(options: RealtimeStartup): Promise<void> {
  await requireUnprivilegedRole(options.db, options);
  await options.listener.connect();
  await options.listener.query('LISTEN tether_change');
  options.logger.info('listening for change notifications');
  options.serve();
}
