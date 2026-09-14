import type { Transaction } from '@tether/core';

/**
 * Writing to `ops.audit_event`.
 *
 * Every write to the record, and every export or deletion of it, leaves a row
 * here. That is not a general "log everything" instinct — it is the half of
 * `PRODUCTION_RELEASE_CHECKLIST.md`'s *"verified exports and deletion with
 * auditable completion"* that the deletion itself cannot provide, because the
 * data it describes is gone by the time anybody asks.
 *
 * Two properties of `ops.audit_event` (0001) shape this file:
 *
 * 1. `account_id` is deliberately not a foreign key. An audit row that cascaded
 *    away with the account would make the one event most worth proving
 *    unprovable. Nothing here may reintroduce that dependency.
 * 2. `ON UPDATE`/`ON DELETE` are rules that do nothing. There is no correction
 *    path, so a row written wrong stays wrong — which is why `detail` below is
 *    restricted to counts, ids and scopes.
 *
 * `detail` never carries a value out of the record. `@tether/core`'s logger
 * redacts `*.text`, `*.answers` and `*.severity` before a line leaves the
 * process; an audit row is a table, not a log line, and gets no such pass. A
 * clinician who wanted to read a note by reading the audit trail must find
 * nothing there worth reading.
 */

export interface AuditEvent {
  /** Whose record this concerns. For this service, always the caller's own. */
  readonly accountId: string;
  /** The role the caller acted in, from the JWT. */
  readonly actorRole: string;
  /** Dotted and stable: `record.answers.write`, `record.export`, … */
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  /** The enrolment. Named `programme_id` in the table. */
  readonly programmeId?: string | null;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /** Counts, ids, scopes. Never a value from the record. */
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
    JSON.stringify(event.detail ?? {}),
  ]);
}

/**
 * A value Postgres will accept as `inet`, or null.
 *
 * Checked here rather than trusted, because a malformed cast aborts the
 * transaction — and in `DELETE /record` that transaction is the deletion. A
 * proxy sending a junk `X-Forwarded-For` must not be able to make an erasure
 * fail, so an unparseable address becomes "unknown" and the row is still
 * written.
 */
function asInet(value: string | null | undefined): string | null {
  if (!value) return null;
  // Express reports IPv4 through an IPv6 socket as `::ffff:1.2.3.4`, which
  // `inet` accepts; anything outside this alphabet is not worth attempting.
  return /^[0-9a-fA-F.:]{3,45}$/.test(value) ? value : null;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
