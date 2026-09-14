-- 0005 · The clinician surface: escalation routing, and the read path across consent.
--
-- Two things live here, and they are in one migration because they are one
-- decision: what a clinician may see, and where a distress signal goes.
--
--   distress_escalation  "A distress signal never terminates at a non-clinical
--                        coach. Routing is configured per program by clinical
--                        leadership."
--   per_program_sharing  a clinician reaches a person through one enrolment, and
--                        reaches nothing else through it
--
-- The second half of this file is the part worth reading twice. `care-team` is
-- the only service in the platform that reads across a consent boundary, and
-- 0003's policies quite correctly give a PHI row to one account only: the one
-- that owns the enrolment it hangs off. Under those policies alone this service
-- returns nothing at all, which is the right default and the wrong end state.
--
-- Rather than hand the service a role that bypasses RLS — the exact mistake
-- ARCHITECTURE.md records from the model repo, where the service-role key in
-- every request path made RLS decorative — this migration adds *additive*
-- policies whose predicate is a live consent row. Policies are OR'd, so nothing
-- 0003 granted is narrowed, and the widening is expressible in one sentence: a
-- principal named as `recipient_id` on an unrevoked `programme.sharing_consent`
-- may read the rows hanging off that one enrolment, and free text only when the
-- consent says `notes`.
--
-- The consequence is that revocation is enforced by the database. Setting
-- `revoked_at` makes the policy stop matching on the next statement — there is
-- no cache, no grant to withdraw and no application check to forget. And a
-- clinician consented to one programme cannot reach another, because the
-- predicate is joined on `enrolment_id` and every PHI table carries exactly
-- that one column.

-- ---------------------------------------------------------------------------
-- care.escalation_policy — routing as data
-- ---------------------------------------------------------------------------

