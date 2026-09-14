import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * Conditional responses for the catalogue.
 *
 * This is the one service where caching is a correctness concern rather than a
 * performance one. The catalogue is the whole design bundle — eleven areas,
 * twenty safeguards, thirty-one archetypes and two products' worth of screen
 * content — and every cold app start fetches all of it, on a phone that may be
 * on cellular in a clinic waiting room. Serving it unconditionally means every
 * launch pays for a payload that changed last in March.
 *
 * It is also the reason this data moved out of the Flutter bundle in the first
 * place: an area going from `planned` to `in_development` used to need an App
 * Store release. Having made that a server change, the server has to make it
 * cheap to check for, or the client will cache it forever by hand and the
 * problem comes back wearing a different hat.
 */

/** How long a client may reuse a copy without asking. */
const MAX_AGE_SECONDS = 300;

/** How long a stale copy may be served while a refresh happens behind it. */
const STALE_WHILE_REVALIDATE_SECONDS = 86_400;

/**
 * A strong ETag over the exact bytes that would be sent.
 *
 * Strong rather than weak (`W/`) because the comparison this enables is
 * byte-equality of the body, which is what the hash measures. Claiming weak
 * equivalence would let an intermediary substitute a semantically-similar
 * response, and "semantically similar" is not a thing anybody has defined for
 * a payload whose whole job is to carry exact clinical wording.
 */
export function etagOf(serialisedBody: string): string {
  return `"${createHash('sha256').update(serialisedBody).digest('base64url')}"`;
}

/**
 * True when the caller already holds this exact representation.
 *
 * Handles the three forms RFC 9110 permits and the model repo's naive
 * `header === etag` comparison did not: a list of candidates, the `*` wildcard,
 * and a weak validator prefix on a tag the client echoes back from a proxy that
 * weakened it. Getting this wrong fails safe — a mismatch resends the body —
 * but it fails safe by never saving anybody anything.
 */
export function matchesIfNoneMatch(
  headerValue: string | undefined,
  etag: string,
): boolean {
  if (!headerValue) return false;

  const candidates = headerValue.split(',').map((part) => part.trim());
  if (candidates.includes('*')) return true;

  const normalise = (tag: string): string =>
    tag.startsWith('W/') ? tag.slice(2) : tag;

  return candidates.some(
    (candidate) => normalise(candidate) === normalise(etag),
  );
}

/**
 * Sends `body` as a cacheable JSON response, or a 304 if the caller has it.
 *
 * `public` is deliberate and is safe *here and nowhere else in this repo*. The
 * catalogue response is byte-identical for every caller — it carries no
 * principal, no PHI and nothing derived from the token — so a shared cache
 * holding one copy cannot leak one person's data to another. RFC 9111 §3.5
 * requires exactly this directive before a shared cache may store a response
 * to a request that carried an `Authorization` header, which is why it is
 * spelled out rather than left to default. On enrolment, records or care-team
 * the same header would be a disclosure.
 */
export function sendCacheable(req: Request, res: Response, body: unknown): void {
  const serialised = JSON.stringify(body);
  const etag = etagOf(serialised);

  res.setHeader('ETag', etag);
  res.setHeader(
    'Cache-Control',
    `public, max-age=${MAX_AGE_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
  );
  // Content negotiation is limited to encoding. Notably *not* `Authorization`:
  // varying on it would defeat the shared cache for no benefit, since the body
  // does not depend on who asked.
  res.setHeader('Vary', 'Accept-Encoding');

  if (matchesIfNoneMatch(req.header('if-none-match'), etag)) {
    // 304 carries no body by definition, and `res.end()` rather than
    // `res.json()` keeps Express from setting a Content-Length that describes
    // a body which is not there.
    res.status(304).end();
    return;
  }

  res.status(200).type('application/json').send(serialised);
}
