-- 0002 · Catalogue: the design bundle, as tables.
--
-- Today the Flutter app ships `areas.json`, `archetypes.json`, `safeguards.json`
-- and the product files as build-time assets, so moving an area from `planned`
-- to `in_development` needs an App Store release. These tables are the same data
-- with a deployment story.
--
-- Nothing here is PHI. It is world-readable to an authenticated client and
-- writable only by the catalogue service.

-- The health areas.
--
-- `status` and `published_on_site` are separate columns on purpose. The website
-- publishes ten areas; `areas.json` ships eleven and links to
-- `/programs/digital/`, which 404s. `areas.json` says of the eleventh: "It may
-- belong as a service line under Mental & behavioral health instead — that is a
-- strategy decision, not a data one." Folding the two facts into one column
-- would force that decision here, in a migration, which is the wrong place for
-- it. Kept apart, the discrepancy is queryable and the fix is an UPDATE.
CREATE TABLE catalogue.area (
  id                text PRIMARY KEY,              -- 'tobacco', 'digital', …
  name              text NOT NULL,
  scope             text NOT NULL,
  status            text NOT NULL
                      CHECK (status IN ('in_development','design','planned')),
  site_url          text,
  published_on_site boolean NOT NULL DEFAULT false,
  product_id        text,                          -- FK added after product exists
  position          smallint NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER area_updated_at BEFORE UPDATE ON catalogue.area
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE catalogue.service_line (
  id          text PRIMARY KEY,                    -- 'tobacco.cessation'
  area_id     text NOT NULL REFERENCES catalogue.area(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL,

  -- `not_every_area_ships`: "Some service lines never become consumer screens…
  -- These belong on a care-team surface with a clinician in the loop."
  -- Named examples: kidney monitoring result interpretation, cancer treatment
  -- material, behavioural screening administration.
  consumer_facing boolean NOT NULL DEFAULT true,

  position    smallint NOT NULL
);

CREATE INDEX service_line_area ON catalogue.service_line(area_id);

-- What an area measures, with the flags that decide how it may be shown.
--
-- These are not metadata. `clinical_thresholds` drives `threshold_areas_separable`
-- ("Regulatory classification follows the riskiest feature in the binary");
-- `self_reported` drives the disclaimer the check-in screens must carry; and
-- `platform_dependent` exists because iOS returns aggregate screen time only, so
-- a per-app number has to degrade rather than render a plausible zero.
CREATE TABLE catalogue.measure (
  id                  text PRIMARY KEY,
  area_id             text NOT NULL REFERENCES catalogue.area(id) ON DELETE CASCADE,
  label               text NOT NULL,
  unit                text NOT NULL,
  self_reported       boolean NOT NULL DEFAULT false,
  derived             boolean NOT NULL DEFAULT false,
  estimate            boolean NOT NULL DEFAULT false,
  clinical_thresholds boolean NOT NULL DEFAULT false,
  never_diagnostic    boolean NOT NULL DEFAULT false,
  platform_dependent  boolean NOT NULL DEFAULT false,

  -- Reconciles the two apps' vocabularies. chronic-care calls a craving
  -- `cravings_level`; Tether-Health calls it `craving_intensity`. chronic-care
  -- stores blood pressure as two rows (`systolic_bp`, `diastolic_bp`);
  -- Tether-Health stores one with unit `mmhg_pair`. Until that is settled,
  -- both names resolve to one measure rather than to two silently different
  -- quantities.
  aliases             text[] NOT NULL DEFAULT '{}'
);

CREATE INDEX measure_area    ON catalogue.measure(area_id);
CREATE INDEX measure_aliases ON catalogue.measure USING gin(aliases);

-- The twenty safeguards, and which capabilities they require or forbid.
CREATE TABLE catalogue.safeguard (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  statement   text NOT NULL,
  requires    text[] NOT NULL DEFAULT '{}',
  forbids     text[] NOT NULL DEFAULT '{}',
  default_off boolean NOT NULL DEFAULT false
);

CREATE TABLE catalogue.area_safeguard (
  area_id      text NOT NULL REFERENCES catalogue.area(id) ON DELETE CASCADE,
  safeguard_id text NOT NULL REFERENCES catalogue.safeguard(id) ON DELETE CASCADE,
  PRIMARY KEY (area_id, safeguard_id)
);

-- The shell rules, carried as data so a client can show the reasoning.
--
-- `why` is a column because the app renders it: the join screen quotes "Three
-- concurrent behaviour changes is where adherence collapses" rather than simply
-- refusing. A rule without its reason reads as an arbitrary limit.
CREATE TABLE catalogue.shell_rule (
  id       text PRIMARY KEY,
  rule     text NOT NULL,
  why      text NOT NULL,
  examples text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE catalogue.archetype (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  purpose  text NOT NULL,
  chrome   jsonb NOT NULL DEFAULT '{}'::jsonb,
  slots    jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires text[] NOT NULL DEFAULT '{}',
  notes    text,

  -- 'bundle' shipped in tether-design.zip; 'supplement' was written in the app
  -- repository and has not been clinically reviewed. The Flutter client renders
  -- a visible notice on anything marked supplement, and it can only do that if
  -- the provenance survives the trip through the database.
  provenance text NOT NULL DEFAULT 'bundle'
               CHECK (provenance IN ('bundle','supplement'))
);

CREATE TABLE catalogue.product (
  id            text PRIMARY KEY,                  -- 'breathefree', 'lookup'
  name          text NOT NULL,
  area_id       text NOT NULL REFERENCES catalogue.area(id),
  status        text NOT NULL,
  locales       text[] NOT NULL DEFAULT '{en}',
  vocabulary    jsonb NOT NULL DEFAULT '{}'::jsonb,
  helplines     jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Both current names are flagged in the bundle as not trademark-cleared.
  name_note     text
);

ALTER TABLE catalogue.area
  ADD CONSTRAINT area_product_fk
  FOREIGN KEY (product_id) REFERENCES catalogue.product(id);

CREATE TABLE catalogue.product_screen (
  product_id   text NOT NULL REFERENCES catalogue.product(id) ON DELETE CASCADE,
  screen_id    text NOT NULL,                      -- 'S01' … 'SH6'
  archetype_id text NOT NULL REFERENCES catalogue.archetype(id),
  route        text NOT NULL,
  phase        smallint NOT NULL DEFAULT 0,
  is_shell     boolean NOT NULL DEFAULT false,
  is_proposed  boolean NOT NULL DEFAULT false,

  -- The approved 1290 × 2796 artwork this screen was signed off as, where there
  -- is one. BreatheFree's S05 is screen 5. Null for everything else.
  approved_artwork smallint,

  PRIMARY KEY (product_id, screen_id)
);

CREATE TABLE catalogue.screen_content (
  product_id text NOT NULL,
  screen_id  text NOT NULL,
  locale     text NOT NULL,
  body       jsonb NOT NULL,
  provenance text NOT NULL DEFAULT 'bundle'
               CHECK (provenance IN ('bundle','supplement')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, screen_id, locale),
  FOREIGN KEY (product_id, screen_id)
    REFERENCES catalogue.product_screen(product_id, screen_id) ON DELETE CASCADE
);
