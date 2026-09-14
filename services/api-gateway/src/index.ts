import {
  createLogger,
  createVerifier,
  loadConfig,
  setProblemBase,
  start,
} from '@tether/core';
import { createGatewayApp } from './app.ts';
import { gatewaySchema } from './config.ts';

/**
 * `api-gateway` — the only host-exposed port in the system.
 *
 * Boot order follows `@tether/core`'s `http.ts`: configuration first, because a
 * service that cannot be configured should never reach the point of binding a
 * port; then the logger, so everything after it is observable; then the app;
 * then `finalise`; then `start`, which owns the shutdown sequence.
 *
 * There is no `createDatabase` call here. The gateway holds no data, and the
 * absence is deliberate rather than pending — see `src/config.ts`.
 */

const config = loadConfig(gatewaySchema);

const logger = createLogger({
  serviceName: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  environment: config.NODE_ENV,
  pretty: config.NODE_ENV === 'development',
});

// Problem `type` URIs resolve under the public origin, which is this service's
// own. Set before any handler can throw.
setProblemBase(`${config.PUBLIC_API_URL.replace(/\/+$/, '')}/problems`);

/**
 * Verifies Tether's own access tokens, against the auth service's JWKS.
 *
 * One algorithm, keys fetched from the issuer rather than configured as a
 * string, and both `iss` and `aud` asserted — the three failures
 * `@tether/core`'s `auth.ts` was written to close.
 */
const verifier = createVerifier({
  jwksUrl: config.JWT_JWKS_URL,
  issuer: config.JWT_ISSUER,
  audience: config.JWT_AUDIENCE,
  algorithm: config.JWT_ALGORITHM,
});

const app = createGatewayApp({ config, logger, verifier });

/**
 * No `isReady` override.
 *
 * Readiness is deliberately *not* the health of the eight services behind this
 * one. If it were, a single sick downstream would take the gateway out of
 * rotation and with it every unrelated endpoint — the catalogue would stop
 * serving because notifications were down. A caller asking for a broken service
 * should get that service's 502, addressed to that service, and everything else
 * should keep working.
 */
start({
  app,
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
});
