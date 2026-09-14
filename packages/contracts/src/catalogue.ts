import { z } from 'zod';
import {
  InstantSchema,
  JsonObjectSchema,
  LocaleSchema,
  ProvenanceSchema,
  ScreenIdSchema,
  SlugSchema,
} from './primitives.ts';

/**
 * The design bundle, as it crosses the wire.
 *
 * These mirror `db/migrations/0002_catalogue.sql` one column at a time, in
 * camelCase, because the Flutter client reads them and the SQL is the thing
 * that is hard to change. Where the two disagree the migration wins and this
 * file is wrong.
 *
 * Nothing here is PHI. The whole file is cacheable, and the catalogue service
 * serves it from `withoutPrincipal` for exactly that reason.
 */

// ---------------------------------------------------------------------------
// Area and its parts
// ---------------------------------------------------------------------------

/**
 * How far an area has actually got.
 *
 * Distinct from `publishedOnSite`, and deliberately so. The website publishes
 * ten areas; `areas.json` ships eleven and links to `/programs/digital/`, which
 * 404s. `areas.json` says of the eleventh: "It may belong as a service line
 * under Mental & behavioral health instead — that is a strategy decision, not a
 * data one." Folding the two facts into one enum would make this API take that
 * decision on the product's behalf.
 */
export const AreaStatusSchema = z.enum(['in_development', 'design', 'planned']);
export type AreaStatus = z.infer<typeof AreaStatusSchema>;

export const ServiceLineSchema = z.object({
  id: SlugSchema,
  areaId: SlugSchema,
  name: z.string(),
  description: z.string(),

  /**
   * False where the service line is real work that never becomes a consumer
   * screen. `shell.json`'s `not_every_area_ships` names the three:
   * kidney monitoring result interpretation, cancer treatment material, and
   * behavioural screening administration — "These belong on a care-team
   * surface with a clinician in the loop." A client that renders every service
   * line as a tappable row would be promising three things the product has
   * decided not to ship to a patient unaccompanied.
   */
  consumerFacing: z.boolean(),

  position: z.number().int().nonnegative(),
});
export type ServiceLine = z.infer<typeof ServiceLineSchema>;

export const MeasureSchema = z.object({
  /**
   * Area-namespaced (`cardiovascular.blood_pressure`), not bare.
   *
   * `catalogue.measure.id` is a global primary key while `area_id` is NOT
   * NULL, and four areas declare `activity_minutes` while two declare
   * `screen_minutes` and `app_opens`. A bare id therefore cannot represent the
   * bundle: three of the four areas would lose the measure. The bare name
   * survives in `aliases`, which is what the GIN index on that column is for.
   */
  id: SlugSchema,
  areaId: SlugSchema,
  label: z.string(),
  unit: z.string(),

  /** Drives the disclaimer the check-in screens must carry (`self_report_only`). */
  selfReported: z.boolean(),
  derived: z.boolean(),
  estimate: z.boolean(),

  /**
   * Drives `threshold_areas_separable`: "Regulatory classification follows the
   * riskiest feature in the binary." A client that ships a thresholded measure
   * without the feature flag drags the whole app toward medical-device
   * territory, so the flag has to reach it.
   */
  clinicalThresholds: z.boolean(),

  /** `never_diagnose`: a score is a prompt to seek help, never a condition. */
  neverDiagnostic: z.boolean(),

  /**
   * iOS returns aggregate screen time where Android returns per-app, so the
   * same measure means different things depending on where it came from. A
   * screen reading this must degrade rather than render a plausible zero.
   */
  platformDependent: z.boolean(),

  /**
   * Other names for the same quantity. chronic-care calls a craving
   * `cravings_level` where Tether-Health calls it `craving_intensity`; the two
   * resolve to one measure rather than to two silently different numbers.
   */
  aliases: z.array(z.string()),
});
export type Measure = z.infer<typeof MeasureSchema>;

