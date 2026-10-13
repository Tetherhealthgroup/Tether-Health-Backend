import {
  createDatabase,
  createLogger,
  createVerifier,
  loadConfig,
  setProblemBase,
  start,
  requireUnprivilegedRole,
} from '@tether/core';
import { createRecordsApp } from './app.ts';
import { createPostgresStore } from './postgres-store.ts';

/**
 * records-service, :8004.
 *
 * Boot order matters and is the order below: configuration before anything that
 * could read a missing variable, the logger before the database so a pool error
 * has somewhere to go, and `start` last so the listener never opens in front of
 * a half-built app. `loadConfig` throws with every problem at once — a service
 * that starts with half its configuration does not fail at boot, it fails at 3am
 * on the one code path that needed the variable.
 */

const config = loadConfig();

// Problem `type` URIs resolve under this API's own origin, so they are the
// dereferenceable identifiers RFC 7807 intends rather than a hard-coded
// example.com that no client can ever follow.
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

const app = createRecordsApp({
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
  /**
   * Readiness is the database answering, not the process being up.
   *
   * Every route here reaches Postgres — there is no cached or static path — so
   * a records-service with no database can serve exactly nothing, and telling
   * an orchestrator otherwise keeps traffic on it. `/healthz` stays liveness.
   */
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  // Connections drain first, then the pool closes, so an in-flight export or
  // deletion still has a working connection to finish on.
  onShutdown: () => db.close(),
});
