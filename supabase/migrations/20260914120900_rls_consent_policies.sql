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

-- Backfill. Run as the table owner under FORCE, so on a database that holds
-- consent rows and whose owner does not bypass RLS this matches nothing, and
-- the SET NOT NULL below then fails and aborts the migration. That is the
-- intended outcome: it is loud, it is atomic, and the migration has not been
-- applied to any database that holds consent rows.
UPDATE programme.sharing_consent c
   SET owner_account_id = e.account_id
  FROM programme.enrolment e
 WHERE e.id = c.enrolment_id;

ALTER TABLE programme.sharing_consent ALTER COLUMN owner_account_id SET NOT NULL;

CREATE INDEX sharing_consent_owner ON programme.sharing_consent(owner_account_id);

-- Always derived from the enrolment, overwriting whatever the INSERT supplied.
-- Runs as the caller, so a caller who cannot see the enrolment gets NULL and
-- fails NOT NULL; one who can see it only as a *recipient* gets the patient's
-- account id, which then fails the `WITH CHECK` below, because it is not theirs.
CREATE OR REPLACE FUNCTION programme.set_consent_owner() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
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
-- 2 · A recipient may read escalations on their enrolment, and raise their own
-- ---------------------------------------------------------------------------

DROP POLICY escalation_recipient ON care.escalation;

-- Reading: any recipient with a live consent on the enrolment, as before.
CREATE POLICY escalation_recipient_read ON care.escalation
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM programme.sharing_consent c
                  WHERE c.enrolment_id = escalation.enrolment_id
                    AND c.revoked_at IS NULL
                    AND c.recipient_id = app_account_id()::text));

-- Raising: attributed to the caller, citing a live consent that names the
-- caller and that belongs to the same enrolment. There is no UPDATE or DELETE
-- policy for a recipient at all, so an escalation cannot be edited or removed
-- from the clinician side once raised.
CREATE POLICY escalation_recipient_raise ON care.escalation
  FOR INSERT
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
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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

-- ---------------------------------------------------------------------------
-- 4 · The audit trail: any service may append, an account reads only its own
-- ---------------------------------------------------------------------------

ALTER TABLE ops.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.audit_event FORCE  ROW LEVEL SECURITY;

-- Append is open to any role that has been granted INSERT, which is a short
-- list (0011). `account_id` is the *subject* of the event and is not required
-- to be the caller: care-team-service files a clinician's read under the
-- patient's account, because "who has seen my record" is what the table is for.
CREATE POLICY audit_event_append ON ops.audit_event
  FOR INSERT
  WITH CHECK (true);

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
-- `identity.refresh_session` is (0004) and for the same reason.
CREATE POLICY account_deny_all ON identity.account
  FOR ALL TO PUBLIC
  USING (false) WITH CHECK (false);

CREATE POLICY account_auth_service ON identity.account
  FOR ALL TO tether_auth
  USING (true) WITH CHECK (true);

ALTER TABLE ops.waitlist_enquiry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.waitlist_enquiry FORCE  ROW LEVEL SECURITY;

CREATE POLICY waitlist_deny_all ON ops.waitlist_enquiry
  FOR ALL TO PUBLIC
  USING (false) WITH CHECK (false);

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
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DELETE FROM ops.device_token
     WHERE token = p_token
       AND account_id IS DISTINCT FROM public.app_account_id()
$$;

REVOKE ALL ON FUNCTION ops.release_device_token(text) FROM PUBLIC;
