-- 0007 · chronic-care's entities, in their own schema.
--
-- Separate from `record` on purpose. ARCHITECTURE.md's second open question:
-- whether chronic-care and Tether Health are one product is a strategy
-- decision, and the two share a legal entity, an Apple team and a smoking
-- cessation programme but no entities at all. Merging two schemas later is a
-- migration; un-merging one schema is not. Separate is the reversible choice,
-- so it is the default here.
--
-- ---------------------------------------------------------------------------
-- The bug this schema is shaped to make unrepresentable
-- ---------------------------------------------------------------------------
--
-- chronic-care already has a backend: a FastAPI service at
-- `chronic-care/backend/`. It has no tenancy isolation. Seventeen of its twenty
-- authenticated routes take a `user_id` from the token and never use it, and
-- the profile routes are the clearest case —
-- `src/chronic_care/api/routes.py:198`:
--
--   res = await session.execute(
--       select(Profile).order_by(Profile.created_at.asc()).limit(1))
--
-- `GET /profile` returns the oldest profile in the table to whoever asked, and
-- `PATCH /profile` at line 220 writes to the same row. That is not a missing
-- `WHERE` somebody forgot: its `profiles` table has no `user_id` column at all
-- (`models/profile.py`), so there was no column to filter on. The data model
-- made the bug the only thing the code could do.
--
-- Three things below close it, and all three are needed:
--
--   1. `chronic.profile.account_id` is NOT NULL and UNIQUE. A profile that
--      belongs to nobody cannot be inserted, so "the oldest row" is never a
--      meaningful thing to select.
--   2. Every other table reaches an account only through `profile_id`, so
--      there is no row in this schema that is not owned.
--   3. RLS is ENABLED and FORCED on all four tables, scoped through
--      `app_account_id()`. The `.limit(1)` query, ported here verbatim, would
--      return the caller's own profile or nothing — the failure mode becomes an
--      empty result rather than another patient's record.
--
-- The service layer uses `db.withPrincipal` for every route, which is what sets
-- `app.account_id`. Rule 3 is what makes forgetting rule 3 safe.

-- ---------------------------------------------------------------------------
-- chronic.profile
-- ---------------------------------------------------------------------------

CREATE TABLE chronic.profile (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NOT NULL and UNIQUE, and neither half is negotiable.
  --
  -- NOT NULL: the FastAPI `profiles` table has no owner column, which is
  -- precisely why `select(Profile).limit(1)` reads as working code there. An
  -- unowned row in this table would restore that: any query that failed to
  -- name an account would find it. Nullable ownership is the bug.
  --
  -- UNIQUE: one chronic-care profile per Tether account. The app presents a
  -- single "you", and a second profile for the same account would make
  -- `GET /profile` ambiguous — which is the same ordering-decides-the-answer
  -- shape the original had, arrived at from the other direction.
  --
  -- ON DELETE CASCADE because `export_and_delete` says deletion is real: the
  -- conditions, vitals and medications below all hang off this row, so closing
  -- an account removes the chronic-care record with it rather than orphaning
  -- it under a dangling id.
  account_id    uuid NOT NULL UNIQUE
                  REFERENCES identity.account(id) ON DELETE CASCADE,

  -- Mirrors the app's own defaults: `AppState._userName` starts at 'User' and
  -- `Profile.avatar_emoji` defaults to a wave. Matching them means a profile
  -- created server-side and one created offline look the same to the client.
  display_name  text NOT NULL DEFAULT 'User',
  avatar_emoji  text NOT NULL DEFAULT '👋',

  dob           date,

  -- 0–100, as the FastAPI `ProfileUpdate` already constrains it. A score
  -- outside that range is a client bug, and a CHECK makes it a loud one here
  -- rather than a chart with a bar off the top of the screen.
  health_score  smallint NOT NULL DEFAULT 0
                  CHECK (health_score BETWEEN 0 AND 100),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER profile_updated_at BEFORE UPDATE ON chronic.profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Recorded in the catalogue as well as in this file, so the reason survives
-- somebody reading the schema out of a database rather than out of git.
COMMENT ON TABLE chronic.profile IS
  'chronic-care profile, one per Tether account. account_id is NOT NULL and '
  'UNIQUE deliberately: the FastAPI predecessor''s profiles table had no owner '
  'column, so GET /profile could only select the oldest row in the table and '
  'hand it to whoever asked (routes.py:198). Ownership is not optional here, '
  'and RLS below is scoped through it.';

COMMENT ON COLUMN chronic.profile.account_id IS
  'Owner. Never nullable — an unowned profile is reachable by any query that '
  'forgets its predicate, which is the exact defect this schema replaces.';

-- ---------------------------------------------------------------------------
-- chronic.condition
-- ---------------------------------------------------------------------------

-- The five MVP modules, as rows a person has rather than as a catalogue.
--
-- `lib/models/condition.dart` ships the catalogue half — name, primary metric,
-- unit, goal label, log fields — as a `const` list in the app. That is design
-- data and it stays there. What the backend owns is the part that is about a
-- person: which of the five they manage, how it is going, and what they are
-- aiming at.
CREATE TABLE chronic.condition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES chronic.profile(id) ON DELETE CASCADE,

  -- The ids in `Condition.all`, exactly. A sixth module is a migration and a
  -- release, not a typo that silently creates a condition nothing can render.
  kind         text NOT NULL CHECK (kind IN (
                 'diabetes','hypertension','cholesterol',
                 'asthma','smoking_cessation')),

  status       text NOT NULL DEFAULT 'unknown' CHECK (status IN (
                 'controlled','elevated','borderline','high',
                 'in_progress','uncontrolled','unknown')),

  goal_value   numeric,
  goal_unit    text,
  diagnosed_at date,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- One row per module per person. The app has no UI for two diabetes cards,
  -- and a retried POST on a flaky connection would otherwise produce exactly
  -- that — with the vitals split across the two, so neither chart is right.
  UNIQUE (profile_id, kind)
);

