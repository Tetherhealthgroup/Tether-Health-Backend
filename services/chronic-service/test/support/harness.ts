import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { z } from 'zod';
import {
  createLogger,
  loadConfig,
  type Database,
  type Principal,
  type Transaction,
  type Verifier,
} from '@tether/core';
import { createChronicApp } from '../../src/app.ts';
import { recordingTransaction } from '../../../../packages/core/test/support/recording-tx.ts';

/**
 * A running chronic-service on an ephemeral port, with a database that answers
 * from canned rows and a logger whose output is captured.
 *
 * What it is for: asserting on what the service *says* — which statements it
 * issues and which words reach the log — over real HTTP, so the middleware
 * stack is in play. What it is not: evidence that the SQL is right. That is
 * `db/test/service-roles.integration.test.ts`, against a real Postgres.
 */

export const ACCOUNT = '11111111-1111-4111-8111-111111111111';
export const PROFILE = '99999999-9999-4999-8999-999999999999';
export const CONDITION = '33333333-3333-4333-8333-333333333333';

const fakeVerifier: Verifier = (token: string): Promise<Principal> =>
  Promise.resolve({ accountId: token, roles: [], scopes: [], claims: { sub: token } });

const NOW = new Date('2026-06-01T12:00:00.000Z');

/** Rows for the statements the handlers issue, keyed on what the SQL names. */
export function answer(sql: string, kind = 'diabetes'): unknown[] {
  if (/INSERT INTO chronic\.profile/.test(sql)) return [{ id: PROFILE }];
  if (/UPDATE chronic\.profile/.test(sql)) {
    return [
      {
        id: PROFILE,
        display_name: 'Synthetic Person',
        avatar_emoji: 'x',
        dob: null,
        health_score: 50,
        created_at: NOW,
        updated_at: NOW,
      },
    ];
  }
  if (/INSERT INTO chronic\.condition/.test(sql)) {
    return [
      {
        id: CONDITION,
        kind,
        status: 'unknown',
        goal_value: null,
        goal_unit: null,
        diagnosed_at: null,
        created_at: NOW,
      },
    ];
  }
  if (/SELECT c\.id\s+FROM chronic\.condition c/.test(sql)) return [{ id: CONDITION }];
  if (/INSERT INTO chronic\.vital_entry/.test(sql)) {
    return [
      {
        id: '44444444-4444-4444-8444-444444444444',
        condition_id: CONDITION,
        metric_key: 'zz_canary_metric',
        label: 'zz canary label',
        value: '123.4',
        unit: 'zz',
        note: 'zz canary note',
        observed_at: NOW,
      },
    ];
  }
  if (/INSERT INTO chronic\.medication/.test(sql)) {
    return [
      {
        id: '55555555-5555-4555-8555-555555555555',
        condition_id: null,
        name: 'zz canary drug',
        dosage: '1 zz',
        schedule: '',
        times: [],
        reminders_enabled: true,
        last_taken_at: null,
        active: true,
        taken_today: false,
      },
    ];
  }
  if (/DELETE FROM chronic\.medication/.test(sql)) return [{ id: 'x' }];
  return [];
}

export interface Harness {
  readonly url: string;
  /** Every statement the database was asked to run, across all requests. */
  readonly statements: { sql: string; params: readonly unknown[] }[];
  /** Every log line the service wrote, as shipped. */
  readonly logs: () => string;
  readonly close: () => Promise<void>;
  request(
    method: string,
    path: string,
    body?: unknown,
    accountId?: string,
  ): Promise<{ status: number; body: unknown }>;
}

export async function startHarness(
  options: { failWith?: Error } = {},
): Promise<Harness> {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const logLines: string[] = [];

  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString('utf8'));
      callback();
    },
  });

  const logger = createLogger({
    serviceName: 'chronic-service',
    level: 'trace',
    environment: 'test',
    destination,
  });

  const db: Database = {
    async withPrincipal<T>(_accountId: string, fn: (tx: Transaction) => Promise<T>) {
      if (options.failWith) throw options.failWith;
      const tx = recordingTransaction((statement) => answer(statement.sql));
      try {
        return await fn(tx);
      } finally {
        statements.push(...tx.statements);
      }
    },
    withoutPrincipal: () => Promise.reject(new Error('chronic-service never opens a principal-less transaction')),
    ping: () => Promise.resolve(true),
    verifyRole: () => Promise.resolve({ status: 'ok' as const }),
    close: () => Promise.resolve(),
  };

  const config = loadConfig(
    z.object({
      CHRONIC_VITALS_PAGE_MAX: z.coerce.number().default(500),
      CHRONIC_VITALS_PAGE_DEFAULT: z.coerce.number().default(200),
    }),
    {
      NODE_ENV: 'test',
      SERVICE_NAME: 'chronic-service',
      PORT: '8008',
      LOG_LEVEL: 'trace',
      JWT_ISSUER: 'https://issuer.test',
      JWT_AUDIENCE: 'tether',
      JWT_JWKS_URL: 'https://issuer.test/jwks.json',
      DATABASE_URL: 'postgres://unused/in/these/tests',
      RATE_LIMIT_MAX: '100000',
    },
  );

  const app = createChronicApp({ config, logger, verifier: fakeVerifier, db });

  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    statements,
    logs: () => logLines.join(''),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    async request(method, path, body, accountId = ACCOUNT) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accountId}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
  };
}
