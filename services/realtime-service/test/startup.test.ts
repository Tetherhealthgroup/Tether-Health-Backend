import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger, StartupRefusedError, type RoleVerdict } from '@tether/core';
import { startRealtime } from '../src/startup.ts';

const FAKE_DSN = 'postgres://tether_realtime_login:Sup3rS3cretPw@db-host.internal.example:5432/tether';

function setup(verdict: () => Promise<RoleVerdict>) {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _e, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const events: string[] = [];
  const listener = {
    connect: () => {
      events.push('connect');
      return Promise.resolve();
    },
    query: (sql: string) => {
      events.push(sql);
      return Promise.resolve();
    },
  };
  const deps = {
    db: { verifyRole: verdict },
    logger: createLogger({ serviceName: 'realtime-service', level: 'trace', environment: 'test', destination }),
    serviceName: 'realtime-service',
    retryDelayMs: 0,
    sleep: () => Promise.resolve(),
    listener,
    serve: () => {
      events.push('serve');
    },
  };
  return { deps, events, logs: () => chunks.join('') };
}

const privileged = (attribute: string): RoleVerdict => ({
  status: 'privileged',
  overridden: false,
  problem: `database role "tether_realtime_login" holds ${attribute}, which exempts it from row-level security`,
});

void test('a privileged role: no connect, no LISTEN, no HTTP listener, and the rejection names the attribute', async () => {
  const { deps, events, logs } = setup(() => Promise.resolve(privileged('SUPERUSER')));
  await assert.rejects(
    () => startRealtime(deps),
    (error: Error) => {
      assert.ok(error instanceof StartupRefusedError);
      assert.match(error.message, /SUPERUSER/);
      return true;
    },
  );
  assert.deepEqual(events, []);
  assert.ok(!logs().includes(FAKE_DSN));
});

void test('a BYPASSRLS role: no LISTEN issued either', async () => {
  const { deps, events } = setup(() => Promise.resolve(privileged('BYPASSRLS')));
  await assert.rejects(() => startRealtime(deps), /BYPASSRLS/);
  assert.ok(!events.includes('LISTEN tether_change'));
  assert.ok(!events.includes('serve'));
});

void test('an unreadable role also stops LISTEN and the listener (fail closed)', async () => {
  const { deps, events, logs } = setup(() => Promise.resolve({ status: 'unreadable' }));
  await assert.rejects(() => startRealtime(deps), StartupRefusedError);
  assert.deepEqual(events, []);
  assert.ok(!logs().includes('Sup3rS3cretPw'));
});

void test('an ordinary role: connect, then LISTEN, then the HTTP listener, in that order', async () => {
  const { deps, events } = setup(() => Promise.resolve({ status: 'ok' }));
  await startRealtime(deps);
  assert.deepEqual(events, ['connect', 'LISTEN tether_change', 'serve']);
});
