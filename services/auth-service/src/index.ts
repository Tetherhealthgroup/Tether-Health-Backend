import {
  createApp,
  createDatabase,
  createLogger,
  createVerifier,
  finalise,
  loadConfig,
  setProblemBase,
  start,
  requireUnprivilegedRole,
} from '@tether/core';
import { authSchema } from './config.ts';
import { createAuthRouter } from './routes.ts';
import { createSessionStore } from './store.ts';
import { createTokenSigner } from './tokens.ts';

/**
 * `auth-service` — identity, and nothing else.
 *
 * Boot order is the one `@tether/core`'s `http.ts` describes: `loadConfig`,
 * `createLogger`, `createDatabase`, `createApp`, routes, `finalise`, `start`.
 *
 * Unlike the gateway, this service uses `createApp` unchanged. It proxies
 * nothing, so the `express.json()` that `createApp` mounts is exactly what its
 * handlers want — the body-parser conflict documented in
 * `services/api-gateway/src/app.ts` is a gateway problem, not a general one,
 * and reproducing the gateway's hand-built stack here would be duplication
 * with no reason behind it.
 */

const config = loadConfig(authSchema);

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
  pretty: config.NODE_ENV === 'development',
});

setProblemBase(`${config.PUBLIC_API_URL.replace(/\/+$/, '')}/problems`);

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

/**
 * Signs Tether access tokens. Awaited at boot so a malformed key stops the
 * container rather than the first sign-in.
 */
const signer = await createTokenSigner({
  privateKeyPem: config.ACCESS_TOKEN_PRIVATE_KEY,
  publicKeyPem: config.ACCESS_TOKEN_PUBLIC_KEY,
  // The same value every other service verifies with, read from the same
  // variable, so the signer and the verifiers cannot be configured apart.
  algorithm: config.JWT_ALGORITHM,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  ...(config.ACCESS_TOKEN_KID ? { kid: config.ACCESS_TOKEN_KID } : {}),
});

logger.info({ kid: signer.kid, alg: config.JWT_ALGORITHM }, 'signing key loaded');

/** The upstream identity provider. Used by exactly one endpoint. */
const supabase = createVerifier({
  jwksUrl: config.SUPABASE_JWKS_URL,
  issuer: config.SUPABASE_ISSUER,
  audience: config.SUPABASE_AUDIENCE,
  algorithm: config.SUPABASE_JWT_ALGORITHM,
});

/**
 * Tether's own tokens — verified here the same way every other service verifies
 * them, by fetching this service's own published JWKS over HTTP.
 *
 * It looks redundant: the private key is in this process, so the public key is
 * too, and a local verification would save a request. The round trip is the
 * point. It exercises the identical code path the gateway and the other seven
 * services use, against the identical document they fetch — so a key this
 * service can sign with but cannot publish fails here first, in this service's
 * own `/me`, rather than everywhere else at once and nowhere obvious.
 */
const tether = createVerifier({
  jwksUrl: config.JWT_JWKS_URL,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  algorithm: config.JWT_ALGORITHM,
});

const app = createApp({ config, logger, verifier: tether });

app.use(
  createAuthRouter({
    db,
    sessions: createSessionStore(db),
    signer,
    supabase,
    tether,
    refreshTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
  }),
);

finalise(app, {
  serviceName: config.SERVICE_NAME,
  // Readiness is the database, because without it this service can verify a
  // Supabase token and then do nothing useful with it. Liveness stays the
  // process being up, so a brief database blip takes this service out of
  // rotation instead of getting it restarted.
  isReady: () => db.ping(),
});

start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  // Pool closed after the listener has drained, so an in-flight sign-in still
  // has a connection to finish on.
  onShutdown: () => db.close(),
});
