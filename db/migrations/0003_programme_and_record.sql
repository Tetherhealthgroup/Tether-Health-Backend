-- 0003 · Enrolment, consent, and the patient record.
--
-- This is the migration that carries the rules. Three of them are structural
-- here rather than enforced in application code, because application code is
-- what gets bypassed by the next endpoint somebody adds in a hurry:
--
--   per_program_sharing  every PHI row hangs off an enrolment, never an account
--   slip_never_resets    lapses are append-only and no counter derives from them
--   export_and_delete    deletion is real; there is no soft-delete on PHI
--
-- Every table below has RLS enabled AND forced. Forced matters: without it the
-- table owner bypasses its own policies, and the owner is who migrations and
-- maintenance scripts connect as.

BEGIN;

-- ---------------------------------------------------------------------------
-- programme.enrolment
-- ---------------------------------------------------------------------------

CREATE TABLE programme.enrolment (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES identity.account(id) ON DELETE CASCADE,
  area_id    text NOT NULL REFERENCES catalogue.area(id),

  status     text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused','ended')),

  -- `discreet_program`: "Any program can be hidden from the home screen and
  -- reached only from Your programs… Stigma is a real adherence barrier on
  -- shared or family devices." Hidden is not paused — it still runs.
  hidden     boolean NOT NULL DEFAULT false,

  -- Set when a child profile, rather than the account holder, is the subject.
  child_profile_id uuid REFERENCES identity.child_profile(id) ON DELETE CASCADE,

  joined_on  timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One enrolment per account per area. Re-joining reuses the row, which is
  -- what keeps history across a pause/resume — and what stops a second join
  -- quietly orphaning the first one's record.
  UNIQUE (account_id, area_id)
);

CREATE INDEX enrolment_account ON programme.enrolment(account_id);
CREATE INDEX enrolment_active  ON programme.enrolment(account_id)
  WHERE status = 'active';

CREATE TRIGGER enrolment_updated_at BEFORE UPDATE ON programme.enrolment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- `two_active_max`, enforced in the database.
--
-- The API checks this too, and the API is not enough: two concurrent joins each
-- see one active programme and each write a second. A unique partial index
-- cannot express "at most two", so this is a constraint trigger, deferred to
-- commit so that a legitimate pause-then-join inside one transaction is not
-- rejected halfway through.
CREATE OR REPLACE FUNCTION programme.enforce_active_ceiling() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  active_count integer;
  ceiling      integer;
BEGIN
  SELECT count(*) INTO active_count
    FROM programme.enrolment
   WHERE account_id = NEW.account_id AND status = 'active';

  -- Read from the shell rules rather than hard-coded, so the number lives in
  -- one place. Defaults to 2 if the catalogue has not been seeded yet.
  SELECT coalesce(
           (SELECT substring(rule from '\d+')::int
              FROM catalogue.shell_rule WHERE id = 'two_active_max'), 2)
    INTO ceiling;

  IF active_count > ceiling THEN
    RAISE EXCEPTION
      'at most % programmes may be active at once (account %)', ceiling, NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER enrolment_active_ceiling
  AFTER INSERT OR UPDATE OF status ON programme.enrolment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION programme.enforce_active_ceiling();

-- ---------------------------------------------------------------------------
-- programme.sharing_consent
-- ---------------------------------------------------------------------------

-- Consent hangs off the enrolment, so a global grant is not expressible.
--
-- `per_program_sharing`: "Sharing consent is granted per program, never
-- globally… Under 42 CFR Part 2, substance-use data must be segregated
-- regardless." There is deliberately no `account_id` here: to grant consent you
-- must name a programme, and a query that wants everything a person shares has
-- to walk each enrolment and be seen doing it.
--
-- Versioned and revocable because the website already promises it: "Consent
-- versioning, purpose limitation and revocation enforced on the server, not
-- merely reflected in the interface" (security.astro).
CREATE TABLE programme.sharing_consent (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id   uuid NOT NULL REFERENCES programme.enrolment(id) ON DELETE CASCADE,

  -- What may be seen. Totals are not notes: "A coach seeing a total is a
  -- different disclosure from a coach reading a note."
  scope          text NOT NULL
                   CHECK (scope IN ('totals_and_adherence','notes')),

  recipient_kind text NOT NULL
                   CHECK (recipient_kind IN ('coach','care_team','supporter')),
  recipient_id   text,

  -- The exact consent wording the person agreed to. Not a version number alone:
  -- proving what somebody consented to means keeping the words.
  consent_version text NOT NULL,
  consent_text    text NOT NULL,

  granted_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,

  -- One live grant per (enrolment, scope, recipient). Revoked rows stay: the
  -- history of what was shared and when is the evidence that revocation was
  -- honoured.
  UNIQUE NULLS NOT DISTINCT (enrolment_id, scope, recipient_kind, recipient_id, revoked_at)
);

