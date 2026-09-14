import { randomUUID } from 'node:crypto';
import type {
  NewRefreshSession,
  RefreshSession,
  RevokedReason,
  SessionStore,
  SessionTx,
} from '../src/sessions.ts';

/**
 * An in-memory `SessionStore`, held to the same contract as `src/store.ts`.
 *
 * It exists so the rotation rules can be tested for what they are — a small
 * state machine with one security-critical branch — in milliseconds and
 * exhaustively, rather than against a Postgres container that makes the suite
 * slow enough that people stop running it.
 *
 * It is faithful in the two ways that matter to those rules:
 *
 * - `transact` rolls back on rejection, by snapshotting. Without that, a test
 *   could pass while the real store threw away a revocation.
 * - `insert` enforces the UNIQUE on `token_hash`.
 *
 * It does not model locking, because a single-threaded test cannot observe the
 * race `FOR UPDATE` prevents. That gap is stated rather than papered over: the
 * concurrency property is argued in a comment in `sessions.ts` and would need a
 * real database to demonstrate.
 */
export interface MemoryStore extends SessionStore {
  /** Every row, in insertion order. Tests read this directly. */
  rows(): readonly RefreshSession[];
  find(tokenHash: string): RefreshSession | undefined;
}

export function createMemoryStore(): MemoryStore {
  let sessions: RefreshSession[] = [];

  const tx: SessionTx = {
    async lockByHash(tokenHash) {
      return sessions.find((s) => s.tokenHash === tokenHash) ?? null;
    },

    async insert(session: NewRefreshSession) {
      if (sessions.some((s) => s.tokenHash === session.tokenHash)) {
        throw new Error('duplicate key value violates unique constraint');
      }
      const row: RefreshSession = {
        id: randomUUID(),
        accountId: session.accountId,
        familyId: session.familyId,
        tokenHash: session.tokenHash,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
        revokedAt: null,
        revokedReason: null,
      };
      sessions.push(row);
      return row;
    },

    async revoke(id: string, reason: RevokedReason, at: Date) {
      sessions = sessions.map((s) =>
        s.id === id && s.revokedAt === null
          ? { ...s, revokedAt: at, revokedReason: reason }
          : s,
      );
    },

    async revokeFamily(familyId: string, reason: RevokedReason, at: Date) {
      return revokeWhere((s) => s.familyId === familyId, reason, at);
    },

    async revokeAllForAccount(accountId: string, reason: RevokedReason, at: Date) {
      return revokeWhere((s) => s.accountId === accountId, reason, at);
    },
  };

  function revokeWhere(
    predicate: (session: RefreshSession) => boolean,
    reason: RevokedReason,
    at: Date,
  ): number {
    let count = 0;
    sessions = sessions.map((s) => {
      if (!predicate(s) || s.revokedAt !== null) return s;
      count += 1;
      return { ...s, revokedAt: at, revokedReason: reason };
    });
    return count;
  }

  return {
    async transact(fn) {
      const snapshot = [...sessions];
      try {
        return await fn(tx);
      } catch (error) {
        sessions = snapshot;
        throw error;
      }
    },
    rows: () => sessions,
    find: (tokenHash) => sessions.find((s) => s.tokenHash === tokenHash),
  };
}
