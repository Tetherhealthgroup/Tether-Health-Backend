import { z } from 'zod';

/**
 * The waitlist payload, validated as leniently as it can be while still being
 * worth storing.
 *
 * The contract is not ours to choose. `WaitlistForm.astro` is deployed on a
 * static site, and its script does this:
 *
 *     const response = await fetch(endpoint, { … body: JSON.stringify(payload) });
 *     if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *     … catch (error) { window.location.href = waitlistMailtoUrl(…) }
 *
 * Any non-2xx drops the visitor into their mail client. That is a decent
 * fallback in the abstract and a silent failure in practice: on a phone with no
 * mail account configured, `mailto:` opens nothing at all, and the person has
 * just watched a success message appear over a submission that went nowhere.
 * So a 400 from this endpoint costs a real enquiry, and the schema is written
 * with that price in mind.
 *
 * Three rules follow from it:
 *
 *   1. **Truncate, never reject, on length.** A 40 KB message is somebody who
 *      had a lot to say, not an attack — and the body limit in `@tether/core`
 *      has already refused anything genuinely large before this runs.
 *   2. **Unknown keys pass through and are ignored.** Not `.strict()`. The site
 *      can add a field and deploy on its own schedule; a new `<input>` should
 *      not take the endpoint down until this repo catches up.
 *   3. **Only one field can fail**, and only when the enquiry would be useless
 *      without it. See `email` below.
 *
 * The field names below are `{name, email, role, interest, message}`, read off
 * `normalizeWaitlistPayload` in `project/src/lib/waitlist.ts` rather than
 * guessed. `role` and `interest` arrive as whole English sentences from two
 * `<select>` elements ("Clinician or care-team member"), so they are free text
 * here and not an enum — the site owns that list and changes it without asking.
 */

/** Generous ceilings. Anything longer is truncated, never refused. */
const LIMITS = {
  name: 200,
  email: 320, // RFC 5321's maximum path length. Longer is not an address.
  role: 200,
  interest: 200,
  message: 8_000,
} as const;

/**
 * Trim, coerce, truncate. Missing and null both become the empty string.
 *
 * `String(value)` rather than a type error: a client that sends `interest: 3`
 * meant something by it, and "3" in a free-text column is more useful to the
 * person reading the enquiry than a rejection the visitor never sees.
 */
function looseText(max: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return '';
    const text = typeof value === 'string' ? value : String(value);
    return text.trim().slice(0, max);
  }, z.string());
}

/**
 * The one field that can fail validation.
 *
 * Deliberately weaker than the HTML-spec regular expression the form itself
 * applies in `isReplyableEmail`. The form has already refused anything that
 * fails that test, so a request arriving here with a strange address is either
 * a non-browser client or a case the site's own check let through — and
 * disagreeing with the client about what an address looks like would mean
 * throwing away enquiries the visitor was told had been accepted.
 *
 * What is still checked is the part that makes the enquiry pointless: an empty
 * local part, an empty domain, whitespace, or no `@` at all. The endpoint
 * exists so somebody can be replied to. An address nothing can be sent to is
 * the only input worth the cost of a 400.
 */
const replyableEmail = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().slice(0, LIMITS.email) : value),
  z
    .string()
    .min(3)
    .max(LIMITS.email)
    .regex(
      /^[^\s@]+@[^\s@]+$/,
      'We need an address we can reply to — something like you@example.com.',
    ),
);

export const waitlistEnquirySchema = z.object({
  name: looseText(LIMITS.name),
  email: replyableEmail,
  role: looseText(LIMITS.role),
  interest: looseText(LIMITS.interest),
  message: looseText(LIMITS.message),
});

export type WaitlistEnquiry = z.infer<typeof waitlistEnquirySchema>;

/**
 * `:id` is a uuid or it is nothing.
 *
 * Checked in the route rather than left to Postgres: an unparseable uuid
 * reaching the query is a `22P02` from the driver, which surfaces as a 500 and
 * pages somebody about a typo.
 */
export const uuidParam = z
  .string()
  .uuid('That is not a waitlist enquiry identifier.');
