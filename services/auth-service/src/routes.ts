import { Router } from 'express';
import { z } from 'zod';
import {
  type Database,
  type Verifier,
  handler,
  principalOf,
  problem,
  requireAuth,
  validateBody,
} from '@tether/core';
import {
  accountBody,
  deleteAccount,
  findAccount,
  toInet,
  upsertAccount,
} from './accounts.ts';
import {
  type IssuedRefreshToken,
  type SessionStore,
  rotateRefreshToken,
  signOutFamily,
  startSession,
} from './sessions.ts';
import type { TokenSigner } from './tokens.ts';

/**
 * The auth service's HTTP surface.
 *
 * Paths are relative to the service's own root — `POST /sessions`, not
 * `POST /api/v1/auth/sessions`. The gateway strips its prefix before
 * forwarding, and this service has no idea it is behind one: it is runnable and
 * testable on its own, and the public URL shape stays a gateway decision.
 *
 * `/sessions` rather than `/login`, `/logout`, `/refresh`. A session is a
 * resource with a lifecycle — created, rotated, destroyed — and naming it that
 * way is what makes `DELETE /sessions` mean something specific rather than
 * being a verb somebody has to look up.
 */

export interface AuthRouterOptions {
  readonly db: Database;
  readonly sessions: SessionStore;
  readonly signer: TokenSigner;
  /** Verifies the *Supabase* token in `POST /sessions`. */
  readonly supabase: Verifier;
  /** Verifies *Tether's own* access tokens, for `/me` and `DELETE /sessions`. */
  readonly tether: Verifier;
  readonly refreshTtlDays: number;
}

const createSessionBody = z.object({
  /**
   * The access token the front-end got from the Supabase SDK.
   *
   * In the body rather than the `Authorization` header on purpose: the header
   * on this API means "a Tether token", everywhere, in every service. Putting a
   * foreign issuer's token in it — one that this endpoint accepts and no other
   * endpoint would — is how a header stops having one meaning.
   */
  supabaseAccessToken: z.string().min(1),
});

