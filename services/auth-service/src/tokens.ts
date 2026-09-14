import { createHash, randomBytes } from 'node:crypto';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  importPKCS8,
  importSPKI,
  type JWK,
} from 'jose';

/**
 * Minting Tether's own credentials.
 *
 * Two kinds of token, with deliberately opposite properties:
 *
 * - The **access token** is a signed JWT that every service verifies offline
 *   against this service's JWKS. Nothing is looked up, so nothing can be
 *   revoked, so it is short. Its lifetime is its revocation window.
 *
 * - The **refresh token** is not a token in the JWT sense at all. It is 32
 *   random bytes, meaningless on its own, and only a row in
 *   `identity.refresh_session` gives it meaning. It is therefore revocable
 *   instantly, which is what makes it safe to give it a month.
 *
 * Splitting the two that way is the whole scheme. Something has to be long
 * lived or people get signed out of a smoking-cessation programme every quarter
 * of an hour; whatever is long lived has to be killable.
 */

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

/** 32 bytes — 256 bits from the OS CSPRNG. Not derived from anything. */
const REFRESH_TOKEN_BYTES = 32;

export interface MintedRefreshToken {
  /**
   * The plaintext, returned to the client exactly once.
   *
   * There is no endpoint that can show it again, because nothing stores it.
   * A client that loses it signs in again.
   */
  readonly token: string;
  /** What actually goes in the database. */
  readonly hash: string;
}

export function mintRefreshToken(): MintedRefreshToken {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * Lowercase hex SHA-256 of the token string, matching the CHECK in migration
 * 0004.
 *
 * A fast hash on purpose. bcrypt and argon2 exist to make guessing a secret a
 * human chose expensive; this input is 256 CSPRNG bits, which is not guessable
 * at any work factor, and a deliberately slow hash on the refresh path would
 * only be a denial-of-service lever pointed at ourselves. What the hash buys is
 * that a copy of `identity.refresh_session` is not a set of working
 * credentials — and SHA-256 buys that in full.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export interface AccessTokenSubject {
  readonly accountId: string;
  /**
   * The refresh family this access token was issued under.
   *
   * Carried as the `fid` claim so that `DELETE /sessions` can end *this*
   * sign-in and no other. Without it the only sign-out available is
   * "everywhere", which is wrong for a person signing out of a shared or family
   * device — the exact situation `discreet_program` exists for.
   */
  readonly familyId: string;
  readonly roles?: readonly string[];
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly expiresInSeconds: number;
}

export interface TokenSignerOptions {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly algorithm: 'RS256' | 'ES256';
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly kid?: string;
}

export interface TokenSigner {
  sign(subject: AccessTokenSubject, now?: Date): Promise<IssuedAccessToken>;
  /** The body of `GET /.well-known/jwks.json`. Public half only. */
  readonly jwks: { readonly keys: readonly JWK[] };
  readonly kid: string;
}

/**
 * Imports the key pair once, at boot, and returns a signer.
 *
 * At boot rather than per request, so that a malformed key is a container that
 * will not start rather than a 500 on the first sign-in after a deploy — and so
 * that the published JWKS and the `kid` in every header are computed from the
 * same imported key, which makes "we are publishing a key nothing was signed
 * with" impossible rather than merely unlikely.
 */
export async function createTokenSigner(
  options: TokenSignerOptions,
): Promise<TokenSigner> {
  const privateKey = await importPKCS8(options.privateKeyPem, options.algorithm);
  const publicKey = await importSPKI(options.publicKeyPem, options.algorithm);

  const publicJwk = await exportJWK(publicKey);
  const kid = options.kid ?? (await calculateJwkThumbprint(publicJwk, 'sha256'));

  const jwks = {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: options.algorithm,
        // Signature verification only. A key published without `use` is a key
        // something may eventually try to encrypt to.
        use: 'sig',
      } satisfies JWK,
    ],
  } as const;

  return {
    kid,
    jwks,

    async sign(subject, now = new Date()): Promise<IssuedAccessToken> {
      const issuedAt = Math.floor(now.getTime() / 1000);
      const expiresAtSeconds = issuedAt + options.ttlSeconds;

      const token = await new SignJWT({
        fid: subject.familyId,
        roles: subject.roles ?? [],
      })
        .setProtectedHeader({ alg: options.algorithm, kid, typ: 'JWT' })
        .setSubject(subject.accountId)
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setIssuedAt(issuedAt)
        .setNotBefore(issuedAt)
        .setExpirationTime(expiresAtSeconds)
        // A unique id per token. Not used for revocation — there is no lookup
        // on the verify path — but it makes two tokens issued in the same
        // second distinguishable in a log, which is the difference between
        // "the client retried" and "two clients have the same session".
        .setJti(randomBytes(12).toString('base64url'))
        .sign(privateKey);

      return {
        token,
        expiresAt: new Date(expiresAtSeconds * 1000),
        expiresInSeconds: options.ttlSeconds,
      };
    },
  };
}