export const AreaSchema = z.object({
  id: SlugSchema,
  name: z.string(),
  scope: z.string(),
  status: AreaStatusSchema,
  siteUrl: z.string().url().nullable(),

  /** See [AreaStatusSchema] — ten of the eleven, and the eleventh is `digital`. */
  publishedOnSite: z.boolean(),

  /**
   * Null for the nine areas that are a plan rather than an implementation.
   * `POST /enrolments` refuses those with `area-not-implemented` rather than
   * accepting a join it cannot honour.
   */
  productId: SlugSchema.nullable(),

  position: z.number().int().nonnegative(),
  serviceLines: z.array(ServiceLineSchema),
  measures: z.array(MeasureSchema),

  /** Ids into `GET /safeguards`. The constraints this area ships under. */
  safeguardIds: z.array(SlugSchema),
});
export type Area = z.infer<typeof AreaSchema>;

// ---------------------------------------------------------------------------
// Safeguards and shell rules
// ---------------------------------------------------------------------------

export const SafeguardSchema = z.object({
  id: SlugSchema,
  name: z.string(),
  statement: z.string(),

  /** Capabilities a screen under this safeguard must have. */
  requires: z.array(z.string()),

  /** Capabilities it must not have. `safeguards.json`: constraints, not features. */
  forbids: z.array(z.string()),

  /** `sensitive_notifications_off` is the only one today. */
  defaultOff: z.boolean(),
});
export type Safeguard = z.infer<typeof SafeguardSchema>;

export const ShellRuleSchema = z.object({
  id: SlugSchema,
  rule: z.string(),

  /**
   * Carried to the client because the client renders it. The join screen quotes
   * "Three concurrent behaviour changes is where adherence collapses" rather
   * than simply refusing — a rule without its reason reads as an arbitrary
   * limit, and an arbitrary limit is the kind people work around.
   */
  why: z.string(),

  examples: z.array(z.string()),
});
export type ShellRule = z.infer<typeof ShellRuleSchema>;

// ---------------------------------------------------------------------------
// Archetypes, products, screens, content
// ---------------------------------------------------------------------------

export const ArchetypeSchema = z.object({
  id: SlugSchema,
  name: z.string(),
  purpose: z.string(),
  chrome: JsonObjectSchema,
  slots: JsonObjectSchema,
  actions: z.array(JsonObjectSchema),
  requires: z.array(z.string()),
  notes: z.string().nullable(),

  /** See [ProvenanceSchema]. Never omit this: the banner depends on it. */
  provenance: ProvenanceSchema,
});
export type Archetype = z.infer<typeof ArchetypeSchema>;

export const ProductScreenSchema = z.object({
  productId: SlugSchema,
  screenId: ScreenIdSchema,
  archetypeId: SlugSchema,
  route: z.string(),
  phase: z.number().int().nonnegative(),

  /** One shell, built once, identical in every area — `shell.json`. */
  isShell: z.boolean(),

  /** Marked `$new` in the product file: proposed, not yet promoted. */
  isProposed: z.boolean(),

  /** The approved 1290 × 2796 artwork this screen was signed off as, if any. */
  approvedArtwork: z.number().int().positive().nullable(),
});
export type ProductScreen = z.infer<typeof ProductScreenSchema>;

export const ProductSchema = z.object({
  id: SlugSchema,
  name: z.string(),
  areaId: SlugSchema,
  status: z.string(),
  locales: z.array(LocaleSchema),

  /** Per-product wording: BreatheFree says "slip", LookUp says "going over". */
  vocabulary: JsonObjectSchema,

  helplines: z.array(JsonObjectSchema),

  /** Both current product names are flagged in the bundle as not trademark-cleared. */
  nameNote: z.string().nullable(),

  screens: z.array(ProductScreenSchema),
});
export type Product = z.infer<typeof ProductSchema>;

