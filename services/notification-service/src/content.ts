import type { Transaction } from '@tether/core';

/**
 * The safeguard, expressed as a type and a WeakSet.
 *
 * `safeguards.json` — `sensitive_notifications_off`, `defaultOff: true`:
 *
 *   "A lock screen shows that a reminder exists, never what it is about."
 *
 * A lock screen is the one surface in this product that is read by people who
 * are not the patient: a partner, a colleague glancing at a desk, a teenager's
 * parent. "Your naltrexone is due" and "You have a reminder" are the same
 * reminder and a completely different disclosure.
 *
 * ---------------------------------------------------------------------------
 * How a specific body is made impossible rather than discouraged
 * ---------------------------------------------------------------------------
 *
 * Four things, and each one closes a hole the previous one leaves open:
 *
 * 1. **The wire format has no text in it.** `POST /send` accepts a `kind` and
 *    an optional map of template variables — never a title and never a body.
 *    The request schema is `.strict()`, so a caller that sends `body` gets a
 *    400 rather than a field that is quietly dropped and might one day not be.
 *    There is no string a caller can put in a request that reaches a device as
 *    displayed text.
 *
 * 2. **The only two payloads that exist are built here.** `GENERIC` is a
 *    module-level constant. The specific wording lives in `TEMPLATES`, and
 *    nothing outside this file can reach either: neither is exported.
 *
 * 3. **The specific branch requires a value only the database can mint.**
 *    `render()` takes a `SpecificContentGrant | null`. Passing null — which is
 *    what every caller has, because `readSpecificContentGrant` returns null
 *    unless a row says otherwise — makes the specific branch unreachable.
 *    The type is branded with a `unique symbol` that is not exported, so a
 *    grant cannot be written down in another module.
 *
 * 4. **And the brand is checked at runtime, not just by the compiler.**
 *    TypeScript branding is defeated by `{} as SpecificContentGrant`, and a
 *    safeguard that a cast can switch off is a comment. So every grant this
 *    module mints is also recorded in a module-private `WeakSet`, and `render`
 *    verifies membership. A forged grant produces the generic payload, exactly
 *    as a missing one does — it does not throw, because failing *safe* is the
 *    point and an exception here would turn a suppressed disclosure into a lost
 *    reminder.
 *
 * The residual hole, stated honestly: anything editing *this file* can undo
 * all four. That is the intended boundary — the safeguard is one reviewed file,
 * not a rule spread across eight call sites where the next endpoint somebody
 * adds in a hurry will not know about it.
 */

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
}

/**
 * The only thing a locked device is allowed to show. One payload for every
 * kind, deliberately.
 *
 * Per-kind generic wording was the first draft — "You have a medication
 * reminder", "A message from your care team" — and it is a leak. The safeguard
 * says a lock screen shows *that* a reminder exists, not what it is about, and
 * "medication" is what it is about. Somebody reading a phone face-up on a table
 * should not be able to tell a check-in from a substance-use programme.
 */
const GENERIC: NotificationPayload = {
  title: 'Tether Health',
  body: 'You have a reminder',
};

/** The notification kinds this service knows how to send. */
export const KINDS = [
  'medication_reminder',
  'check_in_due',
  'programme_message',
  'care_team_message',
  'lapse_support',
] as const;

export type Kind = (typeof KINDS)[number];

interface Template {
  /** Template variable names this kind accepts. Anything else is a 400. */
  readonly variables: readonly string[];
  /** Only ever called behind a verified grant. */
  readonly specific: (vars: Readonly<Record<string, string>>) => NotificationPayload;
}

/**
 * The specific wording, for accounts that asked for it.
 *
 * Not exported. Variables are interpolated only inside `render`'s granted
 * branch, so a caller supplying `{ name: 'Naltrexone' }` for an account that
 * has not opted in produces "You have a reminder" and the value is never used,
 * never sent, and never logged.
 *
 * `?? ''` throughout rather than throwing on a missing variable: a reminder
 * that fails to send because a variable was absent is a missed dose, and the
 * degraded wording is still a true statement.
 */
const TEMPLATES: Readonly<Record<Kind, Template>> = {
  medication_reminder: {
    variables: ['name', 'dosage'],
    specific: (v) => ({
      title: 'Medication reminder',
      body: [v.name, v.dosage].filter(Boolean).join(' · ') || 'Time for your medication',
    }),
  },
  check_in_due: {
    variables: ['programme'],
    specific: (v) => ({
      title: 'Check-in',
      body: v.programme ? `Your ${v.programme} check-in is ready` : 'Your check-in is ready',
    }),
  },
  programme_message: {
    variables: ['programme'],
    specific: (v) => ({
      title: v.programme ?? 'Your programme',
      body: 'There is something new in your programme',
    }),
  },
  care_team_message: {
    variables: ['from'],
    specific: (v) => ({
      title: 'Your care team',
      body: v.from ? `${v.from} has sent you a message` : 'You have a new message',
    }),
  },
  lapse_support: {
    variables: [],
    // `slip_never_resets`: "A lapse is recorded in history. It never zeroes a
    // counter, streak or progress value." The wording follows the same rule —
    // nothing here counts days, and nothing congratulates or admonishes.
    specific: () => ({
      title: 'Tether Health',
      body: 'Support is here whenever you want it',
    }),
  },
};

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

