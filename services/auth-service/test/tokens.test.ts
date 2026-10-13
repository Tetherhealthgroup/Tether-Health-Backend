import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { createVerifier } from '@tether/core';
import { authSchema } from '../src/config.ts';
import { createTokenSigner } from '../src/tokens.ts';

/**
 * The access-token half of the contract.
 *
 * Not a test of `jose` — of the wiring around it, which is ours and which is
 * the kind of thing that is wrong in a way no local test notices. A `kid` in
 * the header that is not the `kid` in the published JWKS, a missing `fid`, an
 * `aud` nobody asserts: each one works perfectly in this service and fails in
 * all eight others.
 *
 * So the token is verified the way the rest of the system verifies it — through
 * `@tether/core`'s `createVerifier`, fetching this service's own JWKS document
 * over HTTP. A local key comparison would pass while the published document was
 * wrong, which is the failure being guarded against.
 */

const ISSUER = 'https://api.tetherhealthgroup.com/auth';
const AUDIENCE = 'tether-api';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

async function signerFixture() {
  const { privatePem, publicPem } = keyPair();
  const signer = await createTokenSigner({
    privateKeyPem: privatePem,
    publicKeyPem: publicPem,
    algorithm: 'RS256',
    issuer: ISSUER,
    audience: AUDIENCE,
    ttlSeconds: 900,
  });

  // Serves exactly what `GET /.well-known/jwks.json` serves.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(signer.jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    signer,
    jwksUrl: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

void test('the environment accepts a PEM written on one line', () => {
  const { privatePem, publicPem } = keyPair();

  // Compose files, CI secrets and systemd units all hand over single-line
  // values. A key that only loads when it arrives with real newlines is a key
  // that works locally and fails in every deployment.
  const config = authSchema.parse({
    SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
    SUPABASE_ISSUER: 'https://project.supabase.co/auth/v1',
    ACCESS_TOKEN_PRIVATE_KEY: privatePem.replace(/\n/g, '\\n'),
    ACCESS_TOKEN_PUBLIC_KEY: publicPem.replace(/\n/g, '\\n'),
  });

  assert.equal(config.ACCESS_TOKEN_PRIVATE_KEY, privatePem.trim());
  assert.equal(config.SUPABASE_AUDIENCE, 'authenticated');
  assert.equal(config.ACCESS_TOKEN_TTL_SECONDS, 900);
  assert.equal(config.REFRESH_TOKEN_TTL_DAYS, 30);
});

void test('a key that is not a PEM block fails at boot, not at first sign-in', () => {
  assert.throws(() =>
    authSchema.parse({
      SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
      SUPABASE_ISSUER: 'https://project.supabase.co/auth/v1',
      ACCESS_TOKEN_PRIVATE_KEY: 'not-a-key',
      ACCESS_TOKEN_PUBLIC_KEY: 'also-not-a-key',
    }),
  );
});

void test('an access token verifies through the published JWKS', async (t) => {
  const { signer, jwksUrl, close } = await signerFixture();
  t.after(close);

  const verify = createVerifier({
    jwksUrl,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'RS256',
  });

  const issued = await signer.sign({ accountId: 'acct-1', familyId: 'fam-1' });
  const principal = await verify(issued.token);

  assert.equal(principal.accountId, 'acct-1');
  assert.equal(principal.claims.iss, ISSUER);
  assert.equal(principal.claims.aud, AUDIENCE);

  // `DELETE /sessions` reads this claim to decide which family to end. Without
  // it the only available sign-out is "everywhere".
  assert.equal(principal.claims.fid, 'fam-1');

  assert.equal(issued.expiresInSeconds, 900);
});

void test('the JWKS publishes the public half, under the kid the header names', async (t) => {
  const { signer, jwksUrl, close } = await signerFixture();
  t.after(close);

  const published = (await (await fetch(jwksUrl)).json()) as {
    keys: Array<Record<string, unknown>>;
  };
  const key = published.keys[0]!;

  assert.equal(published.keys.length, 1);
  assert.equal(key.kid, signer.kid);
  assert.equal(key.alg, 'RS256');
  assert.equal(key.use, 'sig');

  // The private exponent and the CRT parameters. If any of these ever appear
  // here, the signing key has been published to the internet.
  for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
    assert.equal(key[secret], undefined, `JWKS leaked the private field "${secret}"`);
  }

  const header = JSON.parse(
    Buffer.from(
      (await signer.sign({ accountId: 'a', familyId: 'f' })).token.split('.')[0]!,
      'base64url',
    ).toString('utf8'),
  );
  assert.equal(header.kid, signer.kid, 'signed with a kid the JWKS does not publish');
  assert.equal(header.alg, 'RS256');
});

void test('a correctly-signed token for another audience is refused', async (t) => {
  const { signer, jwksUrl, close } = await signerFixture();
  t.after(close);

  // The failure `@tether/core`'s config comments describe: a real signature
  // from the right issuer, minted for a different caller. Only the `aud` check
  // tells the two apart.
  const verify = createVerifier({
    jwksUrl,
    issuer: ISSUER,
    audience: 'some-other-api',
    algorithm: 'RS256',
  });

  const issued = await signer.sign({ accountId: 'acct-1', familyId: 'fam-1' });
  await assert.rejects(() => verify(issued.token));
});

void test('a token signed by a different key pair is refused', async (t) => {
  const { jwksUrl, close } = await signerFixture();
  t.after(close);

  const other = keyPair();
  const impostor = await createTokenSigner({
    privateKeyPem: other.privatePem,
    publicKeyPem: other.publicPem,
    algorithm: 'RS256',
    issuer: ISSUER,
    audience: AUDIENCE,
    ttlSeconds: 900,
  });

  const verify = createVerifier({
    jwksUrl,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'RS256',
  });

  const forged = await impostor.sign({ accountId: 'acct-1', familyId: 'fam-1' });
  await assert.rejects(() => verify(forged.token));
});

void test('an expired token is refused once the clock tolerance is past', async (t) => {
  const { signer, jwksUrl, close } = await signerFixture();
  t.after(close);

  const verify = createVerifier({
    jwksUrl,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'RS256',
  });

  // The access token's lifetime is its revocation window, so expiry has to
  // actually bite. Signed as at an hour ago, against a 900s TTL.
  const anHourAgo = new Date(Date.now() - 3_600_000);
  const stale = await signer.sign({ accountId: 'acct-1', familyId: 'fam-1' }, anHourAgo);

  assert.ok(stale.expiresAt.getTime() < Date.now());
  await assert.rejects(() => verify(stale.token));
});