export const ScreenContentSchema = z.object({
  productId: SlugSchema,
  screenId: ScreenIdSchema,
  locale: LocaleSchema,

  /** The designer's slot content. Free-form by design — see [JsonObjectSchema]. */
  body: JsonObjectSchema,

  /**
   * `'supplement'` on the ten LookUp screens `content.lookup.en.json` does not
   * author. Those strings were written in the app repository and have not been
   * clinically reviewed, and the client shows a banner saying so. This field is
   * the only thing that makes that banner appear.
   */
  provenance: ProvenanceSchema,

  updatedAt: InstantSchema,
});
export type ScreenContent = z.infer<typeof ScreenContentSchema>;

// ---------------------------------------------------------------------------
// Request and response bodies
// ---------------------------------------------------------------------------

/** `GET /areas?status=` */
export const AreasQuerySchema = z
  .object({ status: AreaStatusSchema.optional() })
  .strip();
export type AreasQuery = z.infer<typeof AreasQuerySchema>;

export const AreasResponseSchema = z.object({ areas: z.array(AreaSchema) });
export type AreasResponse = z.infer<typeof AreasResponseSchema>;

export const AreaResponseSchema = AreaSchema;
export type AreaResponse = z.infer<typeof AreaResponseSchema>;

export const ArchetypesResponseSchema = z.object({
  archetypes: z.array(ArchetypeSchema),
});
export type ArchetypesResponse = z.infer<typeof ArchetypesResponseSchema>;

export const ArchetypeResponseSchema = ArchetypeSchema;
export type ArchetypeResponse = z.infer<typeof ArchetypeResponseSchema>;

export const SafeguardsResponseSchema = z.object({
  safeguards: z.array(SafeguardSchema),
});
export type SafeguardsResponse = z.infer<typeof SafeguardsResponseSchema>;

export const ShellRulesResponseSchema = z.object({
  rules: z.array(ShellRuleSchema),
});
export type ShellRulesResponse = z.infer<typeof ShellRulesResponseSchema>;

export const ProductResponseSchema = ProductSchema;
export type ProductResponse = z.infer<typeof ProductResponseSchema>;

/**
 * A content pack: every authored screen for one product and locale.
 *
 * An array rather than a map keyed by screen id, because a map's value would
 * be the body alone and the temptation to serialise it bare — losing
 * `provenance` — is exactly the failure this API is trying not to have.
 */
export const ContentPackResponseSchema = z.object({
  productId: SlugSchema,
  locale: LocaleSchema,
  screens: z.array(ScreenContentSchema),
});
export type ContentPackResponse = z.infer<typeof ContentPackResponseSchema>;

/** `GET /bundle?locale=en` */
export const BundleQuerySchema = z
  .object({ locale: LocaleSchema.default('en') })
  .strip();
export type BundleQuery = z.infer<typeof BundleQuerySchema>;

/**
 * Everything, in one response, for a cold client start.
 *
 * It exists because the alternative is eight round trips before the first
 * screen renders, on a device that may be on cellular in a clinic waiting
 * room. It is a single ETag, so a client that already has the bundle spends one
 * conditional request and no body at all.
 */
export const BundleResponseSchema = z.object({
  locale: LocaleSchema,

  /**
   * When the catalogue last changed — **not** when this response was built.
   *
   * A wall-clock timestamp here would be a correctness bug rather than an
   * inaccuracy: it would differ on every request, so the ETag computed over
   * the body would differ on every request, and the conditional request this
   * endpoint exists to support would never once return 304. Derived from the
   * newest `updated_at` in the catalogue instead, so it is stable exactly as
   * long as the data is.
   */
  catalogueUpdatedAt: InstantSchema,
  areas: z.array(AreaSchema),
  archetypes: z.array(ArchetypeSchema),
  safeguards: z.array(SafeguardSchema),
  shellRules: z.array(ShellRuleSchema),
  products: z.array(ProductSchema),
  content: z.array(ScreenContentSchema),
});
export type BundleResponse = z.infer<typeof BundleResponseSchema>;
