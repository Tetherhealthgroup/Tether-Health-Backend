import { randomUUID } from 'node:crypto';
import { hashRefreshToken, mintRefreshToken } from './tokens.ts';

/**
 * Refresh-token rotation, and the family reuse detection that makes it worth
 * doing.
 *
 * ## The rule
 *
 * Every refresh token belongs to a **family** — one sign-in, and every token
 * descended from it by rotation. Using a token rotates it: a new token is
 * issued into the same family and the presented one is revoked. A refresh token
 * is therefore a single-use object.
 *
 * Which gives the theft signal for free. If a token is stolen, the thief and
 * the real client both hold the same single-use object. Whichever of them uses
 * it second presents a token that has already been revoked — and a revoked
 * token being presented at all is something that cannot happen in normal
 * operation. So it is not treated as an error; it is treated as evidence. The
 * entire family is revoked, both parties are signed out, and the person signs
 * in again on a device they control.
 *
 * Revoking only the presented token would be the wrong response and a tempting
 * one: it looks gentler, and it leaves the attacker holding a live token in the
 * same family, rotating happily forever. The only response that ends the
 * attack is the one that ends every session descended from the compromise.
 *
 * ## Why this file returns outcomes instead of throwing
 *
 * Reuse detection has to *write* — it revokes a family — on the same request it
 * refuses. If this code threw a `ProblemError` from inside the transaction, the
 * store's rollback would undo the revocation, and the endpoint would return a
 * correct-looking 401 while leaving every stolen token live. That is a silent
 * failure of precisely the mechanism this file exists to provide.
 *
 * So the transaction commits and returns a tagged outcome, and the HTTP layer
 * turns the outcome into a response afterwards. The awkwardness is load
 * bearing.
 */

export type RevokedReason =
  | 'rotated'
  | 'signed-out'
  | 'reuse-detected'
  | 'expired'
  | 'account-closed';

/** A row of `identity.refresh_session`, in the shape the logic wants. */
export interface RefreshSession {
  readonly id: string;
  readonly accountId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: RevokedReason | null;
}