-- `distress_escalation` requires an `escalation_policy_ref`, and the reason it
-- is a reference rather than a rule is in the safeguard's own words: routing is
-- "configured per program by clinical leadership". Code cannot be configured by
-- clinical leadership. A table can.
--
-- The absence of a row is meaningful. `care-team-service` refuses an escalation
-- for a programme with no policy rather than routing it to whoever is nearest,
-- because "whoever is nearest" in a cessation programme is a coach, and a coach
-- is precisely where a distress signal must not terminate. A programme that has
-- not had this conversation with its clinical lead does not get to accept
-- distress signals.
CREATE TABLE care.escalation_policy (
  -- One live policy per programme. An escalation snapshots what it routed by,
  -- so a later edit changes where the next signal goes and rewrites no history.
  area_id text PRIMARY KEY REFERENCES catalogue.area(id) ON DELETE CASCADE,

  -- Bumped when the routing changes. Copied onto every escalation raised under
  -- it, so "which policy was in force" is answerable years later.
  version text NOT NULL,

  -- Where a signal terminates.
  --
  -- The enumeration is the safeguard. 'coach' is not in it and must never be
  -- added: `programme.sharing_consent.recipient_kind` does allow 'coach',
  -- because a coach may legitimately receive shared totals — but receiving a
  -- total and being the terminus of a distress signal are different acts, and
  -- conflating them is the failure `distress_escalation` names.
  clinical_recipient_kind text NOT NULL
    CHECK (clinical_recipient_kind IN ('clinician', 'care_team', 'crisis_line')),

  -- The rota, queue or service this programme's signals reach. Opaque to the
  -- API on purpose: what it identifies is an operational decision, and encoding
  -- its structure here would make every future integration a migration.
  clinical_contact text NOT NULL CHECK (length(clinical_contact) > 0),

  -- `crisis_routing_first`: "Emergency and crisis routes are designed before
  -- anything else and are never reordered, collapsed or filtered." Held beside
  -- the clinical route rather than derived from it, so it survives a change to
  -- the ordinary one.
  crisis_contact text,

  -- How long the route has. An escalation with no deadline is a message.
  acknowledge_within_minutes integer NOT NULL
    CHECK (acknowledge_within_minutes > 0 AND acknowledge_within_minutes <= 10080),

  -- Who in clinical leadership set this, recorded because the safeguard names
  -- them as the author. Not a foreign key to an account: the person who signs
  -- off a routing policy is frequently not a user of this system.
  configured_by text NOT NULL CHECK (length(configured_by) > 0),
  configured_at timestamptz NOT NULL DEFAULT now(),
  effective_from timestamptz NOT NULL DEFAULT now(),

  notes text,

  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER escalation_policy_updated_at BEFORE UPDATE ON care.escalation_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- care.escalation — one raised signal
-- ---------------------------------------------------------------------------

CREATE TABLE care.escalation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The enrolment, as everywhere else. Not the account: an escalation belongs
  -- to one programme, and a clinician holding consent for one programme must
  -- not be able to raise — or read — anything against another.
  enrolment_id uuid NOT NULL REFERENCES programme.enrolment(id) ON DELETE CASCADE,

  -- The clinician's account id. Not a foreign key to `identity.account` for the
  -- same reason `ops.audit_event.account_id` is not: closing a clinician's
  -- account must not erase the record that they raised a signal.
  raised_by uuid NOT NULL,

  -- The consent the raise relied on. A signal raised without one is a 42 CFR
  -- Part 2 disclosure nobody can justify afterwards, so the justification is a
  -- column rather than a log line.
  --
  -- `ON DELETE CASCADE`, not the default, because `records-service`'s
  -- `DELETE /record` removes a person's consents on the way to removing their
  -- enrolments. A restricting reference here would let the clinician surface
  -- block an erasure, and `hard_delete_action` is not something another
  -- service gets a veto over.
  consent_id uuid NOT NULL
    REFERENCES programme.sharing_consent(id) ON DELETE CASCADE,

  -- A named signal, never a computed one.
  --
  -- `no_risk_score` forbids `risk_percentage` and `risk_grade`;
  -- `no_result_interpretation` forbids a `result_verdict`. There is deliberately
  -- no numeric severity, no score and no grade on this table — a clinician says
  -- what they observed, and the system does not rank it for them.
  signal text NOT NULL CHECK (length(signal) BETWEEN 1 AND 120),
  detail text,

  -- The routing, snapshotted at the moment of raising.
  --
  -- Copied rather than joined, and with no foreign key back to
  -- `care.escalation_policy`, because where a signal *went* is a historical
  -- fact. A policy edited next month must change where the next one goes and
  -- must not rewrite this one, and a policy deleted must not take the evidence
  -- with it.
  policy_area_id text NOT NULL,
  policy_version text NOT NULL,
  routed_to_kind text NOT NULL
    CHECK (routed_to_kind IN ('clinician', 'care_team', 'crisis_line')),
  routed_to text NOT NULL,

  raised_at timestamptz NOT NULL DEFAULT now(),
  acknowledge_by timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid
);

CREATE INDEX escalation_enrolment ON care.escalation(enrolment_id, raised_at DESC);
CREATE INDEX escalation_open ON care.escalation(acknowledge_by)
  WHERE acknowledged_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- ENABLE and FORCE, as 0003 does. FORCE is the half the model repo omitted:
-- without it the owning role — which is what migrations and maintenance scripts
-- connect as — silently bypasses every policy below.

ALTER TABLE care.escalation_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE care.escalation_policy FORCE  ROW LEVEL SECURITY;
ALTER TABLE care.escalation        ENABLE ROW LEVEL SECURITY;
ALTER TABLE care.escalation        FORCE  ROW LEVEL SECURITY;

-- Routing is readable by anyone the platform has authenticated. It is
-- operational configuration and contains no PHI, and a clinician who cannot see
-- where a signal would go cannot sensibly decide to raise one.
CREATE POLICY escalation_policy_read ON care.escalation_policy
  FOR SELECT USING (true);

