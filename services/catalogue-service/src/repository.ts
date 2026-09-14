import type { Transaction } from '@tether/core';
import type {
  Archetype,
  Area,
  AreaStatus,
  BundleResponse,
  JsonObject,
  Measure,
  Product,
  ProductScreen,
  Safeguard,
  ScreenContent,
  ServiceLine,
  ShellRule,
} from '@tether/contracts';

/**
 * Every query this service runs, and the row-to-contract mapping for each.
 *
 * Two things are deliberate about the way this file is written.
 *
 * **Columns are aliased to their wire names in SQL**, not renamed in
 * TypeScript. A mapper that builds an object field by field is a mapper that
 * can quietly stop copying a field, and the field most likely to be dropped —
 * because nothing visibly breaks when it is — is `provenance`. Aliasing in the
 * query means a dropped field is a missing column in a SELECT, which is the
 * kind of omission a reader spots.
 *
 * **The mappers are exported and pure.** They take a row and return a contract
 * object with no database in the way, so a test can assert that a `supplement`
 * row maps to a `supplement` payload without standing up Postgres. That
 * assertion is the whole safety net for the banner described below.
 */

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface AreaRow {
  id: string;
  name: string;
  scope: string;
  status: AreaStatus;
  siteUrl: string | null;
  publishedOnSite: boolean;
  productId: string | null;
  position: number;
}

interface ServiceLineRow extends ServiceLine {}
interface MeasureRow extends Measure {}
interface SafeguardRow extends Safeguard {}
interface ShellRuleRow extends ShellRule {}

interface AreaSafeguardRow {
  areaId: string;
  safeguardId: string;
}

interface ArchetypeRow {
  id: string;
  name: string;
  purpose: string;
  chrome: JsonObject;
  slots: JsonObject;
  actions: JsonObject[];
  requires: string[];
  notes: string | null;
  provenance: 'bundle' | 'supplement';
}

interface ProductRow {
  id: string;
  name: string;
  areaId: string;
  status: string;
  locales: string[];
  vocabulary: JsonObject;
  helplines: JsonObject[];
  nameNote: string | null;
}

interface ProductScreenRow extends ProductScreen {}

interface ScreenContentRow {
  productId: string;
  screenId: string;
  locale: string;
  body: JsonObject;
  provenance: 'bundle' | 'supplement';
  updatedAt: Date | string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * `timestamptz` as the contracts describe it.
 *
 * `pg` hands back a `Date` for a `timestamptz` and a string if anybody has
 * reconfigured the type parsers. Both are accepted so a parser change
 * elsewhere in the process cannot turn every `updatedAt` in the catalogue into
 * `"[object Object]"` without a test noticing.
 */
export function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toArea(
  row: AreaRow,
  serviceLines: readonly ServiceLine[],
  measures: readonly Measure[],
  safeguardIds: readonly string[],
): Area {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    status: row.status,
    siteUrl: row.siteUrl,
    publishedOnSite: row.publishedOnSite,
    productId: row.productId,
    position: row.position,
    serviceLines: [...serviceLines],
    measures: [...measures],
    safeguardIds: [...safeguardIds],
  };
}

/**
 * Maps an archetype row, `provenance` included.
 *
 * `provenance` is not metadata and must not be treated as optional detail.
 * `'supplement'` means the strings were written in the app repository and have
 * **not been clinically reviewed** — `supplement.archetypes.json` says so of
 * itself: "Every string here is unreviewed." The Flutter client renders a
 * visible NOT CLINICALLY REVIEWED banner on anything so marked, and it has no
 * other way to know. Drop this field from a response and the banner stops
 * appearing, silently, on content that is still unreviewed — the failure looks
 * like nothing at all until someone acts on unreviewed clinical copy.
 *
 * That is why it is carried here, in `toScreenContent`, in the bundle, and in
 * the contract schema, and why `test/provenance.test.ts` exists.
 */
export function toArchetype(row: ArchetypeRow): Archetype {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    chrome: row.chrome,
    slots: row.slots,
    actions: row.actions,
    requires: row.requires,
    notes: row.notes,
    provenance: row.provenance,
  };
}

/** Maps a content row. See [toArchetype] for why `provenance` is load-bearing. */
export function toScreenContent(row: ScreenContentRow): ScreenContent {
  return {
    productId: row.productId,
    screenId: row.screenId,
    locale: row.locale,
    body: row.body,
    provenance: row.provenance,
    updatedAt: instant(row.updatedAt),
  };
}

