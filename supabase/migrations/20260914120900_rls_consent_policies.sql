-- 0010 · RLS that holds for a role that is not a superuser.
--
-- 0003 to 0007 were written, and read, as if they were being enforced. They
-- never were: every service connected as the project superuser, which bypasses
-- row-level security entirely. Moving the services onto least-privilege roles
-- (0009) is what makes the policies run for the first time, and three of them
-- turn out not to hold.
--
--   1. INFINITE RECURSION. `sharing_consent_own` reads `programme.enrolment`,
--      and 0005's `enrolment_consented_recipient` reads `programme.sharing_consent`.
--      Each policy's subquery is itself subject to the other table's policies,
--      so PostgreSQL refuses to plan any statement that touches either table
--      ("infinite recursion detected in policy for relation"). As a superuser
--      nothing ever noticed. As a service role every read of an enrolment, a
--      consent, and — through their policies — every PHI table fails.
--
--   2. A RECIPIENT CAN WRITE. `escalation_recipient` was `FOR ALL`, so a
--      clinician holding a live consent on an enrolment could UPDATE or DELETE
--      any escalation on it, and could INSERT one citing somebody else's
--      consent, attributed to somebody else.
--
--   3. A RECIPIENT READS MORE THAN THEIR GRANT. A `totals_and_adherence`
--      consent covers counts and dates. `lapse_event_consented_recipient`
--      returned whole rows, so the free-text `severity` and `context` of a lapse
--      were readable under it — the line `enrolment-service`'s share preview
--      promises never leaves under the smaller scope.
--
-- And two tables that nothing scoped at all: `ops.audit_event` (anyone with
-- SELECT read every account's audit trail) and `identity.account` /
-- `ops.waitlist_enquiry` (email addresses, protected by grants alone).
--
-- Nothing in an earlier migration is edited. Policies are dropped and recreated
-- here, which is what a migration is for.

-- ---------------------------------------------------------------------------
-- 1 · Break the enrolment <-> consent recursion
-- ---------------------------------------------------------------------------

-- The cycle exists because ownership of a consent is only reachable *through*
-- the enrolment. Giving the consent its own copy of the owning account removes
-- the edge from `sharing_consent_own` to `programme.enrolment`, and with it the
-- cycle: `enrolment` may now read `sharing_consent`, and `sharing_consent`
-- reads nothing.
--
-- 0003 left `account_id` off this table deliberately, so that a grant has to
-- name a programme. That property is untouched: `enrolment_id` is still NOT
-- NULL and still the foreign key, a grant still cannot span programmes, and
-- this column is filled by a trigger from the enrolment, never accepted from a
-- caller. It is a cache of "who owns the enrolment", kept for the policy.
ALTER TABLE programme.sharing_consent ADD COLUMN owner_account_id uuid;

-- Backfill for rows that already exist. The migrator is the table owner, and
-- under FORCE the owner is subject to the policies: with no principal set it
-- would see no enrolment (0003) and the old `sharing_consent_own` is the policy
-- that recurses (§1 above), so on an owner that does not bypass RLS the UPDATE
-- would either match nothing or fail. FORCE is therefore lifted on the two
-- tables for the length of this one statement and put straight back; the whole
-- file is one transaction, so no other session can observe the gap. A
-- superuser or BYPASSRLS owner is unaffected either way.
ALTER TABLE programme.enrolment       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE programme.sharing_consent NO FORCE ROW LEVEL SECURITY;

UPDATE programme.sharing_consent c
   SET owner_account_id = e.account_id
  FROM programme.enrolment e
 WHERE e.id = c.enrolment_id;

ALTER TABLE programme.enrolment       FORCE ROW LEVEL SECURITY;
ALTER TABLE programme.sharing_consent FORCE ROW LEVEL SECURITY;

-- A consent whose enrolment does not exist cannot be backfilled; the foreign key
-- makes that impossible, so a failure here means the table was edited by hand
-- and the migration should stop.
ALTER TABLE programme.sharing_consent ALTER COLUMN owner_account_id SET NOT NULL;

CREATE INDEX sharing_consent_owner ON programme.sharing_consent(owner_account_id);

-- Always derived from the enrolment, overwriting whatever the INSERT supplied.
-- Runs as the caller, so a caller who cannot see the enrolment gets NULL and
-- fails NOT NULL; one who can see it only as a *recipient* gets the patient's
-- account id, which then fails the `WITH CHECK` below, because it is not theirs.
CREATE OR REPLACE FUNCTION programme.set_consent_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  NEW.owner_account_id := (
    SELECT e.account_id FROM programme.enrolment e WHERE e.id = NEW.enrolment_id
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER sharing_consent_owner
  BEFORE INSERT OR UPDATE OF enrolment_id ON programme.sharing_consent
  FOR EACH ROW EXECUTE FUNCTION programme.set_consent_owner();

DROP POLICY sharing_consent_own ON programme.sharing_consent;

CREATE POLICY sharing_consent_own ON programme.sharing_consent
  USING (owner_account_id = app_account_id())
  WITH CHECK (owner_account_id = app_account_id());

-- ---------------------------------------------------------------------------
-- 1b · The recipient policies belong to the clinician surface, not to everyone
-- ---------------------------------------------------------------------------

-- 0005 wrote its recipient policies with no `TO` clause, so they applied to every
-- role. A role with a wide SELECT on `record.*` — enrolment-service reads the
-- caller's record for the share preview, records-service is the record — then
-- also received every row a *consent* named its caller as recipient of, with the
-- free-text `severity` and `context` of a lapse among them, and nothing in those
-- services' statements said otherwise. Recipient access is care-team-service's
-- job and nobody else's, so the policies are recreated for the roles that need
-- them:
--
--   tether_care_team  all of them: it is the one reader across a consent
--   tether_realtime   the consent row only, to learn which enrolments a live
--                     consent names the caller as recipient of
--
-- The predicates are 0005's, unchanged. (Role membership is what a `TO` clause
-- tests, so the login roles inherit their group's policies.)
DROP POLICY sharing_consent_recipient          ON programme.sharing_consent;
DROP POLICY enrolment_consented_recipient      ON programme.enrolment;
DROP POLICY screen_answer_consented_recipient  ON record.screen_answer;
DROP POLICY lapse_event_consented_recipient    ON record.lapse_event;
DROP POLICY observation_consented_recipient    ON record.observation;

CREATE POLICY sharing_consent_recipient ON programme.sharing_consent
  FOR SELECT TO tether_care_team, tether_realtime
  USING (revoked_at IS NULL AND recipient_id = app_account_id()::text);

CREATE POLICY enrolment_consented_recipient ON programme.enrolment
  FOR SELECT TO tether_care_team
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = enrolment.id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text));

