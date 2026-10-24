import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createDatabase,
  createLogger,
  type Database,
  type Logger,
  type Transaction,
} from '@tether/core';

/**
 * Seeds `catalogue.*` from the design bundle that ships in the Flutter repo.
 *
 * Today `Tether-Health` carries `areas.json`, `archetypes.json`,
 * `safeguards.json`, `shell.json` and the product files as build-time assets,
 * so moving an area from `planned` to `in_development` needs an App Store
 * release. This script is the other half of fixing that: the tables in `0002`
 * are the same data, and this is what puts it there.
 *
 * It is idempotent. Running it twice produces the same rows, and running it
 * after a bundle edit converges the database on the bundle rather than
 * accumulating both versions — see [pruneMissing] for where that stops, and
 * why.
 *
 *     DATABASE_URL=… node db/seeds/catalogue.ts
 *     CATALOGUE_SOURCE_DIR=/path/to/assets/design node db/seeds/catalogue.ts
 */

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),

  /**
   * Where the bundle lives.
   *
   * Required, with no default. The bundle is a Flutter asset directory, not a
   * published package, and a default pointing at one engineer's home directory
   * is not a deployment strategy. Set it to the `assets/design` directory of
   * the app repo checkout.
   */
  CATALOGUE_SOURCE_DIR: z
    .string({ required_error: 'CATALOGUE_SOURCE_DIR is required: the path to the Flutter repo\'s assets/design directory.' })
    .min(1, 'CATALOGUE_SOURCE_DIR must not be empty.'),

  LOG_LEVEL: z.string().default('info'),
});

// ---------------------------------------------------------------------------
// The bundle, as it is shaped on disk
// ---------------------------------------------------------------------------

interface SourceServiceLine {
  id: string;
  name: string;
  description: string;
  proposed?: boolean;
}

interface SourceMeasure {
  id: string;
  label: string;
  unit: string;
  selfReported?: boolean;
  derived?: boolean;
  estimate?: boolean;
  clinicalThresholds?: boolean;
  neverDiagnostic?: boolean;
  platformDependent?: boolean;
}

interface SourceArea {
  id: string;
  name: string;
  scope: string;
  status: string;
  url?: string | null;
  productId?: string | null;
  serviceLines?: SourceServiceLine[];
  measures?: SourceMeasure[];
  safeguards?: string[];
}

interface SourceSafeguard {
  id: string;
  name: string;
  statement: string;
  requires?: string[];
  forbids?: string[];
  defaultOff?: boolean;
}

interface SourceShellRule {
  id: string;
  rule: string;
  why: string;
  examples?: string[];
}

interface SourceArchetype {
  id: string;
  name: string;
  purpose: string;
  chrome?: Record<string, unknown>;
  slots?: Record<string, unknown>;
  actions?: Record<string, unknown>[];
  requires?: string[];
  notes?: string | null;
}

interface SourceScreen {
  id: string;
  archetype: string;
  route: string;
  phase?: number;
  $new?: boolean;
  $shell?: boolean;
}

interface SourceProduct {
  id: string;
  name: string;
  $nameNote?: string;
  areaId: string;
  status: string;
  locales?: string[];
  vocabulary?: Record<string, unknown>;
  helplines?: Record<string, unknown>[];
  screens: SourceScreen[];
  proposedArchetypes?: { id: string; reason: string }[];
}

interface SourceContentPack {
  product: string;
  locale: string;
  screens: Record<string, Record<string, unknown>>;
}

interface SourceNavigationFix {
  product: string;
  screen: string;
  action: number;
  from: string;
  to: string;
  why: string;
}

// ---------------------------------------------------------------------------
// Facts the bundle does not carry
// ---------------------------------------------------------------------------

/**
 * The ten areas `www.tetherhealthgroup.com` actually publishes.
 *
 * `digital` is the eleventh and is **not** on this list. `areas.json` ships it
 * and links to `/programs/digital/`, which 404s; `areas.json` says of it: "It
 * may belong as a service line under Mental & behavioral health instead — that
 * is a strategy decision, not a data one." `0002_catalogue.sql` therefore keeps
 * `published_on_site` apart from `status` so the discrepancy is queryable
 * rather than resolved here, in a seed script, by someone who is not the person
 * who gets to decide.
 *
 * Note the spelling. The website's URL is `/programs/kidney-liver/` and the
 * app's area id is `kidney_liver`. The ids below are the **app** spelling,
 * which is what `catalogue.area.id` holds; the site spelling appears only
 * inside `site_url`, carried through from the bundle's `url` field. Anything
 * matching one against the other has to convert, and the convention is that the
 * app spelling is canonical everywhere in this backend.
 */