-- Routing is writable only on a connection with no principal.
--
-- Every request-scoped connection has `app.account_id` set by
-- `withPrincipal`, so this predicate is false for every clinician and every
-- patient, on every route, in every service. What is left is the migration and
-- admin path — which is exactly who "clinical leadership" is, operationally.
-- `care-team-service` therefore *cannot* write its own routing, and that is the
-- property `distress_escalation` is really asking for.
CREATE POLICY escalation_policy_write ON care.escalation_policy
  FOR ALL
  USING (app_account_id() IS NULL)
  WITH CHECK (app_account_id() IS NULL);

-- An escalation is visible to the person it is about…
CREATE POLICY escalation_subject ON care.escalation
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM programme.enrolment e
                  WHERE e.id = escalation.enrolment_id
                    AND e.account_id = app_account_id()));

-- …and to a recipient with a live consent on that one enrolment. Revoke the
-- consent and this stops matching on the next statement.
CREATE POLICY escalation_recipient ON care.escalation
  FOR ALL
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = escalation.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text))
  WITH CHECK (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = escalation.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text));

-- ---------------------------------------------------------------------------
-- The consent-derived read path
-- ---------------------------------------------------------------------------

-- Everything below is ADDITIVE. Policies on a table are OR'd, so 0003's
-- `*_own` policies are untouched and no patient loses anything. What is added
-- is one predicate, repeated: "a principal named as `recipient_id` on an
-- unrevoked consent for this enrolment".
--
-- Written as policies rather than as checks in `care-team-service` because
-- 0003 already states the reason: "application code is what gets bypassed by
-- the next endpoint somebody adds in a hurry". A service-layer scope check
-- protects the routes that remember it. A policy protects the ones nobody has
-- written yet.

-- The consent row itself, to the recipient it names.
--
-- Deliberately self-contained — `recipient_id = app_account_id()` and nothing
-- else — so it does not depend on another policy to be evaluable, and so it is
-- the one place a reviewer has to trust. Note `FOR SELECT`: a recipient can
-- read that they hold a consent and can never write one. Granting is the
-- person's act, in `enrolment-service`, and a clinician who could insert here
-- could consent on their patient's behalf.
CREATE POLICY sharing_consent_recipient ON programme.sharing_consent
  FOR SELECT
  USING (revoked_at IS NULL AND recipient_id = app_account_id()::text);

-- The enrolment a live consent points at, and only that one. There is no
-- predicate here that reaches `account_id`, which is what makes "never join
-- across programmes" structural: from a consent, a clinician can reach one
-- enrolment; from that enrolment there is no path back to the account and out
-- to its siblings.
CREATE POLICY enrolment_consented_recipient ON programme.enrolment
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = enrolment.id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text));

-- Answers: everything but free text under any live consent; free text only
-- under `notes`.
--
-- This is the scope boundary made structural. `totals_and_adherence` and
-- `notes` exist as separate scopes because "a coach seeing a total is a
-- different disclosure from a coach reading a note", and `record.screen_answer`
-- happens to label exactly that distinction in its `kind` column. So the
-- clause is one line, and a bug in a service projection cannot leak a note to a
-- totals-only recipient — the row is not there to leak.
CREATE POLICY screen_answer_consented_recipient ON record.screen_answer
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = screen_answer.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text
                    AND (c.scope = 'notes' OR screen_answer.kind <> 'text')));

-- Lapses, to any live consent.
--
-- A lapse count is adherence, which `totals_and_adherence` covers, and the
-- rows have to be reachable for a count to be computed from history at read
-- time — there is no counter to read instead, by design. What a
-- totals-only clinician receives is a count and dates and never a `severity` or
-- a `context` tag: that projection is `care-team-service`'s job and is asserted
-- in its tests. The line the database holds is the free-text one above.
CREATE POLICY lapse_event_consented_recipient ON record.lapse_event
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = lapse_event.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text));

-- Observations: numeric values under any live consent, textual ones only under
-- `notes`. `value_text` on an observation is a person's own words by another
-- route, and it gets the same treatment as an answer's text.
CREATE POLICY observation_consented_recipient ON record.observation
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = observation.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text
                    AND (c.scope = 'notes' OR observation.value_text IS NULL)));
