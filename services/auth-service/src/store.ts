import type { Database, Transaction } from '@tether/core';
import type {
  NewRefreshSession,
  RefreshSession,
  RevokedReason,
  SessionStore,
  SessionTx,
} from './sessions.ts';

/**
 * `identity.refresh_session` in Postgres, behind the interface in
 * `sessions.ts`.
 *
 * Nothing in here decides anything. Every branch — is this reuse, has it
 * expired, what gets revoked — lives in `sessions.ts` where it can be tested
 * without a database; this file only knows SQL. Keeping the split clean is what
 * lets the rotation tests be fast and exhaustive rather than slow and
 * representative.
 *
 * Every statement runs through `withoutPrincipal`. The account-scoped
 * connection would be wrong here and subtly so: the refresh path runs
 * *before* the caller's identity is established — that is what presenting a
 * refresh token means — so there is no `app.account_id` to set. Migration
 * 0004's RLS policy reflects that: this table is service-scoped, not
 * user-scoped.
 */

interface SessionRow {
  id: string;
  account_id: string;
  family_id: string;
  token_hash: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  [key: string]: unknown;
}

const COLUMNS = `
  id, account_id, family_id, token_hash,
  issued_at, expires_at, revoked_at, revoked_reason
`;

function toSession(row: SessionRow): RefreshSession {
  return {
    id: row.id,
    accountId: row.account_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: (row.revoked_reason as RevokedReason | null) ?? null,
  };
}

function sessionTx(tx: Transaction): SessionTx {
  return {
    async lockByHash(tokenHash) {
      // `FOR UPDATE` is the concurrency control for the whole rotation. See the
      // comment on `SessionTx.lockByHash` for what it prevents.
      const row = await tx.one<SessionRow>(
        `SELECT ${COLUMNS}
           FROM identity.refresh_session
          WHERE token_hash = $1
          FOR UPDATE`,
        [tokenHash],
      );
      return row ? toSession(row) : null;
    },

    async insert(session: NewRefreshSession) {
      const rows = await tx.query<SessionRow>(
        `INSERT INTO identity.refresh_session
           (account_id, family_id, token_hash, issued_at, expires_at, user_agent, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [
          session.accountId,
          session.familyId,
          session.tokenHash,
          session.issuedAt,
          session.expiresAt,
          session.userAgent,
          session.ip,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('refresh_session insert returned no row');
      return toSession(row);
    },

    async revoke(id, reason, at) {
      // `revoked_at IS NULL` in the predicate, not just in the caller's head.
      // A second revocation would otherwise overwrite the first reason, and the
      // first reason is the one that says whether this was a rotation or an
      // incident.
      await tx.query(
        `UPDATE identity.refresh_session
            SET revoked_at = $2, revoked_reason = $3
          WHERE id = $1 AND revoked_at IS NULL`,
        [id, at, reason],
      );
    },

    async revokeFamily(familyId, reason, at) {
      const rows = await tx.query<{ id: string }>(
        `UPDATE identity.refresh_session
            SET revoked_at = $2, revoked_reason = $3
          WHERE family_id = $1 AND revoked_at IS NULL
        RETURNING id`,
        [familyId, at, reason],
      );
      return rows.length;
    },

    async revokeAllForAccount(accountId, reason, at) {
      const rows = await tx.query<{ id: string }>(
        `UPDATE identity.refresh_session
            SET revoked_at = $2, revoked_reason = $3
          WHERE account_id = $1 AND revoked_at IS NULL
        RETURNING id`,
        [accountId, at, reason],
      );
      return rows.length;
    },
  };
}

export function createSessionStore(db: Database): SessionStore {
  return {
    transact: (fn) => db.withoutPrincipal((tx) => fn(sessionTx(tx))),
  };
}