const PUBLISHED_ON_SITE = new Set([
  'tobacco',
  'metabolic',
  'cancer',
  'cardiovascular',
  'nutrition',
  'respiratory',
  'kidney_liver',
  'behavioral',
  'preventive',
  'aging',
]);

/**
 * Cross-application names for the same quantity.
 *
 * Quoted from `0002_catalogue.sql`: "chronic-care calls a craving
 * `cravings_level`; Tether-Health calls it `craving_intensity`. chronic-care
 * stores blood pressure as two rows (`systolic_bp`, `diastolic_bp`);
 * Tether-Health stores one with unit `mmhg_pair`. Until that is settled, both
 * names resolve to one measure rather than to two silently different
 * quantities."
 *
 * Keyed by the Tether-Health measure id. These are the only two the migration
 * names, and nothing is invented beyond them — a wrong alias would merge two
 * measures that are not the same thing, which is worse than having none.
 */
const CROSS_APP_ALIASES: Record<string, readonly string[]> = {
  craving_intensity: ['cravings_level'],
  blood_pressure: ['systolic_bp', 'diastolic_bp'],
};

/**
 * The product whose screens have signed-off artwork, and how it maps.
 *
 * `0002_catalogue.sql`: "The approved 1290 × 2796 artwork this screen was
 * signed off as, where there is one. BreatheFree's S05 is screen 5. Null for
 * everything else." The mapping is the numeric suffix — `S05` is
 * `screen-05-trigger-map-iphone.png`, and the twenty-eight files in
 * `assets/screens/` are all 1290 × 2796, which is the size the comment names.
 * LookUp and the shell have none.
 *
 * This is the one inference in this file that is read from a sentence rather
 * than from data. If "null for everything else" was meant to exclude every
 * BreatheFree screen except S05, this over-populates the column — a wrong
 * artwork reference, not a wrong screen.
 */
const ARTWORK_PRODUCT = 'breathefree';

// ---------------------------------------------------------------------------
// Reading the bundle
// ---------------------------------------------------------------------------

function readJson<T>(directory: string, file: string): T {
  const path = join(directory, file);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (cause) {
    // A seed that half-ran against a missing file leaves a catalogue that is
    // neither the old bundle nor the new one, so this is fatal rather than
    // skipped.
    throw new Error(`Could not read ${path}: ${(cause as Error).message}`, {
      cause,
    });
  }
}

/** Files matching `product.<id>.json`, so a third product needs no edit here. */
function productFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => /^product\.[a-z0-9_]+\.json$/.test(name))
    .sort();
}

/**
 * Content packs, bundle and supplement, keyed by `<product>:<locale>`.
 *
 * Discovered by filename rather than listed, for the same reason as the
 * products: `content.breathefree.es.json` should be seeded by dropping it in
 * the directory, not by editing this script and redeploying it.
 */
interface ContentFile {
  readonly file: string;
  readonly provenance: 'bundle' | 'supplement';
}

function contentFiles(directory: string): ContentFile[] {
  return readdirSync(directory)
    .filter((name) =>
      /^(supplement\.)?content\.[a-z0-9_]+\.[a-z]{2}(-[A-Z]{2})?\.json$/.test(name),
    )
    .sort()
    .map((file) => ({
      file,
      provenance: file.startsWith('supplement.')
        ? ('supplement' as const)
        : ('bundle' as const),
    }));
}

/**
 * Service lines that never become a consumer screen.
 *
 * Derived from `shell.json`'s own `not_every_area_ships` examples rather than
 * hard-coded, because the rule and its examples are the authority: "Some
 * service lines never become consumer screens… These belong on a care-team
 * surface with a clinician in the loop." Each example reads
 * `<serviceLineId> <what about it>`, so the id is the leading token.
 */
