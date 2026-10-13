-- 0012 · A consent revocation says whose consent it was.
--
-- `programme.notify_consent_change` (0008) announces a revocation with the
-- enrolment, and nothing about *which* recipient lost access. So
-- `realtime-service` had to tell every recipient of that enrolment, and drop them
-- all from it: a recipient whose own consent was still live learned that somebody
-- else's had been withdrawn, and lost a view they were entitled to.
--
-- The notification now carries `recipientId` on a revocation, so the stream can
-- tell the owner and the one recipient concerned, and nobody else. It is an
-- account id, not a row's content, which is the line the channel holds
-- (0008): "the fact that something changed, and nothing else". A grant does not
-- carry it, because a grant is the owner's alone and the recipient has nothing to
-- drop.
--
-- CREATE OR REPLACE on the function 0008 created: the trigger that calls it is
-- untouched. `recipientId` is `null` for a consent that names no recipient (it
-- means "any recipient of this kind"); the stream treats that as "every
-- recipient of the enrolment", which is the previous, fail-closed behaviour.
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
      'recipientId', CASE WHEN NEW.revoked_at IS NOT NULL THEN NEW.recipient_id END,
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
