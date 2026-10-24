import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { problem } from './errors.ts';

/**
 * Token verification.
 *
 * This file exists because the model repo's equivalent was broken three ways in
 * one line, repeated in ten services:
 *
 *     jwt.verify(token, JWT_SECRET, { algorithms: ['ES256', 'HS256'] })
 *
 * 1. Two algorithms, one of them symmetric. The same configured string is
 *    offered as an HMAC secret and as an ECDSA key, so anyone who learns the
 *    public key can sign an HS256 token with it and be believed.
 * 2. No JWKS. The issuer published `/.well-known/jwks.json` and nothing fetched
 *    it, so the asymmetric path could never actually succeed.
 * 3. No `iss`, no `aud`. A correctly-signed token minted for something else was
 *    accepted.
 *
 * All three are closed below: one pinned algorithm, keys fetched and cached from
 * the issuer's JWKS, and both claims asserted.
 */

export interface Principal {
  /** `sub` — the account id. */
  readonly accountId: string;
  /** `roles`, defaulted to empty rather than assumed. */
  readonly roles: readonly string[];
  /** `scope`, split. Empty when absent. */
  readonly scopes: readonly string[];
  /** Everything else, for services that need a bespoke claim. */
  readonly claims: JWTPayload;
}

export interface VerifierOptions {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm: 'RS256' | 'ES256';
  /** How long a fetched key set is reused. */
  readonly cacheMs?: number;
  /** How long to wait for the JWKS endpoint. */
  readonly timeoutMs?: number;
}

export type Verifier = (token: string) => Promise<Principal>;

/**
 * Builds a verifier bound to one issuer.
 *
 * `createRemoteJWKSet` caches the key set and re-fetches on an unknown `kid`,
 * with its own cooldown, so a key rotation is picked up without a deploy and a
 * flood of bad `kid`s cannot turn into a fetch storm against the issuer.
 */
export function createVerifier(options: VerifierOptions): Verifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
    cacheMaxAge: options.cacheMs ?? 10 * 60 * 1000,
    timeoutDuration: options.timeoutMs ?? 5_000,
  });

  return async function verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: [options.algorithm],
        clockTolerance: 5,
      }));
    } catch {
      // Deliberately one message for every failure mode. Distinguishing
      // "expired" from "wrong signature" from "wrong audience" tells an
      // attacker which of the three to work on.
      throw problem.unauthenticated('The token did not verify.');
    }

    const accountId = payload.sub;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw problem.unauthenticated('The token carries no subject.');
    }

    return {
      accountId,
      roles: readStringArray(payload.roles),
      scopes: readScopes(payload.scope),
      claims: payload,
    };
  };
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

function readScopes(value: unknown): readonly string[] {
  return typeof value === 'string' ? value.split(' ').filter(Boolean) : [];
}

/** Extracts a bearer token, or null. Case-insensitive on the scheme. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}