export function toProduct(
  row: ProductRow,
  screens: readonly ProductScreen[],
): Product {
  return {
    id: row.id,
    name: row.name,
    areaId: row.areaId,
    status: row.status,
    locales: row.locales,
    vocabulary: row.vocabulary,
    helplines: row.helplines,
    nameNote: row.nameNote,
    screens: [...screens],
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const AREA_COLUMNS = `
  a.id,
  a.name,
  a.scope,
  a.status,
  a.site_url          AS "siteUrl",
  a.published_on_site AS "publishedOnSite",
  a.product_id        AS "productId",
  a.position
`;

export interface AreaFilter {
  /** `GET /areas?status=` — one of the three stages an area can be at. */
  readonly status?: AreaStatus | undefined;
  /** Restricts to a single area, for `GET /areas/:areaId`. */
  readonly areaId?: string | undefined;
}

/**
 * Areas with their service lines, measures and safeguard ids.
 *
 * Four queries and a stitch rather than one query with three lateral
 * `json_agg`s. The catalogue is eleven areas: the round trips are free, and the
 * flat version is a query a person can read, run by hand and reason about when
 * an area is missing from the app.
 */
export async function loadAreas(
  tx: Transaction,
  filter: AreaFilter = {},
): Promise<Area[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.status !== undefined) {
    params.push(filter.status);
    conditions.push(`a.status = $${params.length}`);
  }
  if (filter.areaId !== undefined) {
    params.push(filter.areaId);
    conditions.push(`a.id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const areas = await tx.query<AreaRow>(
    `SELECT ${AREA_COLUMNS} FROM catalogue.area a ${where} ORDER BY a.position`,
    params,
  );
  if (areas.length === 0) return [];

  const ids = areas.map((area) => area.id);

  const serviceLines = await tx.query<ServiceLineRow>(
    `SELECT id,
            area_id         AS "areaId",
            name,
            description,
            consumer_facing AS "consumerFacing",
            position
       FROM catalogue.service_line
      WHERE area_id = ANY($1)
      ORDER BY area_id, position`,
    [ids],
  );

  const measures = await tx.query<MeasureRow>(
    `SELECT id,
            area_id             AS "areaId",
            label,
            unit,
            self_reported       AS "selfReported",
            derived,
            estimate,
            clinical_thresholds AS "clinicalThresholds",
            never_diagnostic    AS "neverDiagnostic",
            platform_dependent  AS "platformDependent",
            aliases
       FROM catalogue.measure
      WHERE area_id = ANY($1)
      ORDER BY area_id, id`,
    [ids],
  );

  const links = await tx.query<AreaSafeguardRow>(
    `SELECT area_id AS "areaId", safeguard_id AS "safeguardId"
       FROM catalogue.area_safeguard
      WHERE area_id = ANY($1)
      ORDER BY area_id, safeguard_id`,
    [ids],
  );

  return areas.map((area) =>
    toArea(
      area,
      serviceLines.filter((line) => line.areaId === area.id),
      measures.filter((measure) => measure.areaId === area.id),
      links.filter((link) => link.areaId === area.id).map((link) => link.safeguardId),
    ),
  );
}

export async function loadArea(
  tx: Transaction,
  areaId: string,
): Promise<Area | null> {
  const [area] = await loadAreas(tx, { areaId });
  return area ?? null;
}

export async function loadArchetypes(tx: Transaction): Promise<Archetype[]> {
  const rows = await tx.query<ArchetypeRow>(
    `SELECT id, name, purpose, chrome, slots, actions, requires, notes, provenance
       FROM catalogue.archetype
      ORDER BY id`,
  );
  return rows.map(toArchetype);
}

export async function loadArchetype(
  tx: Transaction,
  archetypeId: string,
): Promise<Archetype | null> {
  const row = await tx.one<ArchetypeRow>(
    `SELECT id, name, purpose, chrome, slots, actions, requires, notes, provenance
       FROM catalogue.archetype
      WHERE id = $1`,
    [archetypeId],
  );
  return row ? toArchetype(row) : null;
}

export async function loadSafeguards(tx: Transaction): Promise<Safeguard[]> {
  return tx.query<SafeguardRow>(
    `SELECT id, name, statement, requires, forbids, default_off AS "defaultOff"
       FROM catalogue.safeguard
      ORDER BY id`,
  );
}

export async function loadShellRules(tx: Transaction): Promise<ShellRule[]> {
  return tx.query<ShellRuleRow>(
    `SELECT id, rule, why, examples FROM catalogue.shell_rule ORDER BY id`,
  );
}

const PRODUCT_COLUMNS = `
  id,
  name,
  area_id   AS "areaId",
  status,
  locales,
  vocabulary,
  helplines,
  name_note AS "nameNote"
`;

/**
 * Screens ordered by phase then id.
 *
 * Phase is the designer's ordering — onboarding, plan, daily, rescue — and the
 * prototype tooling walks it in that order. Sorting by screen id alone would
 * interleave LookUp's shell screens (`SH1`…) with its product screens, which
 * reads as a flow nobody designed.
 */
const SCREEN_COLUMNS = `
  product_id       AS "productId",
  screen_id        AS "screenId",
  archetype_id     AS "archetypeId",
  route,
  phase,
  is_shell         AS "isShell",
  is_proposed      AS "isProposed",
  approved_artwork AS "approvedArtwork"
`;

export async function loadProduct(
  tx: Transaction,
  productId: string,
): Promise<Product | null> {
  const row = await tx.one<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM catalogue.product WHERE id = $1`,
    [productId],
  );
  if (!row) return null;

  const screens = await tx.query<ProductScreenRow>(
    `SELECT ${SCREEN_COLUMNS}
       FROM catalogue.product_screen
      WHERE product_id = $1
      ORDER BY phase, screen_id`,
    [productId],
  );

  return toProduct(row, screens);
}

export async function loadProducts(tx: Transaction): Promise<Product[]> {
  const rows = await tx.query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM catalogue.product ORDER BY id`,
  );
  if (rows.length === 0) return [];

  const screens = await tx.query<ProductScreenRow>(
    `SELECT ${SCREEN_COLUMNS} FROM catalogue.product_screen ORDER BY product_id, phase, screen_id`,
  );

  return rows.map((row) =>
    toProduct(
      row,
      screens.filter((screen) => screen.productId === row.id),
    ),
  );
}

const CONTENT_COLUMNS = `
  product_id AS "productId",
  screen_id  AS "screenId",
  locale,
  body,
  provenance,
  updated_at AS "updatedAt"
`;

/**
 * One product's content pack, supplement screens included.
 *
 * Supplement rows are returned alongside bundle rows rather than behind a flag,
 * because the ten LookUp screens `content.lookup.en.json` does not author are
 * not optional extras — without them the product has ten blank screens. What
 * distinguishes them is `provenance`, which each row carries, and which the
 * client turns into the NOT CLINICALLY REVIEWED banner.
 */
export async function loadContentPack(
  tx: Transaction,
  productId: string,
  locale: string,
): Promise<ScreenContent[]> {
  const rows = await tx.query<ScreenContentRow>(
    `SELECT ${CONTENT_COLUMNS}
       FROM catalogue.screen_content
      WHERE product_id = $1 AND locale = $2
      ORDER BY screen_id`,
    [productId, locale],
  );
  return rows.map(toScreenContent);
}

export async function loadAllContent(
  tx: Transaction,
  locale: string,
): Promise<ScreenContent[]> {
  const rows = await tx.query<ScreenContentRow>(
    `SELECT ${CONTENT_COLUMNS}
       FROM catalogue.screen_content
      WHERE locale = $1
      ORDER BY product_id, screen_id`,
    [locale],
  );
  return rows.map(toScreenContent);
}

/**
 * When the catalogue last changed.
 *
 * `area` and `screen_content` are the only two catalogue tables carrying
 * `updated_at`, and between them they cover the two edits that actually happen:
 * an area moving from `planned` to `in_development`, and a screen's copy being
 * revised. The epoch fallback is for a database that has never been seeded —
 * returning `null` would force every caller of the bundle to handle a case that
 * only exists before first use.
 */
async function catalogueUpdatedAt(tx: Transaction): Promise<string> {
  const row = await tx.one<{ at: Date | string | null }>(
    `SELECT greatest(
              (SELECT max(updated_at) FROM catalogue.area),
              (SELECT max(updated_at) FROM catalogue.screen_content)
            ) AS at`,
  );
  return row?.at ? instant(row.at) : new Date(0).toISOString();
}

/**
 * The whole catalogue in one read, for a cold client start.
 *
 * All of it inside a single transaction on purpose. Eight separate requests can
 * straddle a seeder run and leave a client holding areas from before a change
 * and content from after it — which, for a payload whose parts reference each
 * other by id, means dangling archetype ids and blank screens. One transaction
 * is one consistent snapshot, and one ETag over that snapshot is honest.
 */
export async function loadBundle(
  tx: Transaction,
  locale: string,
): Promise<BundleResponse> {
  const [updatedAt, areas, archetypes, safeguards, shellRules, products, content] =
    await Promise.all([
      catalogueUpdatedAt(tx),
      loadAreas(tx),
      loadArchetypes(tx),
      loadSafeguards(tx),
      loadShellRules(tx),
      loadProducts(tx),
      loadAllContent(tx, locale),
    ]);

  return {
    locale,
    catalogueUpdatedAt: updatedAt,
    areas,
    archetypes,
    safeguards,
    shellRules,
    products,
    content,
  };
}
