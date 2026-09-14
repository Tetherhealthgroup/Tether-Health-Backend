import type { Transaction } from '@tether/core';
import type { WaitlistEnquiry } from './schema.ts';

/**
 * Everything this service does to `ops.waitlist_enquiry`.
 *
 * Kept apart from the routes so the SQL can be read in one place, and because
 * the retention job below is the half of the privacy notice that is easiest to
 * forget exists.
 */

/** Result of a submission: the row's id, and whether it is a new row. */
export interface RecordResult {
  readonly id: string;
  readonly created: boolean;
}

type IdRow = { id: string; created: boolean };

/**
 * Stores an enquiry, or returns the recent one it duplicates.
 *
 * A person who taps "Request early access" twice — because the first tap did
 * not visibly do anything, which on a slow connection it will not have — is not
 * making a mistake that deserves an error. A 409 here would be read by the
 * client as a failure and would send them to `mailto:`, so the second tap has
 * to be a success that quietly resolves to the first row.
 *
 * One statement rather than a SELECT followed by an INSERT: two statements race
 * with themselves under a double tap, which is the exact case this exists for.
 * Two requests landing in the same millisecond can still both insert — the
 * window is now microseconds wide rather than a round trip — and a rare
 * duplicate enquiry is a far better outcome than a lost one, so there is no
 * unique constraint on `email` to make it impossible. Someone genuinely
 * enquiring twice a year apart must get two rows.
 */
export async function recordEnquiry(
  tx: Transaction,
  enquiry: WaitlistEnquiry,
  dedupeWindowMs: number,
): Promise<RecordResult> {
  const rows = await tx.query<IdRow>(
    `
    WITH recent AS (
      SELECT id
        FROM ops.waitlist_enquiry
       WHERE email = $2
         AND received_at > now() - ($6::text || ' milliseconds')::interval
       ORDER BY received_at DESC
       LIMIT 1
    ),
    inserted AS (
      INSERT INTO ops.waitlist_enquiry (name, email, role, interest, message, source)
      SELECT $1, $2, $3, $4, $5, 'website'
       WHERE NOT EXISTS (SELECT 1 FROM recent)
      RETURNING id
    )
    SELECT id, true  AS created FROM inserted
    UNION ALL
    SELECT id, false AS created FROM recent
    `,
    [
      enquiry.name,
      enquiry.email,
      enquiry.role,
      enquiry.interest,
      enquiry.message,
      String(dedupeWindowMs),
    ],
  );

  const row = rows[0];
  if (!row) {
    // Neither branch produced a row. That is not reachable by design, so it is
    // a bug in the statement above rather than a case to paper over with a
    // fabricated id the caller would then quote back at us.
    throw new Error('waitlist insert returned no row');
  }
  return { id: row.id, created: row.created };
}

/**
 * Deletes one enquiry. Returns whether a row was actually removed.
 *
 * privacy.astro: "…and sooner if you ask us to delete it." This is that half.
 * The row is gone when this returns — there is no `deleted_at`, for the same
 * reason the PHI tables have none: a soft delete is the hidden kind of
 * deletion, and the promise made on the website is not a promise to hide it.
 */
export async function deleteEnquiry(
  tx: Transaction,
  id: string,
): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'DELETE FROM ops.waitlist_enquiry WHERE id = $1 RETURNING id',
    [id],
  );
  return rows.length > 0;
}

/**
 * Deletes everything past its `purge_after`.
 *
 * `purge_after` defaults to `now() + interval '2 years'` in
 * `0001_foundation.sql`, which encodes the published promise: "We keep
 * early-access enquiries until the relevant product has launched and we have
 * contacted you, or for two years, whichever comes first."
 *
 * A column holding a date nothing acts on is a retention *intention*. This
 * endpoint is what makes it a retention policy, and it is why the column is
 * indexed — `waitlist_purge ON ops.waitlist_enquiry(purge_after)` exists for
 * exactly this query.
 *
 * `limit` is not a performance tweak. A first run against two years of backlog
 * that deletes everything in one transaction holds locks for as long as it
 * takes; batching lets the job be run repeatedly until it reports zero.
 */
export async function purgeExpired(
  tx: Transaction,
  limit: number,
): Promise<number> {
  const rows = await tx.query<{ id: string }>(
    `
    DELETE FROM ops.waitlist_enquiry
     WHERE id IN (
       SELECT id FROM ops.waitlist_enquiry
        WHERE purge_after <= now()
        ORDER BY purge_after
        LIMIT $1
     )
    RETURNING id
    `,
    [limit],
  );
  return rows.length;
}

export interface AuditEntry {
  readonly action: string;
  readonly resourceId: string | null;
  readonly actorRole: string | null;
  readonly requestId: string;
  readonly ip: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Writes the proof that a deletion happened.
 *
 * "Implement verified exports and deletion with auditable completion" —
 * `PRODUCTION_RELEASE_CHECKLIST.md`. The audit row is written in the same
 * transaction as the delete, so there is no window in which the data is gone
 * and the evidence is not, or the reverse.
 *
 * Note what is *not* in `detail`: the email address. `ops.audit_event` outlives
 * the row it describes, so putting the address in it would mean a deletion
 * request left the identifier behind in a table with no delete rule on it —
 * honouring the request by moving the personal data somewhere less reachable.
 * The enquiry id is enough to prove which row went.
 */
export async function audit(tx: Transaction, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO ops.audit_event
       (actor_role, action, resource_type, resource_id, request_id, ip_address, detail)
     VALUES ($1, $2, 'waitlist_enquiry', $3, $4, $5, $6::jsonb)`,
    [
      entry.actorRole,
      entry.action,
      entry.resourceId,
      entry.requestId,
      entry.ip,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
