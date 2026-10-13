import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLogger,
  loadConfig,
  problem,
  type Database,
  type Principal,
  type Transaction,
  type Verifier,
} from '@tether/core';
import { z } from 'zod';
import { createWebsiteApp } from '../src/app.ts';
import {
  recordingTransaction,
  type RecordedStatement,
} from '../../../packages/core/test/support/recording-tx.ts';

/**
 * R-033: "Waitlist delete has no auth".
 *
 * `DELETE /waitlist/:id` erased a person's enquiry for anyone who could reach
 * the path and had an id. It now needs a verified token carrying the admin role,
 * the same credential `POST /waitlist/purge` already used. Every case below
 * asserts two things: the status the caller sees, and that the database was not
 * touched when the answer was a refusal.
 */

const ADMIN = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ENQUIRY = '99999999-9999-4999-8999-999999999999';

/** `admin-token` and `patient-token` verify; anything else is a bad token. */
const verifier: Verifier = (token: string): Promise<Principal> => {
  if (token === 'admin-token') {
    return Promise.resolve({ accountId: ADMIN, roles: ['admin'], scopes: [], claims: { sub: ADMIN } });
  }
  if (token === 'patient-token') {
    return Promise.resolve({ accountId: PATIENT, roles: ['patient'], scopes: [], claims: { sub: PATIENT } });
  }
  return Promise.reject(problem.unauthenticated('The token did not verify.'));
};

interface Running {
  readonly url: string;
  readonly statements: RecordedStatement[];
  readonly close: () => Promise<void>;
}

async function start(): Promise<Running> {
  const statements: RecordedStatement[] = [];

  const db: Database = {
    async withoutPrincipal<T>(fn: (tx: Transaction) => Promise<T>) {
      const tx = recordingTransaction((statement) => {
        if (/^\s*DELETE/.test(statement.sql)) return [{ id: ENQUIRY }];
        if (/WITH recent AS/.test(statement.sql)) return [{ id: ENQUIRY, created: true }];
        return [];
      });
      try {
        return await fn(tx);
      } finally {
        statements.push(...tx.statements);
      }
    },
    withPrincipal: () => Promise.reject(new Error('website-service never scopes to an account')),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };

  const config = loadConfig(
    z.object({
      WAITLIST_DEDUPE_WINDOW_MS: z.coerce.number().default(900_000),
      WAITLIST_RATE_LIMIT_MAX: z.coerce.number().default(5),
      WAITLIST_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(3_600_000),
      WAITLIST_PURGE_BATCH: z.coerce.number().default(1_000),
      ADMIN_ROLE: z.string().default('admin'),
    }),
    {
      NODE_ENV: 'test',
      SERVICE_NAME: 'website-service',
      PORT: '8007',
      LOG_LEVEL: 'fatal',
      JWT_ISSUER: 'https://issuer.test',
      JWT_AUDIENCE: 'tether',
      JWT_JWKS_URL: 'https://issuer.test/jwks.json',
      DATABASE_URL: 'postgres://unused/in/these/tests',
      RATE_LIMIT_MAX: '100000',
      WAITLIST_RATE_LIMIT_MAX: '100000',
    },
  );

  const app = createWebsiteApp({
    config,
    logger: createLogger({ serviceName: 'website-service', level: 'fatal', environment: 'test' }),
    verifier,
    db,
  });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    statements,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function call(
  server: Running,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<number> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  await response.text();
  return response.status;
}

test('an unauthenticated delete is rejected and touches nothing', async () => {
  const server = await start();
  try {
    assert.equal(await call(server, 'DELETE', `/waitlist/${ENQUIRY}`), 401);
    assert.equal(server.statements.length, 0, 'the database was reached without a token');
  } finally {
    await server.close();
  }
});

test('a delete with a token that does not verify is rejected', async () => {
  const server = await start();
  try {
    assert.equal(
      await call(server, 'DELETE', `/waitlist/${ENQUIRY}`, { token: 'forged' }),
      401,
    );
    assert.equal(server.statements.length, 0);
  } finally {
    await server.close();
  }
});

test('a verified token without the admin role is forbidden', async () => {
  const server = await start();
  try {
    assert.equal(
      await call(server, 'DELETE', `/waitlist/${ENQUIRY}`, { token: 'patient-token' }),
      403,
    );
    assert.equal(server.statements.length, 0);
  } finally {
    await server.close();
  }
});

test('an admin delete erases the enquiry and records who did it, not whose it was', async () => {
  const server = await start();
  try {
    assert.equal(
      await call(server, 'DELETE', `/waitlist/${ENQUIRY}`, { token: 'admin-token' }),
      204,
    );

    const remove = server.statements.find((s) => /DELETE FROM ops\.waitlist_enquiry/.test(s.sql));
    assert.ok(remove, 'no DELETE was issued');
    assert.deepEqual(remove.params, [ENQUIRY]);

    const audited = server.statements.find((s) => /INSERT INTO ops\.audit_event/.test(s.sql));
    assert.ok(audited, 'no audit row was written');
    const detail = JSON.parse(String(audited.params.at(-1))) as Record<string, unknown>;
    assert.equal(detail.actorAccountId, ADMIN);
    // The row's own details never go into a table that outlives it.
    assert.ok(!JSON.stringify(audited.params).includes('@'), 'an email address was audited');
  } finally {
    await server.close();
  }
});

test('a malformed id is a 204 for an admin, and a 401 for nobody', async () => {
  const server = await start();
  try {
    assert.equal(await call(server, 'DELETE', '/waitlist/not-a-uuid', { token: 'admin-token' }), 204);
    assert.equal(await call(server, 'DELETE', '/waitlist/not-a-uuid'), 401);
    assert.equal(server.statements.length, 0);
  } finally {
    await server.close();
  }
});

test('the form is still public, and the retention purge is still admin only', async () => {
  const server = await start();
  try {
    const created = await call(server, 'POST', '/waitlist', {
      body: {
        name: 'Synthetic Person',
        email: 'synthetic@example.test',
        role: 'patient',
        interest: 'general',
        message: 'hello',
      },
    });
    assert.ok(created === 200 || created === 201, `form submission returned ${created}`);

    assert.equal(await call(server, 'POST', '/waitlist/purge'), 401);
    assert.equal(await call(server, 'POST', '/waitlist/purge', { token: 'patient-token' }), 403);
  } finally {
    await server.close();
  }
});

test('S2: a token that fails to verify is answered by the error handler, on both admin routes, with no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  const server = await start();
  try {
    assert.equal(await call(server, 'DELETE', `/waitlist/${ENQUIRY}`, { token: 'forged' }), 401);
    assert.equal(await call(server, 'POST', '/waitlist/purge', { token: 'forged' }), 401);
    assert.equal(server.statements.length, 0, 'the database was reached without a verified token');
    // Give a stray rejection the tick it would need to surface.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await server.close();
  }
});
