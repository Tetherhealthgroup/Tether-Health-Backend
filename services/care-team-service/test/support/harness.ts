import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger, loadConfig, type Principal, type Verifier } from '@tether/core';
import { createCareTeamApp } from '../../src/app.ts';
import { memoryDatabase, memoryStore, World } from './world.ts';

/**
 * A running care-team-service on an ephemeral port, backed by [World].
 *
 * Exercised over real HTTP, because the 403 shape, the role check and the
 * problem-details body are all part of what is being asserted and all of them
 * live in middleware.
 */

/**
 * The token is `role:accountId`.
 *
 * The clinician identity model is the thinnest part of this service's inputs —
 * nothing in the sources settles it — so the fake makes the two things this
 * service actually depends on explicit and nothing else: a `clinician` role on
 * the JWT, and `sub` matching `programme.sharing_consent.recipient_id`.
 */
const fakeVerifier: Verifier = async (token: string): Promise<Principal> => {
  const separator = token.indexOf(':');
  const role = separator >= 0 ? token.slice(0, separator) : 'clinician';
  const accountId = separator >= 0 ? token.slice(separator + 1) : token;
  return { accountId, roles: [role], scopes: [], claims: { sub: accountId } };
};

export interface Harness {
  readonly world: World;
  readonly url: string;
  readonly close: () => Promise<void>;
  request(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }>;
}

export async function startHarness(): Promise<Harness> {
  const world = new World();

  const config = loadConfig(undefined, {
    NODE_ENV: 'test',
    SERVICE_NAME: 'care-team-service',
    PORT: '8005',
    LOG_LEVEL: 'fatal',
    JWT_ISSUER: 'https://issuer.test',
    JWT_AUDIENCE: 'tether',
    JWT_JWKS_URL: 'https://issuer.test/jwks.json',
    DATABASE_URL: 'postgres://unused/in/these/tests',
    RATE_LIMIT_MAX: '100000',
  });

  const app = createCareTeamApp({
    config,
    logger: createLogger({
      serviceName: 'care-team-service',
      level: 'fatal',
      environment: 'test',
    }),
    verifier: fakeVerifier,
    db: memoryDatabase(world),
    store: memoryStore(world),
    isReady: async () => true,
    now: () => new Date('2026-06-01T12:00:00.000Z'),
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
    async request(token, method, path, body) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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

/** Every key appearing anywhere in a JSON document, for the safeguard tests. */
export function keysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysIn(entry, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      keysIn(entry, found);
    }
  }
  return found;
}
