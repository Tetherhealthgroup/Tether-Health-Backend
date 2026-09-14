-- 0006 · Push notifications: device tokens, the delivery log, and the one
-- preference that decides what a lock screen is allowed to say.
--
-- The safeguard this migration exists to make structural is
-- `sensitive_notifications_off`:
--
--   "A lock screen shows that a reminder exists, never what it is about."
--   defaultOff: true
--
-- "defaultOff" is a column default here, not a convention in a service. An
-- account that has never been asked has `specific_content = false`, so the only
-- payload the sender can produce for it is the generic one. Getting the
-- sensitive behaviour requires a row to have been written on purpose.
--
-- The second structural decision is an absence: `ops.notification_log` has no
-- column for the notification body. Not "we don't write it" — there is nowhere
-- to put it. A log table that *could* hold the text of a reminder is one
-- INSERT away from a lock-screen safeguard being undone in the database, and
-- logs travel further than the rows they describe.

-- ---------------------------------------------------------------------------
-- ops.device_token
-- ---------------------------------------------------------------------------

-- One row per (device, account). The token is the device; the account owns it.
--
-- `token` is UNIQUE globally rather than per account, because a physical device
-- handed to a second person keeps the same FCM/APNs token. Unique means the
-- re-registration replaces the owner instead of adding a second owner, so the
-- previous account stops receiving pushes on hardware it no longer holds. A
-- per-account unique would have left both rows in place and sent to both.
CREATE TABLE ops.device_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES identity.account(id) ON DELETE CASCADE,

  token        text NOT NULL UNIQUE,
  platform     text NOT NULL CHECK (platform IN ('ios','android','web')),

  -- Which health area the device registered for, when the client knows. Used
  -- to avoid waking a device for a programme the person is not in. Nullable:
  -- the app registers at launch, before any area is chosen.
  area_id      text REFERENCES catalogue.area(id),

  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Touched on every re-registration. A token nothing has refreshed in months
  -- is a reinstalled or discarded device, and pruning on this column is how the
  -- table stops growing without bound.
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_token_account ON ops.device_token(account_id);
CREATE INDEX device_token_stale   ON ops.device_token(last_seen_at);

-- ---------------------------------------------------------------------------
-- ops.notification_preference
-- ---------------------------------------------------------------------------

-- The opt-in, and nothing else.
--
-- One boolean rather than a jsonb bag of settings, because this is the only
-- preference that changes what a stranger standing behind someone can read.
-- Widening it later is a migration; burying it in a free-form document would
-- make "is the safeguard on for this account?" a question about JSON parsing.
CREATE TABLE ops.notification_preference (
  account_id       uuid PRIMARY KEY
                     REFERENCES identity.account(id) ON DELETE CASCADE,

  -- `sensitive_notifications_off`, inverted and defaulted off. False means the
  -- sender may only produce "You have a reminder". True is a deliberate choice
  -- the person made, and the wording they were shown is kept alongside it so
  -- that what they agreed to is provable rather than remembered.
  specific_content boolean NOT NULL DEFAULT false,
  opted_in_at      timestamptz,
  consent_text     text,

  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- An opt-in with no timestamp and no wording is an opt-in nobody can stand
  -- behind. Enforced here so the service cannot write a half-recorded consent.
  CONSTRAINT notification_preference_optin_is_evidenced
    CHECK (specific_content = false
           OR (opted_in_at IS NOT NULL AND consent_text IS NOT NULL))
);

CREATE TRIGGER notification_preference_updated_at
  BEFORE UPDATE ON ops.notification_preference
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ops.notification_log
-- ---------------------------------------------------------------------------

-- What was sent, when, and to whom — never what it said.
--
-- `kind` is the template identifier, so "a medication reminder went out at
-- 08:00" is answerable for support and for debugging delivery. `variant`
-- records which of the two payloads was produced, which is what makes the
-- safeguard auditable: a run of `specific` rows for an account whose
-- preference is false would be a bug you can see from a query.
--
-- Deliberately absent: title, body, and any jsonb `payload` column. See the
-- header. There is no column here that a reminder's text fits in.
CREATE TABLE ops.notification_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES identity.account(id) ON DELETE CASCADE,

  kind            text NOT NULL,
  variant         text NOT NULL CHECK (variant IN ('generic','specific')),

  device_count    integer NOT NULL DEFAULT 0,
  delivered_count integer NOT NULL DEFAULT 0,
  failed_count    integer NOT NULL DEFAULT 0,

  -- 'fcm' in production, 'disabled' when the service is running without
  -- credentials. Recording the second case means a silent local-dev run is
  -- distinguishable from a provider outage after the fact.
  provider        text NOT NULL DEFAULT 'fcm',

  sent_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_log_account ON ops.notification_log(account_id, sent_at DESC);
CREATE INDEX notification_log_kind    ON ops.notification_log(kind, sent_at DESC);

-- A delivery record that can be edited afterwards is not evidence of anything.
-- DELETE stays available: the FK above cascades on account deletion, and
-- `export_and_delete` means that has to be able to complete.
CREATE RULE notification_log_no_update AS
  ON UPDATE TO ops.notification_log DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- ENABLE and FORCE, as everywhere else. FORCE is the half that matters: the
-- owning role is what migrations and maintenance scripts connect as, and
-- without FORCE it reads straight past every policy below.
--
-- The internal `POST /send` path is not an exception to this. It runs inside
-- `withPrincipal(recipientAccountId)` — the service is acting *for* the
-- recipient when it reads their devices — so a bug that loses track of whose
-- notification it is sending returns zero devices rather than somebody else's.

ALTER TABLE ops.device_token             ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.device_token             FORCE  ROW LEVEL SECURITY;
ALTER TABLE ops.notification_preference  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.notification_preference  FORCE  ROW LEVEL SECURITY;
ALTER TABLE ops.notification_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.notification_log         FORCE  ROW LEVEL SECURITY;

CREATE POLICY device_token_own ON ops.device_token
  USING (account_id = app_account_id())
  WITH CHECK (account_id = app_account_id());

CREATE POLICY notification_preference_own ON ops.notification_preference
  USING (account_id = app_account_id())
  WITH CHECK (account_id = app_account_id());

CREATE POLICY notification_log_own ON ops.notification_log
  USING (account_id = app_account_id())
  WITH CHECK (account_id = app_account_id());
