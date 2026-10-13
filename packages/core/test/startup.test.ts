import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Writable } from 'node:stream';
import {
  createRoleGuard,
  PRIVILEGED_ROLE_OVERRIDE_VALUE,
  type RoleAttributes,
} from '../src/db.ts';
import { createLogger } from '../src/logger.ts';
import { requireUnprivilegedRole, StartupRefusedError } from '../src/startup.ts';

/**
 * R-061c / B2: the privileged-role guard has to run before a service accepts
 * traffic, not only behind /readyz. Render health-checks /healthz, which is
 * liveness only, so a privileged DSN that merely failed readiness would still
 * have been routed to.
 */

const FAKE_DSN = 'postgres://tether_x_login:Sup3rS3cretPw@db-host.internal.example:5432/tether';

const role = (over: Partial<RoleAttributes> = {}): RoleAttributes => ({
  rolname: 'tether_x_login',
  rolsuper: false,
  rolbypassrls: false,
  ...over,
});

function harness(
  readRole: () => Promise<RoleAttributes | undefined>,
  options: { override?: string; environment?: string } = {},
) {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _e, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = createLogger({ serviceName: 't', level: 'trace', environment: 'test', destination });
  const guard = createRoleGuard({
    readRole,
    logger,
    environment: options.environment ?? 'development',
    override: options.override,
  });
  const sleeps: number[] = [];
  const run = () =>
    requireUnprivilegedRole(
      { verifyRole: () => guard.evaluate() },
      {
        logger,
        serviceName: 't',
        retryDelayMs: 10,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
  return { run, logs: () => chunks.join(''), sleeps };
}

async function refusal(run: () => Promise<void>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof StartupRefusedError, 'refusal must be a StartupRefusedError');
    return error;
  }
  throw new Error('expected startup to be refused');
}

test('a SUPERUSER role refuses startup, naming SUPERUSER and logging fatal', async () => {
  const { run, logs } = harness(() => Promise.resolve(role({ rolsuper: true })));
  const error = await refusal(run);
  assert.match(error.message, /SUPERUSER/);
  assert.match(error.message, /tether_x_login/);
  assert.match(logs(), /"level":"fatal"/);
  assert.match(logs(), /SUPERUSER/);
});

test('a BYPASSRLS role refuses startup, naming BYPASSRLS', async () => {
  const { run } = harness(() => Promise.resolve(role({ rolbypassrls: true })));
  const error = await refusal(run);
  assert.match(error.message, /BYPASSRLS/);
});

test('an ordinary service role starts', async () => {
  const { run, sleeps } = harness(() => Promise.resolve(role()));
  await run();
  assert.deepEqual(sleeps, []);
});

test('neither the DSN, its host nor its password reaches any log line or error', async () => {
  // The driver's own error carries the connection string.
  const leaky = () => Promise.reject(new Error(`connect failed for ${FAKE_DSN}`));
  const unreadable = harness(leaky);
  const unreadableError = await refusal(unreadable.run);

  const privileged = harness(() => Promise.resolve(role({ rolsuper: true })));
  const privilegedError = await refusal(privileged.run);

  for (const text of [
    unreadable.logs(),
    unreadableError.message,
    String(unreadableError.stack),
    privileged.logs(),
    privilegedError.message,
    String(privilegedError.stack),
  ]) {
    assert.ok(!text.includes('Sup3rS3cretPw'), 'password leaked');
    assert.ok(!text.includes('db-host.internal.example'), 'host leaked');
    assert.ok(!text.includes('postgres://'), 'DSN leaked');
  }
});

test('a role that cannot be read is retried, and startup proceeds once it can be', async () => {
  let calls = 0;
  const { run, sleeps } = harness(() => {
    calls += 1;
    return calls < 3 ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(role());
  });
  await run();
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test('a role that never can be read refuses startup (fail closed), without claiming it was privileged', async () => {
  let calls = 0;
  const { run, logs } = harness(() => {
    calls += 1;
    return Promise.reject(new Error('ECONNREFUSED'));
  });
  const error = await refusal(run);
  assert.equal(calls, 3);
  assert.match(error.message, /could not be verified/);
  assert.doesNotMatch(error.message, /SUPERUSER|BYPASSRLS/);
  assert.match(logs(), /"level":"fatal"/);
});

test('a privileged role is refused at once, not retried', async () => {
  let calls = 0;
  const { run } = harness(() => {
    calls += 1;
    return Promise.resolve(role({ rolsuper: true }));
  });
  await refusal(run);
  assert.equal(calls, 1);
});

test('the local-development override lets a privileged role start, loudly', async () => {
  const { run, logs } = harness(() => Promise.resolve(role({ rolsuper: true })), {
    override: PRIVILEGED_ROLE_OVERRIDE_VALUE,
    environment: 'development',
  });
  await run();
  assert.match(logs(), /"level":"error"/);
  assert.match(logs(), /TETHER_ALLOW_PRIVILEGED_DB_ROLE/);
});

test('the override is refused under NODE_ENV=production: startup is still refused', async () => {
  const { run } = harness(() => Promise.resolve(role({ rolbypassrls: true })), {
    override: PRIVILEGED_ROLE_OVERRIDE_VALUE,
    environment: 'production',
  });
  const error = await refusal(run);
  assert.match(error.message, /BYPASSRLS/);
});

test('a wrong override value does not override', async () => {
  const { run } = harness(() => Promise.resolve(role({ rolsuper: true })), { override: 'true' });
  await refusal(run);
});

// ---------------------------------------------------------------------------
// Wiring: every service that opens a database runs the guard before it binds
// ---------------------------------------------------------------------------

const servicesDir = new URL('../../../services/', import.meta.url);
const NO_DATABASE = ['api-gateway'];

test('every service entrypoint that creates a database runs the role guard before it listens', () => {
  const covered: string[] = [];
  for (const name of readdirSync(servicesDir)) {
    const source = readFileSync(new URL(`${name}/src/index.ts`, servicesDir), 'utf8');
    const opensDatabase = /createDatabase\(/.test(source);
    if (!opensDatabase) {
      assert.ok(NO_DATABASE.includes(name), `${name} opens no database but is not listed as exempt`);
      continue;
    }
    covered.push(name);
    const guardAt = source.search(/requireUnprivilegedRole\(|startRealtime\(/);
    const listenAt = source.search(/^start\(\{|^\s+serve:/m);
    assert.ok(guardAt >= 0, `${name} never runs the startup role guard`);
    if (!source.includes('startRealtime(')) {
      assert.ok(listenAt > guardAt, `${name} binds its listener before the role guard`);
    }
  }
  assert.equal(covered.length, 9, `covered: ${covered.join(', ')}`);
});

test('the realtime entrypoint issues LISTEN only through startRealtime', () => {
  const source = readFileSync(new URL('realtime-service/src/index.ts', servicesDir), 'utf8');
  assert.ok(!/LISTEN tether_change/.test(source), 'LISTEN must live behind the guard');
  assert.ok(!/listener\.connect\(/.test(source), 'the listener must not connect before the guard');
});