function nonConsumerServiceLines(rules: readonly SourceShellRule[]): Set<string> {
  const rule = rules.find((candidate) => candidate.id === 'not_every_area_ships');
  const ids = (rule?.examples ?? []).map((example) => example.split(/\s+/)[0]);
  return new Set(ids.filter((id): id is string => Boolean(id)));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Deletes rows the bundle no longer contains.
 *
 * Without this the catalogue is the union of every bundle ever seeded: a screen
 * removed from a product keeps being served, and a client keeps rendering it.
 * `keep` is the list of surviving keys; an empty `keep` deletes nothing, which
 * is the safe reading of "the source had none" — a source directory that failed
 * to parse must not be able to empty a table.
 */
async function pruneMissing(
  tx: Transaction,
  logger: Logger,
  spec: {
    readonly table: string;
    readonly keyExpression: string;
    readonly keep: readonly string[];
    /** Extra SQL that must hold before a row may be deleted. Binds from `$2`. */
    readonly guard?: string;
    readonly guardParams?: readonly unknown[];
  },
): Promise<void> {
  if (spec.keep.length === 0) return;

  const guard = spec.guard ? ` AND ${spec.guard}` : '';
  const removed = await tx.query<{ key: string }>(
    `DELETE FROM ${spec.table}
      WHERE ${spec.keyExpression} <> ALL($1::text[])${guard}
      RETURNING ${spec.keyExpression} AS key`,
    [spec.keep, ...(spec.guardParams ?? [])],
  );

  if (removed.length > 0) {
    logger.info(
      { table: spec.table, removed: removed.map((row) => row.key) },
      'removed rows the bundle no longer contains',
    );
  }
}

export interface SeedResult {
  readonly areas: number;
  readonly serviceLines: number;
  readonly measures: number;
  readonly safeguards: number;
  readonly shellRules: number;
  readonly archetypes: number;
  readonly products: number;
  readonly screens: number;
  readonly contentRows: number;
  /**
   * Archetypes a product references that the bundle never defines. Seeded as
   * placeholders — see the comment where they are built.
   */
  readonly undefinedArchetypes: readonly string[];
  /** Navigation fixes from `supplement.navigation.json` that were applied. */
  readonly navigationFixes: readonly string[];
}

export async function seedCatalogue(
  db: Database,
  sourceDir: string,
  logger: Logger,
): Promise<SeedResult> {
  const areasFile = readJson<{ areas: SourceArea[] }>(sourceDir, 'areas.json');
  const safeguardsFile = readJson<{ safeguards: SourceSafeguard[] }>(
    sourceDir,
    'safeguards.json',
  );
  const shellFile = readJson<{ rules: SourceShellRule[] }>(sourceDir, 'shell.json');

  const bundleArchetypes = readJson<{ archetypes: SourceArchetype[] }>(
    sourceDir,
    'archetypes.json',
  ).archetypes;
  const supplementArchetypes = readJson<{ archetypes: SourceArchetype[] }>(
    sourceDir,
    'supplement.archetypes.json',
  ).archetypes;

  const products = productFiles(sourceDir).map((file) =>
    readJson<SourceProduct>(sourceDir, file),
  );

  const contentPacks = contentFiles(sourceDir).map((entry) => ({
    ...entry,
    pack: readJson<SourceContentPack>(sourceDir, entry.file),
  }));

  const navigation = readJson<{ fixes: SourceNavigationFix[] }>(
    sourceDir,
    'supplement.navigation.json',
  );

  const nonConsumer = nonConsumerServiceLines(shellFile.rules);

  /**
   * Archetypes a product screen names that nothing defines.
   *
   * `product.lookup.json` lists three `proposedArchetypes`; the app repository
   * supplied definitions for two of them in `supplement.archetypes.json` and
   * none for `intercept`, which screen S22 nevertheless uses and
   * `content.lookup.en.json` nevertheless authors copy for.
   * `product_screen.archetype_id` is a foreign key, so the seed cannot simply
   * skip it: dropping S22 would drop its content with it.
   *
   * A placeholder row is written instead, carrying the bundle's own stated
   * `reason` as its purpose — real authored text, not invented — with no slots
   * and no actions, and `provenance = 'supplement'` so the client banners it as
   * unreviewed. That is the honest representation of "this screen exists, and
   * nobody has designed it yet". The ids are returned so the caller can say so
   * out loud.
   */
  const definedArchetypeIds = new Set(
    [...bundleArchetypes, ...supplementArchetypes].map(
      (archetype) => archetype.id,
    ),
  );

  const placeholderArchetypes: SourceArchetype[] = [];
  for (const product of products) {
    for (const screen of product.screens) {
      if (definedArchetypeIds.has(screen.archetype)) continue;
      definedArchetypeIds.add(screen.archetype);

      const proposed = product.proposedArchetypes?.find(
        (candidate) => candidate.id === screen.archetype,
      );
      placeholderArchetypes.push({
        id: screen.archetype,
        name: screen.archetype,
        purpose:
          proposed?.reason ??
          `Referenced by ${product.id} ${screen.id}; no definition in the bundle.`,
        notes:
          'Placeholder. This archetype is referenced by a product screen and ' +
          'defined nowhere in the design bundle. Nothing here has been ' +
          'designed or clinically reviewed.',
      });
    }
  }

  return db.withoutPrincipal(async (tx) => {
    // -----------------------------------------------------------------------
    // Safeguards and shell rules — no dependencies.
    // -----------------------------------------------------------------------
    for (const safeguard of safeguardsFile.safeguards) {
      await tx.query(
        `INSERT INTO catalogue.safeguard (id, name, statement, requires, forbids, default_off)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name,
                statement = EXCLUDED.statement,
                requires = EXCLUDED.requires,
                forbids = EXCLUDED.forbids,
                default_off = EXCLUDED.default_off`,
        [
          safeguard.id,
          safeguard.name,
          safeguard.statement,
          safeguard.requires ?? [],
          safeguard.forbids ?? [],
          safeguard.defaultOff ?? false,
        ],
      );
    }

    for (const rule of shellFile.rules) {
      await tx.query(
        `INSERT INTO catalogue.shell_rule (id, rule, why, examples)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
            SET rule = EXCLUDED.rule,
                why = EXCLUDED.why,
                examples = EXCLUDED.examples`,
        [rule.id, rule.rule, rule.why, rule.examples ?? []],
      );
    }

    // -----------------------------------------------------------------------
    // Archetypes. Provenance is set from which file the row came out of, and
    // it is the only thing that will make the client's NOT CLINICALLY REVIEWED
    // banner appear — see `0002_catalogue.sql`.
    // -----------------------------------------------------------------------
    const archetypeSources: [SourceArchetype[], 'bundle' | 'supplement'][] = [
      [bundleArchetypes, 'bundle'],
      [supplementArchetypes, 'supplement'],
      [placeholderArchetypes, 'supplement'],
    ];

    for (const [list, provenance] of archetypeSources) {
      for (const archetype of list) {
        await tx.query(
          `INSERT INTO catalogue.archetype
             (id, name, purpose, chrome, slots, actions, requires, notes, provenance)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE
              SET name = EXCLUDED.name,
                  purpose = EXCLUDED.purpose,
                  chrome = EXCLUDED.chrome,
                  slots = EXCLUDED.slots,
                  actions = EXCLUDED.actions,
                  requires = EXCLUDED.requires,
                  notes = EXCLUDED.notes,
                  provenance = EXCLUDED.provenance`,
          [
            archetype.id,
            archetype.name,
            archetype.purpose,
            JSON.stringify(archetype.chrome ?? {}),
            JSON.stringify(archetype.slots ?? {}),
            JSON.stringify(archetype.actions ?? []),
            archetype.requires ?? [],
            archetype.notes ?? null,
            provenance,
          ],
        );
      }
    }

    // -----------------------------------------------------------------------
    // Areas. `product_id` is left null on this pass.
    //
    // `catalogue.area.product_id` references `catalogue.product`, and
    // `catalogue.product.area_id` references `catalogue.area` — a cycle that no
    // single ordering satisfies. The areas go in without their product, the
    // products go in, and a third pass links them.
    // -----------------------------------------------------------------------
    let position = 0;
    for (const area of areasFile.areas) {
      await tx.query(
        `INSERT INTO catalogue.area (id, name, scope, status, site_url, published_on_site, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name,
                scope = EXCLUDED.scope,
                status = EXCLUDED.status,
                site_url = EXCLUDED.site_url,
                published_on_site = EXCLUDED.published_on_site,
                position = EXCLUDED.position`,
        [
          area.id,
          area.name,
          area.scope,
          area.status,
          area.url ?? null,
          PUBLISHED_ON_SITE.has(area.id),
          position,
        ],
      );
      position += 1;
    }

    // -----------------------------------------------------------------------
    // Service lines, measures, and the area/safeguard links.
    // -----------------------------------------------------------------------
    const serviceLineIds: string[] = [];
    const measureIds: string[] = [];
    const safeguardLinks: string[] = [];

    for (const area of areasFile.areas) {
      let linePosition = 0;
      for (const line of area.serviceLines ?? []) {
        serviceLineIds.push(line.id);
        await tx.query(
          `INSERT INTO catalogue.service_line
             (id, area_id, name, description, consumer_facing, position)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE
              SET area_id = EXCLUDED.area_id,
                  name = EXCLUDED.name,
                  description = EXCLUDED.description,
                  consumer_facing = EXCLUDED.consumer_facing,
                  position = EXCLUDED.position`,
          [
            line.id,
            area.id,
            line.name,
            line.description,
            !nonConsumer.has(line.id),
            linePosition,
          ],
        );
        linePosition += 1;
      }

      for (const measure of area.measures ?? []) {
        /**
         * Area-namespaced, because `catalogue.measure.id` is a global primary
         * key and `area_id` is NOT NULL.
         *
         * Four areas declare `activity_minutes`; `screen_minutes`, `app_opens`
         * and `urge_intensity` each appear in two. A bare id can only belong to
         * one of them, so seeding bare ids would silently drop the measure from
         * every area but the last one written. The bare name survives in
         * `aliases`, which is what the GIN index on that column exists for, so
         * a lookup by the name the app actually sends still resolves.
         */
        const id = `${area.id}.${measure.id}`;
        measureIds.push(id);

        const aliases = [
          measure.id,
          ...(CROSS_APP_ALIASES[measure.id] ?? []),
        ];

        await tx.query(
          `INSERT INTO catalogue.measure
             (id, area_id, label, unit, self_reported, derived, estimate,
              clinical_thresholds, never_diagnostic, platform_dependent, aliases)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO UPDATE
              SET area_id = EXCLUDED.area_id,
                  label = EXCLUDED.label,
                  unit = EXCLUDED.unit,
                  self_reported = EXCLUDED.self_reported,
                  derived = EXCLUDED.derived,
                  estimate = EXCLUDED.estimate,
                  clinical_thresholds = EXCLUDED.clinical_thresholds,
                  never_diagnostic = EXCLUDED.never_diagnostic,
                  platform_dependent = EXCLUDED.platform_dependent,
                  aliases = EXCLUDED.aliases`,
          [
            id,
            area.id,
            measure.label,
            measure.unit,
            measure.selfReported ?? false,
            measure.derived ?? false,
            measure.estimate ?? false,
            measure.clinicalThresholds ?? false,
            measure.neverDiagnostic ?? false,
            measure.platformDependent ?? false,
            aliases,
          ],
        );
      }

      for (const safeguardId of area.safeguards ?? []) {
        safeguardLinks.push(`${area.id} ${safeguardId}`);
        await tx.query(
          `INSERT INTO catalogue.area_safeguard (area_id, safeguard_id)
           VALUES ($1, $2)
           ON CONFLICT (area_id, safeguard_id) DO NOTHING`,
          [area.id, safeguardId],
        );
      }
    }

    // -----------------------------------------------------------------------
    // Products, then the area → product link the cycle above deferred.
    // -----------------------------------------------------------------------
    for (const product of products) {
      await tx.query(
        `INSERT INTO catalogue.product
           (id, name, area_id, status, locales, vocabulary, helplines, name_note)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
         ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name,
                area_id = EXCLUDED.area_id,
                status = EXCLUDED.status,
                locales = EXCLUDED.locales,
                vocabulary = EXCLUDED.vocabulary,
                helplines = EXCLUDED.helplines,
                name_note = EXCLUDED.name_note`,
        [
          product.id,
          product.name,
          product.areaId,
          product.status,
          product.locales ?? ['en'],
          JSON.stringify(product.vocabulary ?? {}),
          JSON.stringify(product.helplines ?? []),
          // Only LookUp carries `$nameNote` in the bundle. BreatheFree's name
          // is flagged as un-cleared in the migration comment but not in the
          // data, and inventing the note here would put words in the bundle's
          // mouth.
          product.$nameNote ?? null,
        ],
      );
    }

    for (const area of areasFile.areas) {
      await tx.query(
        `UPDATE catalogue.area SET product_id = $2 WHERE id = $1`,
        [area.id, area.productId ?? null],
      );
    }

    // -----------------------------------------------------------------------
    // Product screens.
    // -----------------------------------------------------------------------
    const screenKeys: string[] = [];

    for (const product of products) {
      for (const screen of product.screens) {
        screenKeys.push(`${product.id} ${screen.id}`);

        const artwork =
          product.id === ARTWORK_PRODUCT ? artworkNumber(screen.id) : null;

        await tx.query(
          `INSERT INTO catalogue.product_screen
             (product_id, screen_id, archetype_id, route, phase, is_shell, is_proposed, approved_artwork)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (product_id, screen_id) DO UPDATE
              SET archetype_id = EXCLUDED.archetype_id,
                  route = EXCLUDED.route,
                  phase = EXCLUDED.phase,
                  is_shell = EXCLUDED.is_shell,
                  is_proposed = EXCLUDED.is_proposed,
                  approved_artwork = EXCLUDED.approved_artwork`,
          [
            product.id,
            screen.id,
            screen.archetype,
            screen.route,
            screen.phase ?? 0,
            screen.$shell ?? false,
            screen.$new ?? false,
            artwork,
          ],
        );
      }
    }

    // -----------------------------------------------------------------------
    // Content, with the navigation fixes applied.
    // -----------------------------------------------------------------------
    const appliedFixes: string[] = [];
    const contentKeys: string[] = [];
    let contentRows = 0;

    for (const { pack, provenance } of contentPacks) {
      for (const [screenId, body] of Object.entries(pack.screens)) {
        const fixed = applyNavigationFixes(
          navigation.fixes,
          pack.product,
          screenId,
          body,
          appliedFixes,
        );

        contentKeys.push(`${pack.product} ${screenId} ${pack.locale}`);
        contentRows += 1;

        await tx.query(
          `INSERT INTO catalogue.screen_content
             (product_id, screen_id, locale, body, provenance, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, now())
           ON CONFLICT (product_id, screen_id, locale) DO UPDATE
              SET body = EXCLUDED.body,
                  provenance = EXCLUDED.provenance,
                  -- Only when something actually changed. Touching it
                  -- unconditionally would move the bundle's catalogueUpdatedAt,
                  -- which every bundle ETag is derived from, on every seed run
                  -- -- and a re-seed that changed nothing would then invalidate
                  -- every client's cached copy of an identical catalogue.
                  updated_at = CASE
                    WHEN screen_content.body IS DISTINCT FROM EXCLUDED.body
                      OR screen_content.provenance IS DISTINCT FROM EXCLUDED.provenance
                    THEN now()
                    ELSE screen_content.updated_at
                  END`,
          [pack.product, screenId, pack.locale, JSON.stringify(fixed), provenance],
        );
      }
    }

    // -----------------------------------------------------------------------
    // Prune.
    //
    // `area` and `product` are deliberately absent from this list.
    // `programme.enrolment.area_id` references an area, so deleting one a
    // person has joined would either fail the whole seed or, with a cascade,
    // erase their programme. An orphaned area is visible and fixable; an
    // erased enrolment is not.
    // -----------------------------------------------------------------------
    await pruneMissing(tx, logger, {
      table: 'catalogue.service_line',
      keyExpression: 'id',
      keep: serviceLineIds,
    });

    await pruneMissing(tx, logger, {
      table: 'catalogue.measure',
      keyExpression: 'id',
      keep: measureIds,
      // `record.observation.measure_id` references a measure. A measure with
      // readings against it is retired by a migration that decides what happens
      // to the readings, not by a seed run.
      guard: `NOT EXISTS (
        SELECT 1 FROM record.observation o WHERE o.measure_id = measure.id
      )`,
    });

    await pruneMissing(tx, logger, {
      table: 'catalogue.area_safeguard',
      keyExpression: `area_id || chr(0) || safeguard_id`,
      keep: safeguardLinks,
    });

    await pruneMissing(tx, logger, {
      table: 'catalogue.product_screen',
      keyExpression: `product_id || chr(0) || screen_id`,
      keep: screenKeys,
    });

    await pruneMissing(tx, logger, {
      table: 'catalogue.screen_content',
      keyExpression: `product_id || chr(0) || screen_id || chr(0) || locale`,
      keep: contentKeys,
      // Scoped to the locales this run actually seeded, so seeding the English
      // pack does not delete a Spanish one that was loaded separately.
      guard: `locale = ANY($2::text[])`,
      guardParams: [[...new Set(contentPacks.map(({ pack }) => pack.locale))]],
    });

    await pruneMissing(tx, logger, {
      table: 'catalogue.safeguard',
      keyExpression: 'id',
      keep: safeguardsFile.safeguards.map((safeguard) => safeguard.id),
    });

    await pruneMissing(tx, logger, {
      table: 'catalogue.shell_rule',
      keyExpression: 'id',
      keep: shellFile.rules.map((rule) => rule.id),
    });

    await pruneMissing(tx, logger, {
      table: 'catalogue.archetype',
      keyExpression: 'id',
      keep: [...definedArchetypeIds],
      guard: `NOT EXISTS (
        SELECT 1 FROM catalogue.product_screen s WHERE s.archetype_id = archetype.id
      )`,
    });

    return {
      areas: areasFile.areas.length,
      serviceLines: serviceLineIds.length,
      measures: measureIds.length,
      safeguards: safeguardsFile.safeguards.length,
      shellRules: shellFile.rules.length,
      archetypes:
        bundleArchetypes.length +
        supplementArchetypes.length +
        placeholderArchetypes.length,
      products: products.length,
      screens: screenKeys.length,
      contentRows,
      undefinedArchetypes: placeholderArchetypes.map((archetype) => archetype.id),
      navigationFixes: appliedFixes,
    };
  });
}

/** `S05` → 5. Null for a shell screen or anything not of that shape. */
function artworkNumber(screenId: string): number | null {
  const match = /^S(\d{2})$/.exec(screenId);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Applies `supplement.navigation.json` to one screen's content.
 *
 * These change where a button goes, never what it says — the file is explicit
 * about that, and about why editing a shipped product file from the outside is
 * justified at all: "the file already contradicts its own machinery." The one
 * fix today is LookUp's S01, whose primary action skips S02 entirely, so a
 * person can never read what the product does before being asked to consent
 * to it.
 *
 * `provenance` is deliberately **not** downgraded to `supplement` for a fixed
 * screen. The banner means "these words have not been clinically reviewed", and
 * every word on S01 is still the reviewed bundle's. Marking it unreviewed
 * because a button's destination changed would put the banner on reviewed copy,
 * which makes the banner mean less everywhere it appears. The fix is reported
 * by the seed instead, so it is visible without being mislabelled.
 *
 * A fix whose `from` does not match what is actually there is skipped rather
 * than forced: that means the bundle has moved on, and silently overwriting the
 * newer target would undo a real edit.
 */
function applyNavigationFixes(
  fixes: readonly SourceNavigationFix[],
  productId: string,
  screenId: string,
  body: Record<string, unknown>,
  applied: string[],
): Record<string, unknown> {
  const relevant = fixes.filter(
    (fix) => fix.product === productId && fix.screen === screenId,
  );
  if (relevant.length === 0) return body;

  const actions = Array.isArray(body.actions)
    ? (body.actions as Record<string, unknown>[]).map((action) => ({ ...action }))
    : null;
  if (!actions) return body;

  for (const fix of relevant) {
    const action = actions[fix.action];
    if (!action || action.to !== fix.from) continue;
    action.to = fix.to;
    applied.push(`${productId}.${screenId}.actions[${fix.action}]: ${fix.from} → ${fix.to}`);
  }

  return { ...body, actions };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Configuration is not usable:\n${lines.join('\n')}`);
  }
  const config = parsed.data;

  const logger = createLogger({
    serviceName: 'catalogue-seed',
    level: config.LOG_LEVEL,
    environment: process.env.NODE_ENV ?? 'development',
    pretty: process.env.NODE_ENV !== 'production',
  });

  const db = createDatabase({
    connectionString: config.DATABASE_URL,
    max: 2,
    statementTimeoutMs: 60_000,
    applicationName: 'catalogue-seed',
    logger,
  });

  try {
    const result = await seedCatalogue(db, config.CATALOGUE_SOURCE_DIR, logger);
    logger.info({ source: config.CATALOGUE_SOURCE_DIR, ...result }, 'catalogue seeded');

    if (result.undefinedArchetypes.length > 0) {
      logger.warn(
        { archetypes: result.undefinedArchetypes },
        'product screens reference archetypes the bundle never defines; ' +
          'placeholders were written, marked supplement and unreviewed',
      );
    }
  } finally {
    await db.close();
  }
}