CREATE INDEX condition_profile ON chronic.condition(profile_id);

CREATE TRIGGER condition_updated_at BEFORE UPDATE ON chronic.condition
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- chronic.vital_entry
-- ---------------------------------------------------------------------------

-- One logged reading. `lib/models/vital_entry.dart` is the contract.
--
-- It hangs off the condition, not off the profile. The FastAPI `readings` table
-- did the same thing — and that was the one place it got the shape right, since
-- reaching a reading there still required naming a condition. It is kept here
-- for the reason that makes it right rather than accidental: it is the same
-- indirection `record.observation` uses via the enrolment. A reading that is
-- not about something specific is a number with no clinical meaning, and a
-- reading reachable straight from an account is one predicate away from being
-- reachable from any account.
CREATE TABLE chronic.vital_entry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_id uuid NOT NULL REFERENCES chronic.condition(id) ON DELETE CASCADE,

  -- `metricKey` and `label` in the app's JSON. Both are stored: the key is what
  -- charts group by, the label is the wording the person saw when they logged
  -- it. Re-deriving the label from the key at read time would silently rewrite
  -- history the next time a log sheet's wording changes.
  metric_key   text NOT NULL,
  label        text NOT NULL,

  -- `numeric`, not `double precision`, even though Dart hands over a `double`.
  -- Blood glucose and a cholesterol panel are read as decimal values and
  -- compared against decimal thresholds; binary floating point turns
  -- `value >= 7.0` into a coin toss at the boundary.
  value        numeric NOT NULL,
  unit         text NOT NULL DEFAULT '',

  -- The person's own words about the reading. In core's logger redaction list
  -- as `*.note`, and never returned across a sharing boundary by this service.
  note         text NOT NULL DEFAULT '',

  -- The app's `timestamp` field: when the reading happened. Named `observed_at`
  -- to match `record.observation` and kept distinct from `recorded_at`, which
  -- is when it reached the server. A reading entered three days late is a
  -- normal thing for a person to do and a misleading thing for a chart to plot
  -- on today.
  observed_at  timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),

  source       text NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual','healthkit','healthconnect'))
);

CREATE INDEX vital_entry_condition ON chronic.vital_entry(condition_id, observed_at DESC);
CREATE INDEX vital_entry_metric    ON chronic.vital_entry(condition_id, metric_key, observed_at DESC);

-- ---------------------------------------------------------------------------
-- chronic.medication
-- ---------------------------------------------------------------------------