CREATE POLICY screen_answer_consented_recipient ON record.screen_answer
  FOR SELECT TO tether_care_team
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = screen_answer.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text
                    AND (c.scope = 'notes' OR screen_answer.kind <> 'text')));

CREATE POLICY lapse_event_consented_recipient ON record.lapse_event
  FOR SELECT TO tether_care_team
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = lapse_event.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text));

CREATE POLICY observation_consented_recipient ON record.observation
  FOR SELECT TO tether_care_team
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = observation.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text
                    AND (c.scope = 'notes' OR observation.value_text IS NULL)));

-- ---------------------------------------------------------------------------
-- 2 · A recipient may read escalations on their enrolment, and raise their own
-- ---------------------------------------------------------------------------

DROP POLICY escalation_recipient ON care.escalation;

-- Reading: any recipient with a live consent on the enrolment, as before.
CREATE POLICY escalation_recipient_read ON care.escalation
  FOR SELECT TO tether_care_team
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = escalation.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text));

-- Raising: attributed to the caller, citing a live consent that names the
-- caller and that belongs to the same enrolment. There is no UPDATE or DELETE
-- policy for a recipient at all, so an escalation cannot be edited or removed
-- from the clinician side once raised.
CREATE POLICY escalation_recipient_raise ON care.escalation
  FOR INSERT TO tether_care_team
  WITH CHECK (
    raised_by = app_account_id()
    AND EXISTS (SELECT 1 FROM programme.sharing_consent c
                 WHERE c.id = escalation.consent_id
                   AND c.enrolment_id = escalation.enrolment_id
                   AND c.revoked_at IS NULL
                   AND c.recipient_id = app_account_id()::text)
  );