export interface NewRefreshSession {
  readonly accountId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

/**
 * The operations rotation needs, and nothing more.
 *
 * An interface rather than direct SQL so the rules above can be tested for what
 * they are — a small state machine — without a Postgres container in the loop.
 * The test suite's in-memory implementation and `src/store.ts`'s Postgres one
 * are held to the same contract, which is what stops the tests from proving
 * something about a fake.
 */
export interface SessionTx {
  /**
   * The row with this hash, locked for update.
   *
   * The lock is not optional. Two refreshes arriving with the same token at the
   * same moment — a flaky network and a client that retried — would otherwise
   * both read `revoked_at IS NULL`, both mint, and split one family into two
   * live branches. Serialising them means the second one sees the first one's
   * revocation and is correctly treated as reuse.
   */
  lockByHash(tokenHash: string): Promise<RefreshSession | null>;
  insert(session: NewRefreshSession): Promise<RefreshSession>;
  revoke(id: string, reason: RevokedReason, at: Date): Promise<void>;
  /** Revokes every unrevoked row in the family. Returns how many. */
  revokeFamily(familyId: string, reason: RevokedReason, at: Date): Promise<number>;
  /** Revokes every unrevoked row for the account. Returns how many. */
  revokeAllForAccount(
    accountId: string,
    reason: RevokedReason,
    at: Date,
  ): Promise<number>;
}

export interface SessionStore {
  /** Runs `fn` in one transaction. Rolls back if `fn` rejects. */
  transact<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T>;
}

export interface IssuedRefreshToken {
  /** Plaintext, returned to the client once. */
  readonly token: string;
  readonly session: RefreshSession;
}

export interface IssueInput {
  readonly accountId: string;
  readonly familyId: string;
  readonly now: Date;
  readonly ttlDays: number;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

/** Mints a token, stores its hash, and hands back both. */
export async function issueRefreshToken(
  tx: SessionTx,
  input: IssueInput,
): Promise<IssuedRefreshToken> {
  const { token, hash } = mintRefreshToken();
  const session = await tx.insert({
    accountId: input.accountId,
    familyId: input.familyId,
    tokenHash: hash,
    issuedAt: input.now,
    expiresAt: new Date(input.now.getTime() + input.ttlDays * 86_400_000),
    userAgent: input.userAgent,
    ip: input.ip,
  });
  return { token, session };
}

export interface StartSessionInput {
  readonly accountId: string;
  readonly now: Date;
  readonly ttlDays: number;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

/**
 * A fresh sign-in: a new family, with one token in it.
 *
 * Deliberately does not touch the account's other families. Signing in on a
 * phone must not sign you out of a tablet — each device is its own family, and
 * a compromise of one is contained to one.
 */
export function startSession(
  store: SessionStore,
  input: StartSessionInput,
): Promise<IssuedRefreshToken> {
  return store.transact((tx) =>
    issueRefreshToken(tx, { ...input, familyId: randomUUID() }),
  );
}

/**
 * Why a rotation attempt failed, when it did.
 *
 * All three refusals become the same 401 with the same body at the HTTP layer —
 * telling a caller which of "never existed", "expired" and "already used" they
 * hit tells them which one to work on. The distinction is kept here so that the
 * *log* can make it, because the three mean very different things to whoever is
 * reading it at 3am.
 */
export type RotationOutcome =
  | {
      readonly kind: 'rotated';
      readonly accountId: string;
      readonly familyId: string;
      readonly refresh: IssuedRefreshToken;
    }
  | { readonly kind: 'unknown-token' }
  | { readonly kind: 'expired'; readonly accountId: string; readonly familyId: string }
  | {
      readonly kind: 'reuse-detected';
      readonly accountId: string;
      readonly familyId: string;
      /** How many live sessions the detection killed. */
      readonly sessionsRevoked: number;
    };

export interface RotateInput {
  readonly presentedToken: string;
  readonly now: Date;
  readonly ttlDays: number;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export async function rotateRefreshToken(
  store: SessionStore,
  input: RotateInput,
): Promise<RotationOutcome> {
  const tokenHash = hashRefreshToken(input.presentedToken);

  return store.transact(async (tx): Promise<RotationOutcome> => {
    const presented = await tx.lockByHash(tokenHash);

    // No row. Either a token from a database that no longer exists, or a
    // guess. Nothing to revoke and nothing to infer — an unknown 32-byte string
    // is not evidence of anything, so this must not kill a family.
    if (!presented) return { kind: 'unknown-token' };

    // ---------------------------------------------------------------------
    // The one that matters.
    // ---------------------------------------------------------------------
    if (presented.revokedAt !== null) {
      // A revoked token cannot be presented by a client behaving correctly:
      // rotation hands back a replacement and the old value is overwritten. So
      // either it was copied, or the copy is the one being used now. Either way
      // every token in this lineage is suspect, including the one the real
      // client is holding — which is why this revokes the family and not just
      // the row.
      const sessionsRevoked = await tx.revokeFamily(
        presented.familyId,
        'reuse-detected',
        input.now,
      );
      return {
        kind: 'reuse-detected',
        accountId: presented.accountId,
        familyId: presented.familyId,
        sessionsRevoked,
      };
    }

    if (presented.expiresAt.getTime() <= input.now.getTime()) {
      // Marked rather than left dangling, so the purge job and the incident
      // reader both see a row with a reason on it. Not a family event: an
      // expired token is a person who was away for a month.
      await tx.revoke(presented.id, 'expired', input.now);
      return {
        kind: 'expired',
        accountId: presented.accountId,
        familyId: presented.familyId,
      };
    }

    // Issue first, revoke second. The reverse order has a window in which the
    // family has no live token, and a crash inside it signs the person out for
    // no reason. This order's failure mode is two live tokens for the duration
    // of one statement inside one transaction, which nothing outside can see.
    const refresh = await issueRefreshToken(tx, {
      accountId: presented.accountId,
      familyId: presented.familyId,
      now: input.now,
      ttlDays: input.ttlDays,
      userAgent: input.userAgent,
      ip: input.ip,
    });
    await tx.revoke(presented.id, 'rotated', input.now);

    return {
      kind: 'rotated',
      accountId: presented.accountId,
      familyId: presented.familyId,
      refresh,
    };
  });
}

/** `DELETE /sessions` — ends one sign-in, everywhere it was rotated to. */
export function signOutFamily(
  store: SessionStore,
  familyId: string,
  now: Date,
): Promise<number> {
  return store.transact((tx) => tx.revokeFamily(familyId, 'signed-out', now));
}

/** Every family the account has. Used on the deletion path. */
export function signOutAccount(
  store: SessionStore,
  accountId: string,
  now: Date,
): Promise<number> {
  return store.transact((tx) =>
    tx.revokeAllForAccount(accountId, 'account-closed', now),
  );
}
