import type { Transaction } from '@tether/core';

/**
 * The enrolments one account may hear about, resolved when its stream opens.
 *
 * Both statements name the account. This used to be one `SELECT` with no
 * predicate over `programme.enrolment` and `programme.sharing_consent`, run
 * under the caller's principal and trusting row-level security to narrow it.
 * Under the superuser the services connected as, RLS did not narrow it, so every
 * subscriber's allow-list was *every enrolment in the database* and every
 * subscriber heard about every record change (R-032). Under a least-privilege
 * role the policy would have narrowed it, but a recipient policy widens the
 * `enrolment` read to shared enrolments too, so the two sets would have been
 * indistinguishable. Asking for each by name keeps them apart, and keeps the
 * answer right if either policy is ever changed.
 */
export interface Allowlist {
  /** Enrolments the account owns. */
  readonly owned: Set<string>;
  /** Enrolments a live consent names the account as recipient of. */
  readonly shared: Set<string>;
}

export async function resolveAllowlist(
  tx: Transaction,
  accountId: string,
): Promise<Allowlist> {
  const owned = await tx.query<{ id: string }>(
    `SELECT id FROM programme.enrolment WHERE account_id = $1`,
    [accountId],
  );

  const shared = await tx.query<{ enrolment_id: string }>(
    `SELECT DISTINCT enrolment_id
       FROM programme.sharing_consent
      WHERE recipient_id = $1 AND revoked_at IS NULL`,
    [accountId],
  );

  const ownedIds = new Set(owned.map((row) => row.id));
  return {
    owned: ownedIds,
    // An enrolment the account owns is never "shared with" it, whatever a
    // consent row says, so a revocation cannot strip an owner of their own.
    shared: new Set(
      shared.map((row) => row.enrolment_id).filter((id) => !ownedIds.has(id)),
    ),
  };
}
