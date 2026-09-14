import { isIP } from 'node:net';
import { type Database, problem } from '@tether/core';

/**
 * `identity.account`, and the deletion that has to be provable.
 */

export interface Account {
  readonly id: string;
  /** The Supabase subject. Opaque, and the only link back to the IdP. */
  readonly externalId: string;
  readonly email: string | null;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
}

interface AccountRow {
  id: string;
  external_id: string;
  email: string | null;
  status: string;
  created_at: Date;
  last_seen_at: Date | null;
  [key: string]: unknown;
}

const COLUMNS = 'id, external_id, email, status, created_at, last_seen_at';

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    externalId: row.external_id,
    email: row.email,
    status: row.status as Account['status'],
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** The JSON shape `GET /me` and `POST /sessions` return. */
export function accountBody(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    status: account.status,
    createdAt: account.createdAt.toISOString(),
    lastSeenAt: account.lastSeenAt?.toISOString() ?? null,
  };
}

/**
 * Turns a verified Supabase identity into a Tether account.
 *
 * Keyed on `external_id`, the Supabase subject — never on the email address.
 * An email is something a person changes; a subject is not, and an upsert keyed
 * on a mutable identifier silently creates a second account the first time
 * somebody updates theirs.
 *
 * `last_seen_at` is written on every sign-in because it is the only
 * account-level activity signal this service has, and the retention promise on
 * `privacy.astro` needs one.
 */
export async function upsertAccount(
  db: Database,
  input: { externalId: string; email: string | null },
): Promise<Account> {
  const rows = await db.withoutPrincipal((tx) =>
    tx.query<AccountRow>(
      `INSERT INTO identity.account (external_id, email, last_seen_at)
            VALUES ($1, $2, now())
       ON CONFLICT (external_id) DO UPDATE
            SET email = COALESCE(EXCLUDED.email, identity.account.email),
                last_seen_at = now()
         RETURNING ${COLUMNS}`,
      [input.externalId, input.email],
    ),
  ).catch((error: unknown) => {
    // `email` carries its own UNIQUE constraint, so this INSERT can conflict on
    // a key the ON CONFLICT clause does not cover: a second Supabase identity
    // — a magic link where there was a password, say — arriving with an email
    // that already belongs to another account. Merging two accounts is a
    // product decision with PHI on both sides of it, so this refuses and says
    // so rather than guessing.
    if (isUniqueViolation(error)) {
      throw problem.conflict(
        'That email address already belongs to another Tether account.',
      );
    }
    throw error;
  });

  const account = rows[0];
  if (!account) throw new Error('account upsert returned no row');

  const result = toAccount(account);

  // A closed or suspended account authenticates perfectly well upstream —
  // Supabase knows nothing about our status column. Checked here, where the
  // Tether account is resolved, because this is the only place that can.
  if (result.status !== 'active') {
    throw problem.forbidden('This account is not active.');
  }

  return result;
}

export async function findAccount(
  db: Database,
  accountId: string,
): Promise<Account | null> {
  const row = await db.withPrincipal(accountId, (tx) =>
    tx.one<AccountRow>(
      `SELECT ${COLUMNS} FROM identity.account WHERE id = $1`,
      [accountId],
    ),
  );
  return row ? toAccount(row) : null;
}

export interface DeletionContext {
  readonly accountId: string;
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * `DELETE /me` — the deletion, and the proof that it happened.
 *
 * `PRODUCTION_RELEASE_CHECKLIST.md`: *"Implement verified exports and deletion
 * with auditable completion."* Three things follow from that sentence and all
 * three are in the ordering below.
 *
 * **The audit row is written first.** Not as a formality — if the process dies
 * between the two statements, the transaction rolls back and there is neither
 * an audit row nor a deletion, which is a consistent state. The reverse order
 * has a window where the data is gone and nothing records that anyone asked.
 *
 * **The audit row outlives the account.** `ops.audit_event.account_id` is
 * deliberately not a foreign key (0001), and 0001's rules forbid UPDATE and
 * DELETE on the table, so the one event most worth being able to prove cannot
 * be cascaded or edited away. The `external_id` goes into `detail` for the same
 * reason: after the account row is gone, the IdP subject is the only handle
 * left to answer "did you actually delete my data?" with.
 *
 * **It returns only after the rows are gone.** One transaction, and the promise
 * resolves after `COMMIT`. Not a job queued, not a `deleted_at` set — there is
 * no soft delete on anything downstream of this, by design, and the cascade
 * from `identity.account` reaches enrolments, and through them every answer,
 * lapse event and observation, plus child profiles and every refresh session.
 *
 * The one thing deliberately *not* done: writing the audit row in its own
 * committed transaction so that a failed deletion still leaves a trace. That
 * would produce an audit trail asserting completions that did not happen, and
 * an audit trail that is sometimes wrong is worse than one with a gap, because
 * the gap is visible.
 */
export async function deleteAccount(
  db: Database,
  context: DeletionContext,
): Promise<void> {
  await db.withPrincipal(context.accountId, async (tx) => {
    const existing = await tx.one<{ external_id: string }>(
      `SELECT external_id FROM identity.account WHERE id = $1 FOR UPDATE`,
      [context.accountId],
    );
    if (!existing) {
      // Rolls back the transaction, which is what we want: nothing to delete
      // means nothing to record.
      throw problem.notFound('No such account.');
    }

    await tx.query(
      // `account_id` and `resource_id` both carry the account id but have
      // different column types (uuid and text), so they take separate
      // placeholders. Reusing one would ask Postgres to deduce two types for a
      // single parameter, which it refuses to do.
      `INSERT INTO ops.audit_event
         (account_id, actor_role, action, resource_type, resource_id,
          request_id, ip_address, user_agent, detail)
       VALUES ($1::uuid, 'account-holder', 'account.delete', 'account', $2::text,
               $3::text, $4::inet, $5::text,
               jsonb_build_object('external_id', $6::text))`,
      [
        context.accountId,
        context.accountId,
        context.requestId,
        toInet(context.ip),
        context.userAgent,
        existing.external_id,
      ],
    );

    const deleted = await tx.query<{ id: string }>(
      `DELETE FROM identity.account WHERE id = $1 RETURNING id`,
      [context.accountId],
    );
    if (deleted.length !== 1) {
      // Belt and braces. If the DELETE matched nothing after the locking SELECT
      // matched something, the invariant this endpoint promises is broken and
      // the right answer is to abort rather than to report success.
      throw new Error(
        `account delete affected ${deleted.length} rows, expected exactly 1`,
      );
    }
  });
}

/**
 * An address Postgres will accept into an `inet` column, or null.
 *
 * `req.ip` is shaped by `trust proxy` and by whatever wrote
 * `x-forwarded-for` — which is a client-supplied header at the edge. An
 * unparseable value must not be able to abort an account deletion, so anything
 * that is not an IP becomes null and the audit row is written without it.
 */
export function toInet(value: string | null | undefined): string | null {
  if (!value) return null;
  return isIP(value) === 0 ? null : value;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}
