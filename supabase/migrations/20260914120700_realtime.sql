-- Realtime change notification.
--
-- The design decision here is what a change event is allowed to contain, and
-- the answer is: the fact that something changed, and nothing else.
--
-- A notification carries `enrolment_id`, the table, and the operation. It never
-- carries a row. A client that receives one re-fetches through the ordinary
-- API, which is where the consent check lives — so a subscription cannot become
-- a second, unguarded read path.
--
-- That matters more here than in most products. `per_program_sharing` puts a
-- consent check between a clinician and a patient's record; a realtime stream
-- that pushed row contents would have to re-implement that check in a second
-- place, against a payload assembled by a trigger with no idea who is
-- listening. The safest payload is the one with nothing in it.
--
-- It is also the same reasoning as `sensitive_notifications_off`, which says a
-- lock screen shows that a reminder exists and never what it is about.

-- ---------------------------------------------------------------------------
-- LISTEN/NOTIFY, for clients that cannot use the Supabase SDK
-- ---------------------------------------------------------------------------

-- The Flutter apps declare exactly one runtime dependency and a test fails the
-- build if a second appears, so they cannot use `supabase_flutter`. They read
-- Server-Sent Events over plain HTTP instead, which `dart:io` can do unaided,
-- and `realtime-service` turns these notifications into that stream.
CREATE OR REPLACE FUNCTION record.notify_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  target uuid;
BEGIN
  -- On DELETE the new row is gone, so the enrolment comes from OLD.
  target := COALESCE(NEW.enrolment_id, OLD.enrolment_id);

  -- No row, no column values, no free text. Just the address of what to
  -- re-read and the verb that happened.
  PERFORM pg_notify(
    'tether_change',
    json_build_object(
      'enrolmentId', target,
      'table',       TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
      'op',          lower(TG_OP),
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::text
  );
  RETURN NULL;
END
$$;

-- AFTER, and STATEMENT-independent: a notification must never be able to fail
-- the write it describes. FOR EACH ROW because a client needs to know which
-- enrolment changed, and a statement-level trigger cannot tell it.
CREATE TRIGGER screen_answer_notify
  AFTER INSERT OR UPDATE OR DELETE ON record.screen_answer
  FOR EACH ROW EXECUTE FUNCTION record.notify_change();

CREATE TRIGGER lapse_event_notify
  AFTER INSERT OR DELETE ON record.lapse_event
  FOR EACH ROW EXECUTE FUNCTION record.notify_change();

CREATE TRIGGER observation_notify
  AFTER INSERT OR UPDATE OR DELETE ON record.observation
  FOR EACH ROW EXECUTE FUNCTION record.notify_change();

-- Consent changes are the one event a clinician surface must react to
-- immediately: "revocation is enforced rather than merely recorded"
-- (for-clinicians.astro). A dashboard holding a stale consent is a dashboard
-- still showing a record the person has withdrawn.
CREATE OR REPLACE FUNCTION programme.notify_consent_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_notify(
    'tether_change',
    json_build_object(
      'enrolmentId', COALESCE(NEW.enrolment_id, OLD.enrolment_id),
      'table',       'programme.sharing_consent',
      'op',          lower(TG_OP),
      -- Whether a grant is now live, so a listener can drop a stream without
      -- a round trip. Not who it is with, and not what it covers.
      'revoked',     (NEW.revoked_at IS NOT NULL),
      'at',          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::text
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER sharing_consent_notify
  AFTER INSERT OR UPDATE OF revoked_at ON programme.sharing_consent
  FOR EACH ROW EXECUTE FUNCTION programme.notify_consent_change();

-- ---------------------------------------------------------------------------
-- Supabase Realtime, for clients that can use the SDK
-- ---------------------------------------------------------------------------

-- Supabase Realtime reads its own publication and, for `postgres_changes`,
-- applies the subscriber's RLS policies to every row before sending it. Our
-- policies are `FORCE`d and scoped through the enrolment, so a subscriber sees
-- exactly what they could have selected — a web clinician console can use the
-- JS SDK directly and inherit the whole consent model.
--
-- Only the two tables where a live view is actually useful. Adding a table to a
-- publication is adding a delivery path for its rows, so this list stays short
-- and deliberate rather than becoming `FOR ALL TABLES`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE record.observation;
    ALTER PUBLICATION supabase_realtime ADD TABLE programme.sharing_consent;
  END IF;
END
$$;

-- `REPLICA IDENTITY FULL` so that a DELETE carries the old row's enrolment to
-- the replication stream. Without it a deletion arrives with only the primary
-- key, and RLS cannot evaluate a policy that reaches through `enrolment_id` —
-- so the event is dropped, and a subscriber never learns the row is gone.
ALTER TABLE record.observation REPLICA IDENTITY FULL;
ALTER TABLE programme.sharing_consent REPLICA IDENTITY FULL;
