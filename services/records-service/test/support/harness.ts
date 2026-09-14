import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger, loadConfig, type Principal, type Verifier } from '@tether/core';
import { createRecordsApp } from '../../src/app.ts';
import { memoryDatabase, memoryStore, World } from './world.ts';

/**
 * A running records-service on an ephemeral port, backed by [World].
 *
 * The app is exercised over real HTTP rather than by calling handlers, because
 * half of what is being asserted lives in the middleware stack `createApp`
 * assembles — the body limit, the problem-details error shape, the 404. A test
 * that called the handler directly would assert the part that was never in
 * doubt.
 */

/**
 * The token *is* the account id.
 *
 * Signature verification is `@tether/core`'s and has its own tests; repeating
 * it here would need a JWKS endpoint and would test `jose`. What these tests
 * need is a principal, so the fake produces one.
 */
const fakeVerifier: Verifier = async (token: string): Promise<Principal> => ({
  accountId: token,
  roles: ['patient'],
  scopes: [],
  claims: { sub: token },
});

export interface Harness {
  readonly world: World;
  readonly url: string;
  readonly close: () => Promise<void>;
  /** Fetches as `accountId`, returning status and parsed body together. */
  request(
    accountId: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
}

export async function startHarness(
  options: { now?: string } = {},
): Promise<Harness> {
  const world = new World();
  const fixedNow = options.now ?? '2026-06-01T12:00:00.000Z';

  const config = loadConfig(undefined, {
    NODE_ENV: 'test',
    SERVICE_NAME: 'records-service',
    // The configured port is the real one; the listener below takes an
    // ephemeral one so tests can run in parallel. `baseSchema` requires a
    // positive integer, which is right — a service configured with port 0 in
    // production would bind somewhere nobody could find it.
    PORT: '8004',
    LOG_LEVEL: 'fatal',
    JWT_ISSUER: 'https://issuer.test',
    JWT_AUDIENCE: 'tether',
    JWT_JWKS_URL: 'https://issuer.test/jwks.json',
    DATABASE_URL: 'postgres://unused/in/these/tests',
    // Generous, so that a test adding a few more requests does not start
    // failing on a limit that is not what it is testing.
    RATE_LIMIT_MAX: '100000',
  });

  const app = createRecordsApp({
    config,
    logger: createLogger({
      serviceName: 'records-service',
      level: 'fatal',
      environment: 'test',
    }),
    verifier: fakeVerifier,
    db: memoryDatabase(world),
    store: memoryStore(world, () => fixedNow),
    isReady: async () => true,
    now: () => new Date(fixedNow),
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    world,
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    async request(accountId, method, path, body, headers = {}) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accountId}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text.length > 0 ? JSON.parse(text) : null,
      };
    },
  };
}
