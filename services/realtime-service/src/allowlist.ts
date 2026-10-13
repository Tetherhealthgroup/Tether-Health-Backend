import { assertAccountId, type Transaction } from '@tether/core';

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
  // `recipient_id` is `text` and compared as text, so an upper-case `sub` would
  // match nothing there while matching the uuid column above. The same
  // normalisation `withPrincipal` applies to `app.account_id`, applied here too.
  const account = assertAccountId(accountId);
  const owned = await tx.query<{ id: string }>(
    `SELECT id FROM programme.enrolment WHERE account_id = $1`,
    [account],
  );

  const shared = await tx.query<{ enrolment_id: string }>(
    `SELECT DISTINCT enrolment_id
       FROM programme.sharing_consent
      WHERE recipient_id = $1 AND revoked_at IS NULL`,
    [account],
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

/**
 * Whether a live consent still names `accountId` as recipient of `enrolmentId`.
 *
 * Asked after a consent revocation, under the subscriber's own principal, to find
 * out whether the revocation was theirs: the NOTIFY does not say (R-063). The
 * account is named in the statement as well as in the policy, as everywhere here.
 */
export async function holdsLiveConsent(
  tx: Transaction,
  accountId: string,
  enrolmentId: string,
): Promise<boolean> {
  const account = assertAccountId(accountId);
  const rows = await tx.query(
    `SELECT 1
       FROM programme.sharing_consent
      WHERE enrolment_id = $1 AND recipient_id = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [enrolmentId, account],
  );
  return rows.length > 0;
}
