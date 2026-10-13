import {
  createDatabase,
  createLogger,
  createVerifier,
  loadConfig,
  setProblemBase,
  start,
  requireUnprivilegedRole,
} from '@tether/core';
import { createCareTeamApp } from './app.ts';
import { createPostgresStore } from './postgres-store.ts';

/**
 * care-team-service, :8005.
 *
 * Same boot order as every other service — configuration, logger, database,
 * app, listener — because the order is the safety property: `loadConfig` throws
 * with every problem listed at once rather than letting the service start with
 * half its configuration and fail at 3am on the one path that needed the
 * variable.
 *
 * The database URL this service is given must be its own least-privileged role.
 * It is the only service that resolves a share, so it is the only one whose
 * connection can see a row belonging to somebody other than the caller — and
 * the policies in `db/migrations/0005_care.sql` are what bound that to "named
 * on a live consent". A role with `BYPASSRLS`, or a shared service-role key,
 * would turn all of that into decoration. ARCHITECTURE.md records that exact
 * mistake from the repo this one is modelled on.
 */

const config = loadConfig();

setProblemBase(`${config.PUBLIC_API_URL}/problems`);

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
  pretty: config.NODE_ENV === 'development',
});

const db = createDatabase({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  applicationName: config.SERVICE_NAME,
  logger,
});

/**
 * Before anything else is built, and long before `start` binds the listener: a
 * privileged role must never reach a listening state. See `requireUnprivilegedRole`.
 */
await requireUnprivilegedRole(db, { logger, serviceName: config.SERVICE_NAME });

const app = createCareTeamApp({
  config,
  logger,
  verifier: createVerifier({
    jwksUrl: config.JWT_JWKS_URL,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    algorithm: config.JWT_ALGORITHM,
  }),
  db,
  store: createPostgresStore(),
  // Every route here reaches Postgres, and every one of them depends on a
  // consent row being readable. A care-team-service that cannot reach the
  // database cannot prove anything was consented, so it should not be served
  // traffic — not even to return an empty list.
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: () => db.close(),
});
