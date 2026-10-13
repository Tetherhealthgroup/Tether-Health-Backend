-- 0012 · A consent revocation says which enrolment, and nothing about whom.
--
-- `programme.notify_consent_change` (0008) announces a revocation with the
-- enrolment only. Before this migration `realtime-service` had to tell every
-- recipient of that enrolment and drop them all from it, so a recipient whose own
-- consent was still live learned that somebody else's had been withdrawn.
--
-- An earlier draft of this file fixed that by putting the revoked consent's
-- `recipient_id` in the payload. It must not be there (R-063). The column is free
-- `text` and, for a supporter, could hold a name or an email; any role that can
-- connect to the database can `LISTEN tether_change`, whatever its grants, so the
-- channel would link a recipient identifier to an enrolment and a time. The
-- channel holds one line (0008): "the fact that something changed, and nothing
-- else". The payload is therefore exactly 0008's, and `realtime-service` works
-- out whom a revocation concerns by asking, under that recipient's own principal,
-- whether a live consent still names them (it can see its own live consents and
-- no others).
--
-- CREATE OR REPLACE on the function 0008 created: the trigger that calls it is
-- untouched. `revoked` is true on a revocation and false on every other change.
CREATE OR REPLACE FUNCTION programme.notify_consent_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_notify(
    'tether_change',
    pg_catalog.json_build_object(
      'enrolmentId', COALESCE(NEW.enrolment_id, OLD.enrolment_id),
      'table',       'programme.sharing_consent',
      'op',          pg_catalog.lower(TG_OP),
      'revoked',     (NEW.revoked_at IS NOT NULL),
      'at',          pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::text
  );
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION programme.notify_consent_change() FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION programme.notify_consent_change() FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

-- A recipient is an account: a lowercase uuid, or NULL ("any recipient of this
-- kind"). Every policy compares `recipient_id` with `app_account_id()::text`, so
-- a value that is not the lowercase text of a uuid can never match anyone and can
-- never grant access; all it can do is hold a name or an email in a column that
-- other roles can read. The API contract (`SharingRequestSchema`) refuses it at
-- the edge; this is the same rule where the data lives.
--
-- NOT VALID: the rule applies to every row inserted or updated from now on, and
-- existing rows are not scanned, so the migration cannot fail on data written
-- before it. `ALTER TABLE ... VALIDATE CONSTRAINT` is the later, separate step
-- once the data has been looked at.
ALTER TABLE programme.sharing_consent
  ADD CONSTRAINT sharing_consent_recipient_id_uuid
  CHECK (recipient_id IS NULL
         OR recipient_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  NOT VALID;
