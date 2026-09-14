import type { Transaction } from '@tether/core';

/**
 * Writing to `ops.audit_event`.
 *
 * A near-copy of `records-service`'s, and deliberately not lifted into
 * `@tether/core`: the two write different things for different reasons, and the
 * moment they share one helper somebody will add a field that only one of them
 * should carry. What they share is the table, which is the part that is already
 * shared.
 *
 * Here the trail is not a supporting feature. A clinician reading a patient
 * record is a 42 CFR Part 2 disclosure, and this is the only service in the
 * platform that reads across a consent boundary at all — which is why it is a
 * separate service, with its own blast radius and its own trail. Every read
 * writes a row naming the enrolment, the scope relied on and the consent id.
 * A read that cannot be proved to have been consented is a read that should not
 * have been served, and the proof has to be written at the moment of serving or
 * it does not exist.
 *
 * Refusals are audited too, and that is the case with the sharp edge: the
 * refusal row has to survive the refusal. See `app.ts` — the audit write
 * commits and the `ProblemError` is thrown afterwards, outside the transaction,
 * because a throw inside it would roll the evidence back along with the read
 * that was denied.
 *
 * What never goes in `detail`: a note, an answer, a severity, a measured value.
 * The logger redacts those before a line leaves the process; a table gets no
 * such pass, and `ops.audit_event` has no update and no delete path.
 */

export interface AuditEvent {
  /**
   * Whose record was read — the *patient's* account, not the clinician's.
   *
   * `ops.audit_event.account_id` is the subject of the event. Filing a
   * disclosure under the person who made it rather than the person it was
   * about would make "who has seen my record" unanswerable, which is the one
   * question this table exists to answer.
   */
  readonly accountId: string | null;
  readonly actorRole: string;
  /** The clinician. Recorded in `detail` because the table has one account column. */
  readonly actorAccountId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  /** The enrolment. Named `programme_id` in the table. */
  readonly programmeId?: string | null;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const INSERT = `
  INSERT INTO ops.audit_event (
    account_id, actor_role, action, resource_type, resource_id,
    programme_id, request_id, ip_address, user_agent, detail
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9, $10::jsonb)
  RETURNING id, occurred_at
`;

export async function writeAudit(
  tx: Transaction,
  event: AuditEvent,
): Promise<void> {
  await tx.query(INSERT, [
    event.accountId,
    event.actorRole,
    event.action,
    event.resourceType,
    event.resourceId ?? null,
    event.programmeId ?? null,
    event.requestId ?? null,
    asInet(event.ipAddress),
    truncate(event.userAgent, 512),
    JSON.stringify({ ...(event.detail ?? {}), actorAccountId: event.actorAccountId }),
  ]);
}

/**
 * A value Postgres will accept as `inet`, or null.
 *
 * Checked rather than trusted: a malformed cast aborts the transaction, and the
 * transaction here is frequently the one carrying the audit row that justifies
 * a disclosure. A proxy sending a junk `X-Forwarded-For` must not be able to
 * make the trail fail to record.
 */
function asInet(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[0-9a-fA-F.:]{3,45}$/.test(value) ? value : null;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
