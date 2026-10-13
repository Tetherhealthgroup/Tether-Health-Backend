import {
  createApp,
  createDatabase,
  createLogger,
  createVerifier,
  finalise,
  isProduction,
  loadConfig,
  setProblemBase,
  start,
  requireUnprivilegedRole,
} from '@tether/core';
import { enrolmentRoutes } from './routes.ts';

/**
 * enrolment-service :8003 — joining, pausing, hiding, and per-program sharing.
 *
 * The same boot order as every other service in this repo, and for the same
 * reasons: configuration fails before there is a logger to complain to, the
 * logger exists before the pool can report a dead connection, and `finalise`
 * runs after the routes or its 404 handler swallows every one of them.
 *
 * This is where `two_active_max` and `per_program_sharing` are enforced
 * server-side, because the website has already published that they are:
 * "Consent versioning, purpose limitation and revocation enforced on the
 * server, not merely reflected in the interface" (`security.astro`). Enforcing
 * them in the client would make that sentence untrue the first time somebody
 * called the API with curl.
 */

const config = loadConfig();

setProblemBase(`${config.PUBLIC_API_URL}/problems`);

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
  pretty: !isProduction(config),
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

const verifier = createVerifier({
  jwksUrl: config.JWT_JWKS_URL,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  algorithm: config.JWT_ALGORITHM,
});

const app = createApp({ config, logger, verifier });

app.use(enrolmentRoutes({ db, verifier }));

finalise(app, {
  serviceName: config.SERVICE_NAME,

  /**
   * A real dependency check, not a process check.
   *
   * Every route here writes or reads through RLS, so a pool that cannot connect
   * means every route 500s. Reporting not-ready takes this container out of
   * rotation; reporting `UP` regardless — which is what the model repo's single
   * `/health` did — keeps an orchestrator routing joins at a service that
   * cannot record one.
   */
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: () => db.close(),
});