-- ---------------------------------------------------------------------------
-- 3 · Lapse detail is `notes` scope; a lapse's existence is not
-- ---------------------------------------------------------------------------

-- Row-level security cannot hide a column, so the line is drawn with two
-- instruments. The policy above still lets any live consent reach the *rows*,
-- because a count of lapses is adherence and has to be computable. The
-- care-team role is then granted only `enrolment_id` and `occurred_at` on the
-- table (0011), and the free-text columns are reachable through this function
-- alone, which checks for a live `notes` consent itself.
--
-- SECURITY DEFINER so that it can read columns the caller may not select. It
-- still runs under the policies where the owner is subject to them, and its own
-- predicate does not depend on that: the caller is `app_account_id()`, and
-- without a live `notes` consent naming them it returns no rows.
CREATE OR REPLACE FUNCTION care.lapse_details(p_enrolment_id uuid)
  RETURNS TABLE (occurred_at timestamptz, severity text, context text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT l.occurred_at, l.severity, l.context
      FROM record.lapse_event l
     WHERE l.enrolment_id = p_enrolment_id
       AND EXISTS (SELECT 1 FROM programme.sharing_consent c
                    WHERE c.enrolment_id = p_enrolment_id
                      AND c.revoked_at IS NULL
                      AND c.scope = 'notes'
                      AND c.recipient_id = public.app_account_id()::text)
     ORDER BY l.occurred_at DESC
$$;

REVOKE ALL ON FUNCTION care.lapse_details(uuid) FROM PUBLIC;
-- Explicitly as well: a hosted project's default privileges can grant EXECUTE on
-- new functions to the API roles directly, which `FROM PUBLIC` does not remove.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION care.lapse_details(uuid) FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 4 · The audit trail: each service may append only what it is the author of,
--     and an account reads only its own
-- ---------------------------------------------------------------------------

ALTER TABLE ops.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.audit_event FORCE  ROW LEVEL SECURITY;

-- A single `WITH CHECK (true)` let any service with INSERT write any row, and
-- records-service treats a `record.sync` row as a *receipt* and skips the batch
-- it names (`findSyncReceipt`). So a service that could append could make
-- another account's sync silently do nothing. Appending is now decided per role,
-- by the kind of event that service authors:
--
--   tether_records     any action, but only about the caller's own account
--                      (`account_id = app_account_id()`): it owns `record.*`
--                      receipts, and cannot write one for somebody else.
--   tether_auth,       only their own families of action (`account.*`;
--   tether_enrolment   `programme.*`, `consent.*`), about the caller's account.
--                      None of them can write a `record.*` row.
--   tether_care_team   `care.*` only. The subject of a disclosure is the
--                      *patient*, not the caller, and is NULL on a refusal, so
--                      the account is not pinned to `app_account_id()`.
--   tether_website     `waitlist.*` only, and with no account: a waitlist
--                      enquirer is not an account.
--
-- What the account-id checks rest on, stated plainly: `app_account_id()` is the
-- transaction-local setting each service's `withPrincipal` writes, so they are
-- a convention a compromised service could set for itself (db/ROLES.md,
-- "What this does not do"). The action-prefix checks do not depend on it. The
-- two together stop a *bug* or a *confused* service forging another's rows; they
-- do not stop a deliberately hostile one from forging rows about an account it
-- chooses to impersonate, and that is not claimed.
CREATE POLICY audit_event_append_records ON ops.audit_event
  FOR INSERT TO tether_records
  WITH CHECK (account_id = public.app_account_id());

CREATE POLICY audit_event_append_auth ON ops.audit_event
  FOR INSERT TO tether_auth
  WITH CHECK (account_id = public.app_account_id() AND action LIKE 'account.%');

CREATE POLICY audit_event_append_enrolment ON ops.audit_event
  FOR INSERT TO tether_enrolment
  WITH CHECK (account_id = public.app_account_id()
              AND (action LIKE 'programme.%' OR action LIKE 'consent.%'));

CREATE POLICY audit_event_append_care_team ON ops.audit_event
  FOR INSERT TO tether_care_team
  WITH CHECK (action LIKE 'care.%');

CREATE POLICY audit_event_append_website ON ops.audit_event
  FOR INSERT TO tether_website
  WITH CHECK (account_id IS NULL AND action LIKE 'waitlist.%');

-- Reading is scoped to the subject. Only records-service has SELECT, to find a
-- sync receipt for the caller's own account, and with this it can find nothing
-- else.
CREATE POLICY audit_event_subject_read ON ops.audit_event
  FOR SELECT
  USING (account_id = app_account_id());

-- ---------------------------------------------------------------------------
-- 5 · Email addresses: say who may touch them, in the table and not only in
--     the grants
-- ---------------------------------------------------------------------------

ALTER TABLE identity.account ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.account FORCE  ROW LEVEL SECURITY;

-- Sign-in creates the account before there is an account to scope a transaction
-- to, and `DELETE /me` removes it, so this is service-scoped in the way
-- `identity.refresh_session` is (0004) and for the same reason. There is no
-- explicit deny-all beside it: with RLS enabled and forced, a role no policy
-- names gets nothing, so a `USING (false)` policy would be a line that does
-- nothing and reads as if it did.
CREATE POLICY account_auth_service ON identity.account
  FOR ALL TO tether_auth
  USING (true) WITH CHECK (true);

ALTER TABLE ops.waitlist_enquiry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.waitlist_enquiry FORCE  ROW LEVEL SECURITY;

CREATE POLICY waitlist_website_service ON ops.waitlist_enquiry
  FOR ALL TO tether_website
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6 · A push token follows the device, not the account
-- ---------------------------------------------------------------------------

-- `registerDevice` upserts on `token`, and as a superuser that quietly moved a
-- token from the previous signed-in account to the new one. Under
-- `device_token_own` the previous account's row is invisible to the new one, so
-- the upsert's DO UPDATE is refused and registration on a shared phone fails —
-- or, worse, if it were ever made to succeed, the old account would keep
-- receiving pushes on a device somebody else is now holding.
--
-- The privacy-preserving behaviour is the old one: the token ends up on exactly
-- one account, the latest. This function is the only way a role that cannot see
-- another account's rows may remove one, and it removes only the row holding
-- the token the caller has just presented. A device token is a bearer secret
-- the device itself handed over, which is what makes presenting it enough.
CREATE OR REPLACE FUNCTION ops.release_device_token(p_token text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    DELETE FROM ops.device_token
     WHERE token = p_token
       AND public.app_account_id() IS NOT NULL
       AND account_id IS DISTINCT FROM public.app_account_id()
$$;

REVOKE ALL ON FUNCTION ops.release_device_token(text) FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION ops.release_device_token(text) FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

-- What the function's DELETE needs in order to work. It runs as its owner, and
-- `ops.device_token` has FORCE row level security, so an owner that is neither a
-- superuser nor BYPASSRLS is subject to `device_token_own` and could see no other
-- account's row: the DELETE would match nothing and the token would stay on the
-- old account. Rather than depend on the owner bypassing RLS — which is a fact
-- about the platform, not about this schema — the owner is given one policy that
-- says exactly what the function does: it may delete a row belonging to an
-- account other than the (set) caller, and nothing else. The policy is named for
-- the function's actual owner, read from the catalogue, so it is right for
-- whichever role ran this migration. It is inert for a bypassing owner, and for
-- every other role, which are not that role.
DO $$
DECLARE
  fn_owner text;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO fn_owner
    FROM pg_proc WHERE oid = 'ops.release_device_token(text)'::regprocedure;

  -- DELETE ... WHERE reads the columns it filters on, so the SELECT policy
  -- applies to those rows too and needs the same predicate.
  EXECUTE format(
    'CREATE POLICY device_token_release_select ON ops.device_token FOR SELECT TO %I
       USING (public.app_account_id() IS NOT NULL
              AND account_id IS DISTINCT FROM public.app_account_id())',
    fn_owner
  );
  EXECUTE format(
    'CREATE POLICY device_token_release ON ops.device_token FOR DELETE TO %I
       USING (public.app_account_id() IS NOT NULL
              AND account_id IS DISTINCT FROM public.app_account_id())',
    fn_owner
  );
END
$$;
