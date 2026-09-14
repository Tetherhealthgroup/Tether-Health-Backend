import { z } from 'zod';

/**
 * The small shapes every other schema in this package is built from.
 *
 * They are here rather than inlined because each one encodes a decision the
 * database already made, and two copies of a decision drift. `areaId` matching
 * `catalogue.area.id` is not cosmetic: the app and the website spell the same
 * area differently (`kidney_liver` against `kidney-liver`), and the only reason
 * that is survivable is that exactly one spelling is ever accepted on the wire.
 */

/**
 * An area, product, archetype, safeguard, service line or measure identifier.
 *
 * Lower snake, with dots allowed because service lines are namespaced by area
 * (`tobacco.cessation`) and measures are namespaced the same way — see the
 * comment on `MeasureSchema` for why a measure cannot be a bare word.
 *
 * Bounded at 64 characters so a pathological id cannot be used to make an
 * error message, a log line or an index entry unbounded.
 */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/,
    'must be lower snake case, optionally dot-namespaced',
  );

/**
 * A screen id: `S01` … `S28` for product screens, `SH1` … `SH6` for the shell.
 *
 * Spelled out rather than left as a free string because the Flutter client's
 * original answer-collision bug was a screen id used as a key on its own. The
 * backend keys answers by `(enrolment_id, screen_id)` instead, and a screen id
 * that does not look like one is a sign the caller is still keying the old way.
 */
export const ScreenIdSchema = z
  .string()
  .regex(/^S(H[1-9]|\d{2})$/, 'must look like S01 or SH1');

/**
 * A BCP 47 language tag, restricted to the shapes the bundle actually ships.
 *
 * `product.locales` is `['en','es']` in both products today. Accepting an
 * arbitrary string here would let `GET /products/:id/content/:locale` be used
 * to probe for content that cannot exist.
 */
export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'must be a language tag such as en or es-MX');

/** A UUID as Postgres emits it. */
export const UuidSchema = z.string().uuid();

/** An instant, serialised the way `timestamptz` comes back through `pg`. */
export const InstantSchema = z.string().datetime({ offset: true });

/**
 * Arbitrary JSON carried through from the design bundle.
 *
 * `catalogue.archetype.chrome`, `.slots`, `.actions` and
 * `catalogue.screen_content.body` are `jsonb` on purpose: they are a designer's
 * vocabulary, not the backend's, and pinning their inner shape here would mean
 * a migration every time a slot is added to a screen. What the API *does*
 * guarantee about them is carried in `provenance`, not in their structure.
 */
export const JsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof JsonObjectSchema>;

/**
 * Where a piece of catalogue content came from, and therefore whether it has
 * been clinically reviewed.
 *
 * `'bundle'` shipped in `tether-design.zip` and was reviewed. `'supplement'`
 * was written in the app repository and was not — `supplement.archetypes.json`
 * says of itself "Every string here is unreviewed". The Flutter client renders
 * a visible NOT CLINICALLY REVIEWED banner on anything marked `supplement`, so
 * this field is load-bearing: drop it from a response and the banner silently
 * stops appearing on content that still has not been reviewed.
 */
export const ProvenanceSchema = z.enum(['bundle', 'supplement']);

export type Provenance = z.infer<typeof ProvenanceSchema>;