-- `lib/models/medication.dart` is the contract, with one field deliberately
-- not stored.
--
-- `takenToday` is absent. It is `last_taken_at` falling on the caller's today,
-- computed at read time. Stored, it would be a counter that something has to
-- reset at midnight — in whose timezone, and what happens to the flag if that
-- job does not run? The same reasoning as `slip_never_resets`: derive state
-- from events, and there is nothing to get stuck.
-- A CHECK constraint may not contain a subquery, and validating every element
-- of an array needs one. Wrapping it in an IMMUTABLE function is the supported
-- way to say what the constraint means; the alternative — validating in the
-- service only — is the alternative that stops being true the first time
-- something else writes to this table.
CREATE OR REPLACE FUNCTION chronic.is_time_of_day_list(value text[])
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    -- An empty array is valid: reminders are optional. `bool_and` over no rows
    -- is NULL, and NULL in a CHECK passes, but coalescing says so out loud.
    SELECT coalesce(
             bool_and(t IS NOT NULL AND t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
             true)
      FROM unnest(value) AS t
$$;

CREATE TABLE chronic.medication (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES chronic.profile(id) ON DELETE CASCADE,

  -- Optional: plenty of prescriptions are not tied to one tracked module.
  -- SET NULL rather than CASCADE — stopping tracking a condition is not a
  -- reason to forget that somebody takes a drug.
  condition_id      uuid REFERENCES chronic.condition(id) ON DELETE SET NULL,

  name              text NOT NULL CHECK (length(btrim(name)) > 0),
  dosage            text NOT NULL DEFAULT '',

  -- Human-readable cadence ("Once daily"), exactly as the app stores it. Not a
  -- cron expression: the app writes the words a person chose from a picker, and
  -- parsing them into a schedule server-side would be inventing precision the
  -- input does not have.
  schedule          text NOT NULL DEFAULT '',

  -- Reminder times of day as "HH:MM" strings, the app's own representation.
  -- Constrained so a malformed entry fails at write rather than at 08:00.
  times             text[] NOT NULL DEFAULT '{}',
  reminders_enabled boolean NOT NULL DEFAULT true,

  last_taken_at     timestamptz,
  active            boolean NOT NULL DEFAULT true,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT medication_times_are_hhmm
    CHECK (chronic.is_time_of_day_list(times))
);

CREATE INDEX medication_profile ON chronic.medication(profile_id)
  WHERE active;

CREATE TRIGGER medication_updated_at BEFORE UPDATE ON chronic.medication
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- ENABLE and FORCE on all four. Nothing in this schema is non-PHI: a list of
-- which chronic conditions somebody manages is health information on its own,
-- before any reading is attached to it.
--
-- FORCE matters here more than anywhere, because the thing being replaced is a
-- service that connected as one privileged user and read whatever it liked.

ALTER TABLE chronic.profile      ENABLE ROW LEVEL SECURITY;
ALTER TABLE chronic.profile      FORCE  ROW LEVEL SECURITY;
ALTER TABLE chronic.condition    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chronic.condition    FORCE  ROW LEVEL SECURITY;
ALTER TABLE chronic.vital_entry  ENABLE ROW LEVEL SECURITY;
ALTER TABLE chronic.vital_entry  FORCE  ROW LEVEL SECURITY;
ALTER TABLE chronic.medication   ENABLE ROW LEVEL SECURITY;
ALTER TABLE chronic.medication   FORCE  ROW LEVEL SECURITY;

CREATE POLICY profile_own ON chronic.profile
  USING (account_id = app_account_id())
  WITH CHECK (account_id = app_account_id());

CREATE POLICY condition_own ON chronic.condition
  USING (EXISTS (SELECT 1 FROM chronic.profile p
                  WHERE p.id = profile_id AND p.account_id = app_account_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM chronic.profile p
                  WHERE p.id = profile_id AND p.account_id = app_account_id()));

-- Two hops, deliberately. A vital is reachable only by naming the condition it
-- belongs to, and the condition only by naming the profile. This is the
-- indirection the old `readings` table lacked — it had no `profile_id` and no
-- policy, so a reading's owner was whatever the application remembered.
CREATE POLICY vital_entry_own ON chronic.vital_entry
  USING (EXISTS (SELECT 1 FROM chronic.condition c
                   JOIN chronic.profile p ON p.id = c.profile_id
                  WHERE c.id = condition_id AND p.account_id = app_account_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM chronic.condition c
                   JOIN chronic.profile p ON p.id = c.profile_id
                  WHERE c.id = condition_id AND p.account_id = app_account_id()));

CREATE POLICY medication_own ON chronic.medication
  USING (EXISTS (SELECT 1 FROM chronic.profile p
                  WHERE p.id = profile_id AND p.account_id = app_account_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM chronic.profile p
                  WHERE p.id = profile_id AND p.account_id = app_account_id()));