const refreshSessionBody = z.object({
  refreshToken: z.string().min(1),
});

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { db, sessions, signer, supabase, tether, refreshTtlDays } = options;
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /.well-known/jwks.json
  // -------------------------------------------------------------------------

  /**
   * The public half of the access-token signing key.
   *
   * Every other service — and the gateway — fetches this and caches it, which
   * is what lets them verify a token without asking this service anything. The
   * model repo published a JWKS endpoint and then verified with a shared
   * secret, so the endpoint was decorative and the verification was forgeable;
   * here the endpoint is the only way anything gets the key.
   */
  router.get('/.well-known/jwks.json', (_req, res) => {
    res
      // Long enough that a restart of this service does not stall every other
      // service's verification, short enough that a rotation propagates within
      // the hour without a deploy. `jose`'s `createRemoteJWKSet` also re-fetches
      // on an unknown `kid`, so a rotation is picked up sooner than this in
      // practice.
      .setHeader('cache-control', 'public, max-age=600, stale-while-revalidate=3600')
      .type('application/json')
      .json(signer.jwks);
  });

  // -------------------------------------------------------------------------
  // POST /sessions — sign in
  // -------------------------------------------------------------------------

  /**
   * Exchanges a verified Supabase identity for Tether credentials.
   *
   * This is the seam between the two issuers, and the only place the Supabase
   * verifier is used. Nothing downstream of here knows Supabase exists, which
   * means replacing the IdP is a change to one file rather than to nine
   * services.
   */
  router.post(
    '/sessions',
    validateBody(createSessionBody),
    handler(async (req, res) => {
      const { supabaseAccessToken } = req.body as z.infer<typeof createSessionBody>;

      // Throws a 401 with one message for every failure mode — expired, wrong
      // signature, wrong audience — because distinguishing them tells an
      // attacker which to work on. See `@tether/core`'s `auth.ts`.
      const upstream = await supabase(supabaseAccessToken);

      const account = await upsertAccount(db, {
        externalId: upstream.accountId,
        email: readEmail(upstream.claims),
      });

      const refresh = await startSession(sessions, {
        accountId: account.id,
        now: new Date(),
        ttlDays: refreshTtlDays,
        userAgent: readUserAgent(req.header('user-agent')),
        ip: toInet(req.ip),
      });

      req.log.info({ accountId: account.id }, 'session started');

      res.status(201).json(await sessionBody(signer, account.id, refresh, account));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /sessions/refresh — rotate
  // -------------------------------------------------------------------------

  router.post(
    '/sessions/refresh',
    validateBody(refreshSessionBody),
    handler(async (req, res) => {
      const { refreshToken } = req.body as z.infer<typeof refreshSessionBody>;

      const outcome = await rotateRefreshToken(sessions, {
        presentedToken: refreshToken,
        now: new Date(),
        ttlDays: refreshTtlDays,
        userAgent: readUserAgent(req.header('user-agent')),
        ip: toInet(req.ip),
      });

      if (outcome.kind === 'reuse-detected') {
        // The one log line in this service that should wake somebody. By the
        // time it is written the family is already revoked — the rotation
        // transaction committed that before returning, which is why
        // `rotateRefreshToken` returns an outcome instead of throwing.
        req.log.warn(
          {
            accountId: outcome.accountId,
            familyId: outcome.familyId,
            sessionsRevoked: outcome.sessionsRevoked,
            ip: req.ip,
          },
          'refresh token reuse detected; revoked the entire family',
        );
      } else if (outcome.kind !== 'rotated') {
        req.log.info({ reason: outcome.kind }, 'refresh refused');
      }

      if (outcome.kind !== 'rotated') {
        // One message for all three refusals. Which of "never existed",
        // "expired" and "already used" a caller hit is in the log, not in the
        // response.
        throw problem.unauthenticated('That refresh token is not usable.');
      }

      // Re-read the account rather than trusting the session row. A month is
      // long enough for an account to be suspended, and the refresh path is the
      // only recurring point at which that can be noticed — nothing checks
      // status while an access token is still inside its fifteen minutes.
      const account = await findAccount(db, outcome.accountId);
      if (!account || account.status !== 'active') {
        throw problem.unauthenticated('That refresh token is not usable.');
      }

      // Never log `outcome` wholesale. The logger redacts `*.refreshToken` and
      // `*.token` one level deep; the plaintext here is at
      // `outcome.refresh.token`, which is a level deeper than the pattern
      // reaches.
      res.status(200).json(await sessionBody(signer, account.id, outcome.refresh, account));
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /sessions — sign out
  // -------------------------------------------------------------------------

  /**
   * Ends this sign-in, and only this one.
   *
   * The family is taken from the access token's `fid` claim rather than from a
   * body parameter, so a caller can only end a session they are holding a token
   * for. Signing out on a phone leaves a tablet signed in — which matters for
   * the shared-device case `discreet_program` is written about.
   *
   * The access token itself is not revoked, because it cannot be: nothing looks
   * it up. It stops working when it expires, within fifteen minutes, and no
   * new one can be obtained in the meantime because the family is dead.
   */
  router.delete(
    '/sessions',
    requireAuth(tether),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const familyId = principal.claims.fid;

      if (typeof familyId !== 'string' || familyId.length === 0) {
        // Every token this service mints carries `fid`. One that verified and
        // does not is a token from a version of this service that no longer
        // exists; there is no family to end.
        throw problem.unauthenticated('This token carries no session family.');
      }

      const revoked = await signOutFamily(sessions, familyId, new Date());
      req.log.info({ accountId: principal.accountId, revoked }, 'session ended');

      res.status(204).end();
    }),
  );

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------

  router.get(
    '/me',
    requireAuth(tether),
    handler(async (req, res) => {
      const principal = principalOf(req);
      const account = await findAccount(db, principal.accountId);

      // A token that verifies for an account that no longer exists: the window
      // between `DELETE /me` and the access token expiring. 404, not 500 —
      // the deletion worked.
      if (!account) throw problem.notFound('No such account.');

      res.status(200).json(accountBody(account));
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /me
  // -------------------------------------------------------------------------

  /**
   * Deletes the account and everything that hangs off it.
   *
   * Returns 204 only after the rows are gone — see `deleteAccount`, which owns
   * the audit ordering. There is no confirmation step here and no grace period:
   * `PRODUCTION_RELEASE_CHECKLIST.md` asks for deletion with auditable
   * completion, and a grace period is a soft delete wearing a calendar.
   */
  router.delete(
    '/me',
    requireAuth(tether),
    handler(async (req, res) => {
      const principal = principalOf(req);

      // No need to revoke sessions first: the cascade from `identity.account`
      // removes every `identity.refresh_session` row outright, which is a
      // stronger outcome than marking them revoked.
      await deleteAccount(db, {
        accountId: principal.accountId,
        requestId: req.requestId,
        ip: toInet(req.ip),
        userAgent: readUserAgent(req.header('user-agent')),
      });

      req.log.info({ accountId: principal.accountId }, 'account deleted');
      res.status(204).end();
    }),
  );

  return router;
}

/** The body returned by both session endpoints. */
async function sessionBody(
  signer: TokenSigner,
  accountId: string,
  refresh: IssuedRefreshToken,
  account: Parameters<typeof accountBody>[0],
): Promise<Record<string, unknown>> {
  const access = await signer.sign({
    accountId,
    familyId: refresh.session.familyId,
  });

  return {
    tokenType: 'Bearer',
    accessToken: access.token,
    expiresIn: access.expiresInSeconds,
    // Absolute as well as relative. A client on a device with a skewed clock
    // can use `expiresIn`; a client reading a log needs the absolute one.
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    // The only time this value is ever transmitted.
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.session.expiresAt.toISOString(),
    account: accountBody(account),
  };
}

/** Supabase puts the address in `email`. Absent for phone-only sign-ins. */
function readEmail(claims: Record<string, unknown>): string | null {
  const email = claims.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

/**
 * Bounded, because it is attacker-controlled and it is stored.
 *
 * A user agent is a free-text header on a row that lives for a month. 512
 * characters is more than any real client sends and small enough that a
 * thousand forged sign-ins are not a storage problem.
 */
function readUserAgent(value: string | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 512);
}