/** The variable names a kind accepts, for the request schema to check against. */
export function variablesFor(kind: Kind): readonly string[] {
  return TEMPLATES[kind].variables;
}

// ---------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------

/**
 * Not exported, so `SpecificContentGrant` cannot be spelled out anywhere else.
 * `declare` means it exists only in the type system and emits nothing.
 */
declare const grantBrand: unique symbol;

export interface SpecificContentGrant {
  readonly [grantBrand]: true;
  /** Whose opt-in this is. Re-checked in `render`; see `accountMismatch`. */
  readonly accountId: string;
  readonly optedInAt: Date;
}

/**
 * Every grant this module has minted.
 *
 * A `WeakSet`, so a grant is collectable as soon as the request that read it
 * finishes — this must not become a per-account cache of "allowed to be
 * specific", because then revoking the preference would not take effect until
 * a restart. Each `/send` reads the row again.
 */
const MINTED = new WeakSet<object>();

type PreferenceRow = { specific_content: boolean; opted_in_at: Date | null };

/**
 * Reads the account's opt-in, and returns a grant only if it is on.
 *
 * The single place a `SpecificContentGrant` comes into existence. Called inside
 * `withPrincipal(accountId)`, so RLS restricts the read to that account's row
 * as well — a mistake in the WHERE clause returns nothing rather than somebody
 * else's preference, and nothing means generic.
 *
 * No row is the common case: `defaultOff: true` means an account that has never
 * been asked has never been written, and absence must read as off. If the
 * default were the other way round, the bug of forgetting to write a row on
 * signup would be a lock screen announcing somebody's medication.
 */
export async function readSpecificContentGrant(
  tx: Transaction,
  accountId: string,
): Promise<SpecificContentGrant | null> {
  const row = await tx.one<PreferenceRow>(
    `SELECT specific_content, opted_in_at
       FROM ops.notification_preference
      WHERE account_id = $1`,
    [accountId],
  );

  if (!row || row.specific_content !== true) return null;

  const grant = {
    accountId,
    optedInAt: row.opted_in_at ?? new Date(0),
  } as unknown as SpecificContentGrant;

  MINTED.add(grant);
  return grant;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export interface Rendered {
  readonly payload: NotificationPayload;
  /** Recorded in `ops.notification_log.variant`, so the choice is auditable. */
  readonly variant: 'generic' | 'specific';
}

/**
 * Turns a kind into the payload that will actually be sent.
 *
 * Three ways to end up generic, and all three are silent by design:
 *   - no grant (the overwhelmingly common case, and the default),
 *   - a grant this module did not mint (a forgery, or a cast),
 *   - a grant belonging to a different account than the one being sent to.
 *
 * The third is worth its own check. `/send` names a recipient and separately
 * reads a preference; if those two ever drift apart — a refactor, a cached
 * grant, a loop variable reused — the result would be one account's opt-in
 * authorising another account's lock screen. Comparing them here costs one
 * string comparison and removes the entire class.
 */
export function render(
  kind: Kind,
  accountId: string,
  grant: SpecificContentGrant | null,
  vars: Readonly<Record<string, string>> = {},
): Rendered {
  const authorised =
    grant !== null && MINTED.has(grant) && grant.accountId === accountId;

  // The early return is what keeps the variables out of everything downstream.
  // For an unauthorised call they are dropped here: they never reach a device,
  // a log line, or the delivery record, because the only expression that reads
  // them is below this line.
  if (!authorised) return { payload: GENERIC, variant: 'generic' };

  return { payload: TEMPLATES[kind].specific(vars), variant: 'specific' };
}

/**
 * The `data` block that travels alongside the notification.
 *
 * FCM data payloads are not displayed by the OS — they are handed to the app,
 * which by then is running behind whatever unlock the device requires. This is
 * the channel the safeguard depends on: the lock screen says a reminder exists,
 * and the app fetches what it is about after unlock, using the kind and the id
 * below.
 *
 * Template variables are deliberately not included. They are the specific
 * content in another form, and a data payload is readable by anything with the
 * device unlocked — including a notification-history screen that keeps a copy
 * long after the alert is dismissed.
 */
export function dataFor(kind: Kind, refId: string | null): Record<string, string> {
  return {
    kind,
    ...(refId ? { refId } : {}),
    // Tells the client to fetch rather than to display. A client build that
    // predates this flag shows the generic body it was sent, which is the safe
    // failure.
    fetch: 'true',
  };
}
