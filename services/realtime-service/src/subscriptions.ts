import { z } from 'zod';

/**
 * Who is allowed to hear about a change, and what they are told.
 *
 * Kept apart from the transport in `index.ts` because this is the part with a
 * rule in it, and a rule that lives inside an HTTP handler is a rule nobody can
 * test without a socket.
 */

/**
 * The payload a database trigger sends.
 *
 * Deliberately contains no row data — see the migration. A listener learns that
 * an enrolment changed and re-reads through the ordinary consent-checked API.
 */
export const changeNotification = z.object({
  enrolmentId: z.string().uuid(),
  table: z.string(),
  op: z.enum(['insert', 'update', 'delete']),
  at: z.string(),
  /** Present only on a consent change. */
  revoked: z.boolean().optional(),
});

export type ChangeNotification = z.infer<typeof changeNotification>;

/** The one table whose events are about *who may see* rather than *what changed*. */
const CONSENT_TABLE = 'programme.sharing_consent';

/**
 * One connected client.
 *
 * Two sets, not one, because the two relationships are different in the one
 * place it matters. An enrolment a subscriber *owns* stays theirs however many
 * consents come and go. An enrolment *shared with* them is theirs only while a
 * consent says so, and the stream has to stop talking about it the moment that
 * consent is revoked.
 */
export interface Subscriber {
  readonly accountId: string;
  /** Enrolments this account owns, resolved when it connected. */
  readonly owned: ReadonlySet<string>;
  /**
   * Enrolments shared with this account by a live consent, resolved when it
   * connected. Mutable on purpose: [fanOut] removes an enrolment from it when a
   * revocation for that enrolment has been delivered.
   */
  readonly shared: Set<string>;
  /** Written to the socket. Returns false once the socket is gone. */
  readonly send: (event: ChangeNotification) => boolean;
}

/**
 * Decides whether one subscriber hears one notification, *synchronously*.
 *
 * Only the owning account hears about an enrolment's changes, plus any account a
 * live consent names as a recipient of that enrolment. The allow-lists are
 * resolved once, at connect, under the caller's own principal. Consequences:
 *
 *   * A subscriber cannot hear about an enrolment that was not theirs when the
 *     stream opened. Joining a programme or being granted a share mid-stream
 *     means reconnecting, which is cheap and fails closed.
 *
 *   * A consent event is not a change to somebody's record, it is a statement
 *     about who may see it. The *owner* is told of every grant and revocation on
 *     their own enrolment. A *recipient* is told of a revocation on an enrolment
 *     they currently hold only if it is *theirs* ("revocation is enforced rather
 *     than merely recorded", `for-clinicians.astro`), and that is decided by
 *     [dispatch], not here: the notification does not say whose consent it was
 *     (R-063, 0012), so it takes a database read to know. This function
 *     therefore never delivers a consent event to a recipient. Nobody else hears
 *     either. A grant is the owner's alone: a co-recipient learning that somebody
 *     else was just granted a share is itself a disclosure.
 */
export function shouldDeliver(
  subscriber: Subscriber,
  event: ChangeNotification,
): boolean {
  if (subscriber.owned.has(event.enrolmentId)) return true;
  if (!subscriber.shared.has(event.enrolmentId)) return false;

  // A recipient of this enrolment. Record changes are theirs to hear while the
  // consent lives; consent events are settled by [dispatch].
  return event.table !== CONSENT_TABLE;
}

/**
 * Fans one notification out to everyone entitled to it, without a database read.
 *
 * Returns the subscribers whose socket has gone, so the caller can forget them.
 * A send failure is not an error here: a client closing a laptop lid is the
 * ordinary case, not an exception. Consent revocations for recipients are not
 * handled here; use [dispatch], which is what the service calls.
 */
export function fanOut(
  subscribers: Iterable<Subscriber>,
  event: ChangeNotification,
): Subscriber[] {
  const dead: Subscriber[] = [];
  for (const subscriber of subscribers) {
    if (!shouldDeliver(subscriber, event)) continue;
    if (!subscriber.send(event)) dead.push(subscriber);
  }
  return dead;
}

/** Whether a live consent still names `accountId` as recipient of `enrolmentId`. */
export type HoldsLiveConsent = (accountId: string, enrolmentId: string) => Promise<boolean>;

/**
 * Delivers one notification, settling who a revocation concerns.
 *
 * The revocation payload carries no recipient (R-063), so for each *recipient*
 * of the enrolment the question "was it theirs?" is answered by asking whether a
 * live consent still names them. The order matters and fails closed:
 *
 *   1. Synchronously, before any await: every recipient of the enrolment is
 *      removed from it ("held back") and the owner and every other subscriber
 *      are served. From this point no later change to that enrolment reaches a
 *      held-back recipient, whatever the check says.
 *   2. Then, for each held-back recipient: a live consent still names them, so
 *      the revocation was someone else's. They are told nothing and the
 *      enrolment is put back. None does, so it was theirs: they are told, and the
 *      enrolment stays removed.
 *   3. A check that throws counts as "no live consent": the recipient is told and
 *      dropped, and reconnects. A failed lookup never leaves access in place.
 *
 * The cost of the held-back window is that a co-recipient whose consent is live
 * may miss a record change that arrives while the check runs (milliseconds). The
 * client re-reads on reconnect, and the alternative is delivering metadata about
 * a withdrawn record.
 *
 * Returns the subscribers whose socket has gone. Only a revocation is async.
 */
export async function dispatch(
  subscribers: Iterable<Subscriber>,
  event: ChangeNotification,
  holdsLiveConsent: HoldsLiveConsent,
): Promise<Subscriber[]> {
  const heldBack: Subscriber[] = [];
  if (event.table === CONSENT_TABLE && event.revoked === true) {
    for (const subscriber of subscribers) {
      if (subscriber.owned.has(event.enrolmentId)) continue;
      if (subscriber.shared.delete(event.enrolmentId)) heldBack.push(subscriber);
    }
  }

  const dead = fanOut(subscribers, event);

  await Promise.all(
    heldBack.map(async (subscriber) => {
      let stillHolds: boolean;
      try {
        stillHolds = await holdsLiveConsent(subscriber.accountId, event.enrolmentId);
      } catch {
        stillHolds = false;
      }
      if (stillHolds) {
        subscriber.shared.add(event.enrolmentId);
      } else if (!subscriber.send(event)) {
        dead.push(subscriber);
      }
    }),
  );
  return dead;
}

/**
 * The payload of a `tether_change` notification, or null.
 *
 * `JSON.parse` throws on text that is not JSON, and an exception inside a
 * `notification` listener is an uncaught one — which `@tether/core`'s server
 * treats as fatal. A bad payload means a trigger and this service disagree
 * about the contract; that is worth a log line and not worth taking down every
 * open stream.
 */
export function parseNotification(payload: string): ChangeNotification | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = changeNotification.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Formats one event as an SSE frame. */
export function toSseFrame(event: ChangeNotification): string {
  // A named event so a client can route without parsing, and an id so a
  // reconnect can say where it got to. The blank line terminates the frame —
  // omitting it is the classic reason an SSE stream appears to hang.
  return (
    `event: change\n` +
    `id: ${event.at}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  );
}
