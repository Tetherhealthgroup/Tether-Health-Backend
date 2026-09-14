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
} from '@tether/core';
import { catalogueRoutes } from './routes.ts';

/**
 * catalogue-service :8002 — the design bundle, served.
 *
 * The order below is the order `http.ts` is written to be used in, and it is an
 * order rather than a preference: configuration has to fail before a logger
 * exists to complain to, the logger has to exist before the pool can report a
 * dead connection, and `finalise` has to run after the routes or its 404
 * handler swallows all of them.
 *
 * This service exists because the Flutter app ships `areas.json`,
 * `archetypes.json`, `safeguards.json` and the product files as build-time
 * assets today — so an area moving from `planned` to `in_development` needs an
 * App Store release. Serving the same data makes that an UPDATE.
 */

const config = loadConfig();

// Problem `type` URIs resolve under the API's own origin. The model repo
// hard-coded `https://identity.example.com/` into every error it returned,
// which makes the field useless as the dereferenceable identifier RFC 7807
// intends.
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

const verifier = createVerifier({
  jwksUrl: config.JWT_JWKS_URL,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  algorithm: config.JWT_ALGORITHM,
});

const app = createApp({ config, logger, verifier });

app.use(catalogueRoutes({ db, verifier }));

finalise(app, {
  serviceName: config.SERVICE_NAME,

  /**
   * Readiness is the database answering, not the process existing.
   *
   * The model repo's `/health` returned `UP` whether or not its database was
   * reachable, so an orchestrator could not tell "starting" from "broken" and
   * kept routing traffic to a service that could serve none of it. Every route
   * in this service reads Postgres; a pool that cannot connect means every one
   * of them 500s, and saying so is the difference between a rolling deploy that
   * pauses and one that completes into an outage.
   */
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  // Released after the listener has drained, so an in-flight request still has
  // a working connection to finish on.
  onShutdown: () => db.close(),
});
