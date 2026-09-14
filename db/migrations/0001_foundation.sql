-- 0001 · Foundation: schemas, roles, and the identity every other table hangs off.
--
-- A schema per bounded context, and a role per service. The repo this is
-- modelled on put 149 tables in one `public` schema and handed every service the
-- same superuser DSN, so a bug in its travel service could read its health
-- tables. Separation here is enforced by the database rather than by everyone
-- remembering.

BEGIN;

CREATE SCHEMA IF NOT EXISTS identity;    -- accounts, guardians, sessions
CREATE SCHEMA IF NOT EXISTS catalogue;   -- the design bundle. Non-PHI.
CREATE SCHEMA IF NOT EXISTS programme;   -- enrolment and consent
CREATE SCHEMA IF NOT EXISTS record;      -- PHI: answers, lapses, observations
CREATE SCHEMA IF NOT EXISTS care;        -- the clinician surface
CREATE SCHEMA IF NOT EXISTS chronic;     -- chronic-care's own entities
CREATE SCHEMA IF NOT EXISTS ops;         -- audit, waitlist, notifications

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The account the current transaction is acting for.
--
-- Set by `@tether/core`'s `withPrincipal` via `set_config('app.account_id', …,
-- true)` — transaction-local, so a pooled connection cannot carry one request's
-- identity into the next. Every RLS policy below reads this.
--
-- Returns NULL rather than raising when unset, so a non-PHI query on a
-- connection with no principal simply matches nothing.
CREATE OR REPLACE FUNCTION app_account_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.account_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END
$$;

-- ---------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------

CREATE TABLE identity.account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     text UNIQUE NOT NULL,          -- the IdP's subject claim
  email           citext UNIQUE,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz
);

CREATE TRIGGER account_updated_at BEFORE UPDATE ON identity.account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A child does not get an account.
--
-- Addendum §3.2: "The child does not get an account. Provision as: guardian's
-- Tether account → child profile → child device paired via code." So a child
-- profile is a row owned by a guardian's account, never an `identity.account`
-- of its own — which also means a child cannot authenticate, by construction.
CREATE TABLE identity.child_profile (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id       uuid NOT NULL REFERENCES identity.account(id) ON DELETE CASCADE,
  display_name      text NOT NULL,
  birth_year        smallint,
  pairing_code      text UNIQUE,
  paired_at         timestamptz,

  -- COPPA consent is recorded as a reference to the guardian's verified
  -- consent, not re-collected here. §3.2: "don't build a second consent
  -- mechanism."
  coppa_consent_ref text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX child_profile_guardian ON identity.child_profile(guardian_id);

CREATE TRIGGER child_profile_updated_at BEFORE UPDATE ON identity.child_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ops.audit_event
-- ---------------------------------------------------------------------------

-- Append-only, and the deletion record outlives the data it describes.
--
-- `PRODUCTION_RELEASE_CHECKLIST.md`: "Implement verified exports and deletion
-- with auditable completion." An audit row that cascaded away with the account
-- would make the one event most worth proving unprovable, so `account_id` is
-- deliberately NOT a foreign key.
CREATE TABLE ops.audit_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    uuid,
  actor_role    text,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  programme_id  uuid,
  request_id    text,
  ip_address    inet,
  user_agent    text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_account ON ops.audit_event(account_id, occurred_at DESC);
CREATE INDEX audit_event_action  ON ops.audit_event(action, occurred_at DESC);

-- No UPDATE, no DELETE. An audit trail that can be edited is a log.
CREATE RULE audit_event_no_update AS ON UPDATE TO ops.audit_event DO INSTEAD NOTHING;
CREATE RULE audit_event_no_delete AS ON DELETE TO ops.audit_event DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- ops.waitlist_enquiry
-- ---------------------------------------------------------------------------

-- The website's only payload: {name, email, role, interest, message}.
--
-- `purge_after` is not decoration. privacy.astro is already published and
-- binding: "We keep early-access enquiries until the relevant product has
-- launched and we have contacted you, or for two years, whichever comes first."
-- The column makes that promise a scheduled job rather than an intention.
CREATE TABLE ops.waitlist_enquiry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       citext NOT NULL,
  role        text,
  interest    text,
  message     text,
  source      text NOT NULL DEFAULT 'website',
  received_at timestamptz NOT NULL DEFAULT now(),
  contacted_at timestamptz,
  purge_after timestamptz NOT NULL DEFAULT (now() + interval '2 years')
);

CREATE INDEX waitlist_purge ON ops.waitlist_enquiry(purge_after);

COMMIT;
