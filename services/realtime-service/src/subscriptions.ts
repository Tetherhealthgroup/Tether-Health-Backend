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
  /**
   * On a revocation, whose consent it was (0012). Null for a consent that names
   * no recipient, and absent from a notification written before 0012 existed;
   * both mean "every recipient of the enrolment".
   */
  recipientId: z.string().nullable().optional(),
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
 * Decides whether one subscriber hears one notification.
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
 *     about who may see it. Two different parties are entitled to it, for two
 *     different reasons:
 *       - the *owner*, who is told of every grant and revocation on their own
 *         enrolment;
 *       - a *recipient*, and only about a **revocation** on an enrolment they
 *         currently hold — because it is the event that removes their access,
 *         and dropping it would leave a clinician console showing a record the
 *         person has just withdrawn ("revocation is enforced rather than merely
 *         recorded", `for-clinicians.astro`).
 *     Nobody else hears either. This function used to deliver *every*
 *     revocation, for *every* enrolment, to *every* connected subscriber
 *     (R-033): the exemption was written for "a subscriber who just lost
 *     access" and applied to a subscriber who never had any. A grant, by the
 *     same reasoning, is the owner's alone — a co-recipient learning that
 *     somebody else was just granted a share is itself a disclosure.
 */
export function shouldDeliver(
  subscriber: Subscriber,
  event: ChangeNotification,
): boolean {
  if (subscriber.owned.has(event.enrolmentId)) return true;
  if (!subscriber.shared.has(event.enrolmentId)) return false;

  // A recipient of this enrolment. Record changes are theirs to hear while the
  // consent lives; of the consent's own events, only the revocation of *theirs*.
  if (event.table !== CONSENT_TABLE) return true;
  return endsAccessOf(subscriber, event);
}

/**
 * True when `event` is a revocation that removes `subscriber`'s access.
 *
 * With `recipientId` it is exactly the recipient it names: another recipient of
 * the same enrolment, whose own consent is still live, is neither told nor
 * dropped. Without one (a consent that names nobody, or a notification from
 * before the payload carried it) it cannot tell whose, and so means every
 * recipient — the fail-closed reading, as before.
 */
function endsAccessOf(subscriber: Subscriber, event: ChangeNotification): boolean {
  if (event.revoked !== true) return false;
  return event.recipientId == null || event.recipientId === subscriber.accountId;
}

/**
 * Fans one notification out to everyone entitled to it.
 *
 * Returns the subscribers whose socket has gone, so the caller can forget them.
 * A send failure is not an error here: a client closing a laptop lid is the
 * ordinary case, not an exception.
 *
 * A revocation that reaches a recipient also removes the enrolment from what
 * they may hear about. Without that, the stream would go on announcing every
 * later change to a record the person has withdrawn — metadata only, since a
 * notification carries no row, but metadata about a record the recipient is no
 * longer entitled to. Only the recipient the revocation names is dropped (0012 puts
 * `recipientId` in the payload), so another recipient of the same enrolment,
 * whose consent is still live, neither hears of it nor loses their view.
 */
export function fanOut(
  subscribers: Iterable<Subscriber>,
  event: ChangeNotification,
): Subscriber[] {
  const dead: Subscriber[] = [];
  for (const subscriber of subscribers) {
    if (!shouldDeliver(subscriber, event)) continue;
    if (!subscriber.send(event)) dead.push(subscriber);

    if (
      event.table === CONSENT_TABLE &&
      !subscriber.owned.has(event.enrolmentId) &&
      endsAccessOf(subscriber, event)
    ) {
      subscriber.shared.delete(event.enrolmentId);
    }
  }
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