CREATE INDEX sharing_consent_live ON programme.sharing_consent(enrolment_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- record — PHI
-- ---------------------------------------------------------------------------

-- Answers, keyed by (enrolment, screen, block).
--
-- The enrolment, not the account, and not the screen id alone. The Flutter app
-- had exactly this bug: it keyed answers by screen id, and because `behavioral`
-- and `digital` both resolve to the `lookup` product, all 34 screen ids
-- collided — two active programmes wrote into one record and each could read
-- the other's answers. Keying on the enrolment makes that unrepresentable.
CREATE TABLE record.screen_answer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid NOT NULL REFERENCES programme.enrolment(id) ON DELETE CASCADE,
  screen_id    text NOT NULL,
  block_index  smallint NOT NULL,

  kind         text NOT NULL CHECK (kind IN ('chips','option','slider','text')),

  -- One column, typed by `kind`. A chip set is an int array, an option an int,
  -- a slider a number, text a string — four columns would be four nullable
  -- columns and no way to say which one is meant.
  value        jsonb NOT NULL,

  answered_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (enrolment_id, screen_id, block_index)
);

CREATE INDEX screen_answer_enrolment ON record.screen_answer(enrolment_id);

CREATE TRIGGER screen_answer_updated_at BEFORE UPDATE ON record.screen_answer
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A lapse is an event, not a counter.
--
-- `slip_never_resets`: "A lapse is recorded in history. It never zeroes a
-- counter, streak or progress value." Append-only below, and there is no
-- counter column anywhere in this schema that a lapse decrements — progress is
-- computed from history at read time, so there is nothing to reset.
CREATE TABLE record.lapse_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid NOT NULL REFERENCES programme.enrolment(id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL,
  severity     text NOT NULL,
  context      text[] NOT NULL DEFAULT '{}',
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX lapse_event_enrolment ON record.lapse_event(enrolment_id, occurred_at DESC);

-- No UPDATE. DELETE is left available: erasing a record is a right, and a rule
-- forbidding it would make `hard_delete_action` impossible to honour.
CREATE RULE lapse_event_no_update AS ON UPDATE TO record.lapse_event DO INSTEAD NOTHING;

-- Observations: any measured or self-reported value.
--
-- `platform` is on the row because the addendum's risk register asks for it:
-- "label platform on every patient record." iOS returns aggregate screen time
-- where Android returns per-app, so the same measure means different things
-- depending on where it came from, and a clinician comparing two patients needs
-- to know which.
CREATE TABLE record.observation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid NOT NULL REFERENCES programme.enrolment(id) ON DELETE CASCADE,
  measure_id   text NOT NULL REFERENCES catalogue.measure(id),

  value_num    numeric,
  value_text   text,
  unit         text NOT NULL,

  observed_at  timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),

  source       text NOT NULL DEFAULT 'self_report'
                 CHECK (source IN ('self_report','device','clinician','derived')),
  platform     text CHECK (platform IN ('ios','android','web','unknown')),

  CHECK (value_num IS NOT NULL OR value_text IS NOT NULL)
);

CREATE INDEX observation_enrolment ON record.observation(enrolment_id, observed_at DESC);
CREATE INDEX observation_measure   ON record.observation(measure_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- ENABLE and FORCE on every table that holds or gates PHI.
--
-- FORCE is the half the model repo omitted. Without it the owning role — which
-- is what migrations and maintenance scripts connect as — silently bypasses
-- every policy below.

ALTER TABLE programme.enrolment        ENABLE ROW LEVEL SECURITY;
ALTER TABLE programme.enrolment        FORCE  ROW LEVEL SECURITY;
ALTER TABLE programme.sharing_consent  ENABLE ROW LEVEL SECURITY;
ALTER TABLE programme.sharing_consent  FORCE  ROW LEVEL SECURITY;
ALTER TABLE record.screen_answer       ENABLE ROW LEVEL SECURITY;
ALTER TABLE record.screen_answer       FORCE  ROW LEVEL SECURITY;
ALTER TABLE record.lapse_event         ENABLE ROW LEVEL SECURITY;
ALTER TABLE record.lapse_event         FORCE  ROW LEVEL SECURITY;
ALTER TABLE record.observation         ENABLE ROW LEVEL SECURITY;
ALTER TABLE record.observation         FORCE  ROW LEVEL SECURITY;
ALTER TABLE identity.child_profile     ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.child_profile     FORCE  ROW LEVEL SECURITY;

CREATE POLICY enrolment_own ON programme.enrolment
  USING (account_id = app_account_id())
  WITH CHECK (account_id = app_account_id());

CREATE POLICY child_profile_own ON identity.child_profile
  USING (guardian_id = app_account_id())
  WITH CHECK (guardian_id = app_account_id());

-- The PHI tables reach the account only through the enrolment. That indirection
-- is the point: there is no path to a health row that does not pass through the
-- programme it belongs to.
CREATE POLICY sharing_consent_own ON programme.sharing_consent
  USING (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()));

CREATE POLICY screen_answer_own ON record.screen_answer
  USING (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()));

CREATE POLICY lapse_event_own ON record.lapse_event
  USING (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()));

CREATE POLICY observation_own ON record.observation
  USING (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = enrolment_id AND e.account_id = app_account_id()));

COMMIT;
