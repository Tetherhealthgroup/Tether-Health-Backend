import { isIP } from 'node:net';
import type { Request } from 'express';
import { principalOf, type Transaction } from '@tether/core';

/**
 * `ops.audit_event`, written for every state change this service makes.
 *
 * Joining, pausing, ending, granting consent and revoking consent are the five
 * things that change what happens to a person's data, and each one is recorded.
 * The table is append-only — `0001_foundation.sql` puts `DO INSTEAD NOTHING`
 * rules on UPDATE and DELETE, because an audit trail that can be edited is a
 * log — and `account_id` is deliberately not a foreign key, so the record of a
 * deletion outlives the account it describes.
 *
 * Every write below happens inside the same transaction as the change it
 * describes. That matters in both directions: a join that rolls back must not
 * leave an audit row claiming it happened, and a join that commits must not be
 * able to commit without one.
 */

/** The actions this service can record. Enumerated so they cannot drift. */
export type AuditAction =
  | 'programme.join'
  | 'programme.pause'
  | 'programme.resume'
  | 'programme.end'
  | 'consent.grant'
  | 'consent.revoke';

export interface AuditEntry {
  readonly action: AuditAction;
  readonly resourceType: 'enrolment' | 'sharing_consent';
  readonly resourceId: string;
  /** The enrolment the event belongs to, for the per-programme audit view. */
  readonly programmeId: string | null;
  /**
   * Context for the event. Never PHI, and never the person's own words.
   *
   * A consent grant records the scope, the recipient kind and the consent
   * version — enough to reconstruct the decision — and not `consent_text`,
   * which is already stored on the row it describes, nor anything read out of
   * `record.*`. `logger.ts` redacts `*.text`, `*.note` and `*.severity` on the
   * way to the collector; this table has no such net, so nothing that would
   * need redacting is put in it.
   */
  readonly detail?: Record<string, unknown>;
}

/**
 * `inet` rejects anything that is not an address, and an invalid one would
 * abort the transaction the audit row is meant to be describing.
 *
 * Express behind `trust proxy` usually yields a clean address, but `req.ip` can
 * also be an IPv6-mapped form or, when a proxy is misconfigured, a comma-joined
 * list. Failing the audit write — and therefore the join — because a header was
 * malformed is the wrong trade: the address is context, the event is the
 * record.
 */
function inetOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim();
  return isIP(candidate) === 0 ? null : candidate;
}

export async function writeAudit(
  tx: Transaction,
  req: Request,
  entry: AuditEntry,
): Promise<void> {
  const principal = principalOf(req);

  await tx.query(
    `INSERT INTO ops.audit_event
       (account_id, actor_role, action, resource_type, resource_id,
        programme_id, request_id, ip_address, user_agent, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      principal.accountId,
      // The person acting on their own record is the common case and has no
      // role claim; recording `patient` rather than null keeps the column
      // answerable to "who did this" without a join.
      principal.roles[0] ?? 'patient',
      entry.action,
      entry.resourceType,
      entry.resourceId,
      entry.programmeId,
      req.requestId,
      inetOrNull(req.ip),
      // Bounded: a user agent is attacker-controlled and this row is kept
      // forever.
      req.header('user-agent')?.slice(0, 512) ?? null,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
}
