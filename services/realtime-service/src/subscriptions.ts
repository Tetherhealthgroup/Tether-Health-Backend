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

/** One connected client. */
export interface Subscriber {
  readonly accountId: string;
  /** Enrolments this subscriber may hear about, resolved when it connected. */
  readonly enrolmentIds: ReadonlySet<string>;
  /** Written to the socket. Returns false once the socket is gone. */
  readonly send: (event: ChangeNotification) => boolean;
}

/**
 * Decides whether one subscriber hears one notification.
 *
 * The allow-list is resolved once, at connect, from enrolments the account owns
 * plus enrolments a live consent names them as recipient of. Two consequences,
 * and the second is why the consent case is handled specially:
 *
 *   * A subscriber cannot hear about an enrolment that was not theirs when the
 *     stream opened. Joining a programme mid-stream means reconnecting, which
 *     is cheap and fails closed.
 *
 *   * A *revocation* must still reach them, precisely because it is the event
 *     that removes their access. Dropping it as "not yours any more" would
 *     leave a clinician console showing a record the person has just withdrawn,
 *     which is the failure `for-clinicians.astro` names: "revocation is
 *     enforced rather than merely recorded".
 */
export function shouldDeliver(
  subscriber: Subscriber,
  event: ChangeNotification,
): boolean {
  if (subscriber.enrolmentIds.has(event.enrolmentId)) return true;

  // Not currently theirs — the only thing they may still be told is that a
  // consent naming that enrolment was revoked, so they can close the view.
  return (
    event.table === 'programme.sharing_consent' && event.revoked === true
  );
}

/**
 * Fans one notification out to everyone entitled to it.
 *
 * Returns the subscribers whose socket has gone, so the caller can forget them.
 * A send failure is not an error here: a client closing a laptop lid is the
 * ordinary case, not an exception.
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
