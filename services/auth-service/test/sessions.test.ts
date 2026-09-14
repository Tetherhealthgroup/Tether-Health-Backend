import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rotateRefreshToken,
  signOutFamily,
  startSession,
} from '../src/sessions.ts';
import { hashRefreshToken, mintRefreshToken } from '../src/tokens.ts';
import { createMemoryStore } from './memory-store.ts';

/**
 * Refresh-token rotation and family reuse detection.
 *
 * These are the tests worth having in this service. Not that Express routes,
 * not that `jose` signs — that a stolen refresh token cannot be used twice, and
 * that the second use ends every session descended from the compromise. Both
 * are properties nothing else in the system checks and both fail silently: a
 * gateway that forgot to rotate still signs people in, and a reuse detector
 * that revokes one row instead of the family still returns a 401.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TTL_DAYS = 30;

const at = (iso: string) => new Date(iso);

function signIn(store: ReturnType<typeof createMemoryStore>, now: Date, accountId = ACCOUNT) {
  return startSession(store, {
    accountId,
    now,
    ttlDays: TTL_DAYS,
    userAgent: 'TetherHealth/1.0 (test)',
    ip: '203.0.113.9',
  });
}

function rotate(
  store: ReturnType<typeof createMemoryStore>,
  presentedToken: string,
  now: Date,
) {
  return rotateRefreshToken(store, {
    presentedToken,
    now,
    ttlDays: TTL_DAYS,
    userAgent: 'TetherHealth/1.0 (test)',
    ip: '203.0.113.9',
  });
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('the plaintext refresh token is never stored', async () => {
  const store = createMemoryStore();
  const issued = await signIn(store, at('2026-01-01T00:00:00Z'));

  const serialised = JSON.stringify(store.rows());
  assert.equal(
    serialised.includes(issued.token),
    false,
    'the token the client received must not appear anywhere in the stored rows',
  );
  assert.equal(store.rows()[0]?.tokenHash, hashRefreshToken(issued.token));
  assert.match(store.rows()[0]!.tokenHash, /^[0-9a-f]{64}$/);
});

test('minted tokens are distinct and hash stably', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1_000; i += 1) {
    const { token, hash } = mintRefreshToken();
    assert.equal(hash, hashRefreshToken(token));
    assert.equal(seen.has(token), false, 'two mints returned the same token');
    seen.add(token);
  }
});

test('a sign-in opens exactly one live session in a new family', async () => {
  const store = createMemoryStore();
  const first = await signIn(store, at('2026-01-01T00:00:00Z'));
  const second = await signIn(store, at('2026-01-01T00:05:00Z'));

  // Signing in on a second device must not disturb the first. Each sign-in is
  // its own family, so a compromise of one is contained to one.
  assert.notEqual(first.session.familyId, second.session.familyId);
  assert.equal(store.rows().filter((s) => s.revokedAt === null).length, 2);
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('using a refresh token issues a new one and revokes the old', async () => {
  const store = createMemoryStore();
  const first = await signIn(store, at('2026-01-01T00:00:00Z'));

  const outcome = await rotate(store, first.token, at('2026-01-02T00:00:00Z'));
  assert.equal(outcome.kind, 'rotated');
  if (outcome.kind !== 'rotated') return;

  assert.notEqual(outcome.refresh.token, first.token);
  assert.equal(outcome.accountId, ACCOUNT);

  // Same family: rotation continues a sign-in, it does not start one.
  assert.equal(outcome.refresh.session.familyId, first.session.familyId);

  const old = store.find(hashRefreshToken(first.token));
  assert.equal(old?.revokedReason, 'rotated');
  assert.deepEqual(old?.revokedAt, at('2026-01-02T00:00:00Z'));

  const fresh = store.find(hashRefreshToken(outcome.refresh.token));
  assert.equal(fresh?.revokedAt, null);

  // The new token's clock restarts from the rotation, not from the sign-in —
  // otherwise an actively-used session still expires a month after sign-in.
  assert.deepEqual(fresh?.expiresAt, at('2026-02-01T00:00:00Z'));
});

test('rotation chains, and only the newest token is live', async () => {
  const store = createMemoryStore();
  let current = (await signIn(store, at('2026-01-01T00:00:00Z'))).token;

  for (let day = 2; day <= 6; day += 1) {
    const outcome = await rotate(store, current, at(`2026-01-0${day}T00:00:00Z`));
    assert.equal(outcome.kind, 'rotated');
    if (outcome.kind !== 'rotated') return;
    current = outcome.refresh.token;
  }

  assert.equal(store.rows().length, 6);
  const live = store.rows().filter((s) => s.revokedAt === null);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.tokenHash, hashRefreshToken(current));
});

// ---------------------------------------------------------------------------
// Family reuse detection — the reason the family_id column exists
// ---------------------------------------------------------------------------

test('presenting an already-rotated token revokes the entire family', async () => {
  const store = createMemoryStore();
  const stolen = await signIn(store, at('2026-01-01T00:00:00Z'));

  // The legitimate client rotates. `stolen.token` is now a revoked token that a
  // thief still holds a copy of.
  const legitimate = await rotate(store, stolen.token, at('2026-01-02T00:00:00Z'));
  assert.equal(legitimate.kind, 'rotated');
  if (legitimate.kind !== 'rotated') return;

  const outcome = await rotate(store, stolen.token, at('2026-01-03T00:00:00Z'));

  assert.equal(outcome.kind, 'reuse-detected');
  if (outcome.kind !== 'reuse-detected') return;
  assert.equal(outcome.familyId, stolen.session.familyId);
  assert.equal(outcome.accountId, ACCOUNT);

  // One session was still live — the successor the real client is using — and
  // it is the one that had to die. Killing only the presented token would leave
  // the thief free to rotate alongside the victim indefinitely.
  assert.equal(outcome.sessionsRevoked, 1);

  const successor = store.find(hashRefreshToken(legitimate.refresh.token));
  assert.equal(successor?.revokedReason, 'reuse-detected');
  assert.deepEqual(successor?.revokedAt, at('2026-01-03T00:00:00Z'));

  assert.equal(
    store.rows().every((s) => s.revokedAt !== null),
    true,
    'no session in the family may survive a reuse event',
  );
});

test('the successor stops working the moment reuse is detected', async () => {
  const store = createMemoryStore();
  const stolen = await signIn(store, at('2026-01-01T00:00:00Z'));

  const legitimate = await rotate(store, stolen.token, at('2026-01-02T00:00:00Z'));
  assert.equal(legitimate.kind, 'rotated');
  if (legitimate.kind !== 'rotated') return;

  await rotate(store, stolen.token, at('2026-01-03T00:00:00Z'));

  // The real client comes back with a token that was perfectly valid a moment
  // ago. It is now itself a reuse event: signed out, and asked to sign in
  // again. That is the intended, deliberately blunt outcome.
  const afterwards = await rotate(store, legitimate.refresh.token, at('2026-01-03T00:01:00Z'));
  assert.equal(afterwards.kind, 'reuse-detected');
  if (afterwards.kind !== 'reuse-detected') return;
  assert.equal(afterwards.sessionsRevoked, 0, 'nothing was left to revoke');
});

test('reuse detection does not reach beyond the compromised family', async () => {
  const store = createMemoryStore();

  const phone = await signIn(store, at('2026-01-01T00:00:00Z'));
  const tablet = await signIn(store, at('2026-01-01T00:01:00Z'));
  const stranger = await signIn(store, at('2026-01-01T00:02:00Z'), OTHER_ACCOUNT);

  const rotated = await rotate(store, phone.token, at('2026-01-02T00:00:00Z'));
  assert.equal(rotated.kind, 'rotated');

  await rotate(store, phone.token, at('2026-01-03T00:00:00Z'));

  // The blast radius is one sign-in, not one account and certainly not one
  // database. Signing a patient out of every device because one was stolen
  // would be a reason not to ship the detection at all.
  assert.equal(store.find(hashRefreshToken(tablet.token))?.revokedAt, null);
  assert.equal(store.find(hashRefreshToken(stranger.token))?.revokedAt, null);
});

test('reuse detection returns an outcome rather than throwing', async () => {
  const store = createMemoryStore();
  const stolen = await signIn(store, at('2026-01-01T00:00:00Z'));
  await rotate(store, stolen.token, at('2026-01-02T00:00:00Z'));

  // This looks like a test of a calling convention. It is a test of whether the
  // revocation survives. `SessionStore.transact` rolls back on rejection, so if
  // this path ever threw from inside the transaction, the family revocation
  // would be undone — and the endpoint would return a convincing 401 while
  // every stolen token stayed live.
  await assert.doesNotReject(() => rotate(store, stolen.token, at('2026-01-03T00:00:00Z')));
  assert.equal(store.rows().every((s) => s.revokedAt !== null), true);
});

// ---------------------------------------------------------------------------
// The other refusals
// ---------------------------------------------------------------------------

test('an unrecognised token revokes nothing', async () => {
  const store = createMemoryStore();
  const live = await signIn(store, at('2026-01-01T00:00:00Z'));

  const outcome = await rotate(store, 'not-a-token-anyone-issued', at('2026-01-02T00:00:00Z'));

  assert.equal(outcome.kind, 'unknown-token');
  // A 32-byte string nobody recognises is evidence of nothing. Treating it as a
  // reuse signal would hand anybody a way to sign anybody out by guessing.
  assert.equal(store.find(hashRefreshToken(live.token))?.revokedAt, null);
});

test('an expired token is refused and marked, but does not kill the family', async () => {
  const store = createMemoryStore();
  const issued = await signIn(store, at('2026-01-01T00:00:00Z'));

  const outcome = await rotate(store, issued.token, at('2026-03-01T00:00:00Z'));

  assert.equal(outcome.kind, 'expired');
  const row = store.find(hashRefreshToken(issued.token));
  assert.equal(row?.revokedReason, 'expired');

  // Someone who was away for two months is not an attacker, and telling them
  // apart is exactly what the `revoked_reason` column is for.
  assert.notEqual(row?.revokedReason, 'reuse-detected');
});

test('a token presented on its expiry instant is expired, not rotated', async () => {
  const store = createMemoryStore();
  const issued = await signIn(store, at('2026-01-01T00:00:00Z'));

  // expires_at is exclusive: `<=` in the check, so the boundary is refused.
  const outcome = await rotate(store, issued.token, issued.session.expiresAt);
  assert.equal(outcome.kind, 'expired');
});

// ---------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------

test('signing out ends the family and leaves other devices alone', async () => {
  const store = createMemoryStore();
  const phone = await signIn(store, at('2026-01-01T00:00:00Z'));
  const tablet = await signIn(store, at('2026-01-01T00:01:00Z'));

  const revoked = await signOutFamily(store, phone.session.familyId, at('2026-01-02T00:00:00Z'));

  assert.equal(revoked, 1);
  assert.equal(store.find(hashRefreshToken(phone.token))?.revokedReason, 'signed-out');
  assert.equal(store.find(hashRefreshToken(tablet.token))?.revokedAt, null);
});

test('a signed-out token cannot be rotated, and reads as reuse', async () => {
  const store = createMemoryStore();
  const issued = await signIn(store, at('2026-01-01T00:00:00Z'));
  await signOutFamily(store, issued.session.familyId, at('2026-01-02T00:00:00Z'));

  // Deliberate: after a sign-out, the only party who would still present that
  // token is one who kept a copy. Same evidence, same response.
  const outcome = await rotate(store, issued.token, at('2026-01-03T00:00:00Z'));
  assert.equal(outcome.kind, 'reuse-detected');
});
