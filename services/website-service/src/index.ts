import { z } from 'zod';
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
import { createWebsiteApp } from './app.ts';

/**
 * website-service :8007 — the waitlist endpoint, and nothing else.
 *
 * The routes, and the reasons they are written the way they are, are in
 * `app.ts`. This file is the boot order only.
 */

const config = loadConfig(
  z.object({
    /**
     * How long a repeat submission from the same address folds into the first.
     *
     * Fifteen minutes, not a day. Long enough to cover a double tap, a retry
     * after a dropped connection, and somebody refreshing the page and trying
     * again — and short enough that a person who thinks better of it and
     * enquires properly an hour later gets a second row rather than silence.
     */
    WAITLIST_DEDUPE_WINDOW_MS: z.coerce.number().int().positive().default(900_000),

    /**
     * The submission limit, per IP. Much tighter than the service-wide default
     * in `@tether/core`, because this is the only unauthenticated write in the
     * whole backend and the only thing standing between a scraper and a table
     * of email addresses is this number.
     */
    WAITLIST_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    WAITLIST_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(3_600_000),

    /** Rows removed per purge call. See `purgeExpired`. */
    WAITLIST_PURGE_BATCH: z.coerce.number().int().positive().default(1_000),

    /** The role the purge job runs as. */
    ADMIN_ROLE: z.string().min(1).default('admin'),
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

const app = createWebsiteApp({
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
