import {
  createDatabase,
  createLogger,
  createVerifier,
  isProduction,
  loadConfig,
  setProblemBase,
  start,
  requireUnprivilegedRole,
} from '@tether/core';
import { z } from 'zod';
import { createChronicApp } from './app.ts';

/**
 * chronic-service :8008 — the bridge for the `chronic-care` Flutter app.
 *
 * The routes, and the reasons they are written the way they are, are in
 * `app.ts`. This file is the boot order only, which is why it is not where the
 * tests look.
 */

const config = loadConfig(
  z.object({
    /** Page-size bounds for vitals; why they are bounded is in `ChronicConfig`. */
    CHRONIC_VITALS_PAGE_MAX: z.coerce.number().int().positive().default(500),
    CHRONIC_VITALS_PAGE_DEFAULT: z.coerce.number().int().positive().default(200),
  }),
);

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

const app = createChronicApp({
  config,
  logger,
  verifier,
  db,
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: () => db.close(),
});
