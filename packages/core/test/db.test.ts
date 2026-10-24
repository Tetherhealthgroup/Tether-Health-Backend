import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAccountId } from '../src/db.ts';

/**
 * `app.account_id` is what every RLS policy keys off, and it is read through a
 * `::uuid` cast. These are the inputs that must never reach `set_config`.
 */

void test('a uuid is accepted and normalised to lower case', () => {
  assert.equal(
    assertAccountId('11111111-AAAA-4111-8111-111111111111'),
    '11111111-aaaa-4111-8111-111111111111',
  );
});

void test('anything that is not a uuid is refused, without echoing it', () => {
  for (const bad of [
    '',
    ' ',
    'not-a-uuid',
    "11111111-1111-4111-8111-111111111111'; DROP TABLE x;--",
    '11111111-1111-4111-8111-11111111111',
    '11111111-1111-4111-8111-1111111111111',
    '{11111111-1111-4111-8111-111111111111}',
    ' 11111111-1111-4111-8111-111111111111',
  ]) {
    assert.throws(
      () => assertAccountId(bad),
      (error: Error) => {
        assert.match(error.message, /not a uuid/);
        assert.ok(bad.trim() === '' || !error.message.includes(bad), 'the input was echoed');
        return true;
      },
      JSON.stringify(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// R-061c: a service whose role bypasses RLS must not report ready
// ---------------------------------------------------------------------------

import {
  createRoleGuard,
  privilegedRoleProblem,
  PRIVILEGED_ROLE_OVERRIDE,
  PRIVILEGED_ROLE_OVERRIDE_VALUE,
  type RoleAttributes,
} from '../src/db.ts';
import { createLogger } from '../src/logger.ts';
import { Writable } from 'node:stream';

const role = (over: Partial<RoleAttributes> = {}): RoleAttributes => ({
  rolname: 'tether_x_login',
  rolsuper: false,
  rolbypassrls: false,
  ...over,
});

function guardWith(
  attributes: () => Promise<RoleAttributes | undefined>,
  options: { override?: string; environment?: string } = {},
) {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _e, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  });
  const guard = createRoleGuard({
    readRole: attributes,
    logger: createLogger({ serviceName: 't', level: 'trace', environment: 'test', destination }),
    environment: options.environment ?? 'development',
    override: options.override,
  });
  return { guard, logs: () => chunks.join('') };
}

void test('an ordinary role is acceptable', () => {
  assert.equal(privilegedRoleProblem(role()), null);
});

void test('a superuser, a BYPASSRLS role, or one that cannot be read, is a problem', () => {
  assert.match(privilegedRoleProblem(role({ rolsuper: true })) ?? '', /SUPERUSER/);
  assert.match(privilegedRoleProblem(role({ rolbypassrls: true })) ?? '', /BYPASSRLS/);
  assert.match(privilegedRoleProblem(role({ rolsuper: true, rolbypassrls: true })) ?? '', /SUPERUSER and BYPASSRLS/);
  assert.match(privilegedRoleProblem(undefined) ?? '', /could not be read/);
});

void test('a privileged role is not ready, and the refusal is logged at fatal', async () => {
  const { guard, logs } = guardWith(() => Promise.resolve(role({ rolsuper: true })));

  assert.equal(await guard.check(), false);
  assert.match(logs(), /"level":"fatal"/);
  assert.match(logs(), /exempts it from row-level security/);
});

void test('an unprivileged role is ready, and is not asked again', async () => {
  let reads = 0;
  const { guard } = guardWith(() => {
    reads += 1;
    return Promise.resolve(role());
  });

  assert.equal(await guard.check(), true);
  assert.equal(await guard.check(), true);
  assert.equal(reads, 1);
});

void test('a failure to read the role is not ready, and is retried', async () => {
  let calls = 0;
  const { guard } = guardWith(() => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('no catalogue')) : Promise.resolve(role());
  });

  assert.equal(await guard.check(), false);
  assert.equal(await guard.check(), true);
});

void test('the local-development override lets a privileged role through, loudly, and only with the exact value', async () => {
  const privileged = () => Promise.resolve(role({ rolbypassrls: true }));

  const allowed = guardWith(privileged, { override: PRIVILEGED_ROLE_OVERRIDE_VALUE });
  assert.equal(await allowed.guard.check(), true);
  assert.equal(await allowed.guard.check(), true);
  assert.match(allowed.logs(), new RegExp(PRIVILEGED_ROLE_OVERRIDE));
  assert.match(allowed.logs(), /"level":"error"/);
  assert.equal(allowed.logs().match(/Serving anyway/g)?.length, 2, 'logged on every check, not just the first');

  for (const value of ['true', '1', 'yes', '']) {
    assert.equal(await guardWith(privileged, { override: value }).guard.check(), false, `override "${value}"`);
  }
});

void test('the override is ignored in production', async () => {
  const { guard } = guardWith(() => Promise.resolve(role({ rolsuper: true })), {
    override: PRIVILEGED_ROLE_OVERRIDE_VALUE,
    environment: 'production',
  });
  assert.equal(await guard.check(), false);
});
