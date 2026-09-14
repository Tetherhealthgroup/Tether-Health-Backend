-- 0004 · Refresh sessions.
--
-- One table, and the whole of it exists to make a stolen refresh token
-- survivable.
--
-- The design is lifted from the Go auth service in AmericanGroupLLC-Backend,
-- which is the one thing that repo did excellently and the one thing worth
-- copying wholesale. Three properties, each of which is a column here:
--
--   1. The token is never stored. Only `sha256(token)` is, so a dump of this
--      table is not a set of working credentials. The plaintext exists in one
--      HTTP response and in the client's keychain, and nowhere else.
--
--   2. Rotation. Presenting a refresh token issues a new one and revokes the
--      presented one, so a token is a single-use object with a short window.
--
--   3. Family reuse detection — `family_id`. Every token descended from one
--      sign-in shares a family. Rotation is what makes theft detectable:
--      exactly one of the thief and the legitimate client will present a token
--      that has already been rotated away, and whichever of them does, the
--      correct response is the same. Kill the family. Both parties are signed
--      out, the real user signs in again, and the thief's whole lineage is dead
--      — which is strictly better than the alternative, where a silent
--      attacker rotates forever alongside the victim and nothing ever notices.

-- ---------------------------------------------------------------------------
-- The auth service's role
-- ---------------------------------------------------------------------------

-- 0001's header describes "a role per service" but creates none, so this
-- creates the one this migration's policies name. Guarded, and idempotent:
-- when whichever migration eventually owns role creation lands, this becomes a
-- no-op rather than a collision. NOLOGIN — the deployment grants LOGIN and a
-- password out of band, because a credential committed to a migration is a
-- credential in every clone of the repo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tether_auth') THEN
    CREATE ROLE tether_auth NOLOGIN;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- identity.refresh_session
-- ---------------------------------------------------------------------------

CREATE TABLE identity.refresh_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, not SET NULL. `DELETE /me` must leave nothing behind that is
  -- attributable to the person, and a session row with a null account is still
  -- an IP address, a user agent and a timestamp.
  account_id    uuid NOT NULL REFERENCES identity.account(id) ON DELETE CASCADE,

  -- Every token descended from one sign-in. Not a foreign key to anything:
  -- the family has no row of its own, because it has no state beyond the
  -- sessions that carry its id, and a `family` table would be a second place
  -- for "is this family revoked" to be true.
  family_id     uuid NOT NULL,

  -- Lowercase hex SHA-256 of the 32 random bytes handed to the client.
  --
  -- Plain SHA-256 rather than bcrypt/argon2, deliberately. Those exist to make
  -- guessing a *low-entropy human-chosen* secret expensive; this input is 256
  -- bits from a CSPRNG, which is not guessable at any cost, and a slow hash on
  -- the refresh path would only be a self-inflicted denial of service. The
  -- CHECK pins the encoding so a future caller cannot start storing base64 into
  -- the same column and quietly defeat the UNIQUE constraint.
  token_hash    text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,

  revoked_at    timestamptz,
  revoked_reason text CHECK (revoked_reason IN (
                    'rotated',          -- used, replaced by its successor
                    'signed-out',       -- DELETE /sessions
                    'reuse-detected',   -- the family was killed; see above
                    'expired',          -- presented after expires_at
                    'account-closed'    -- DELETE /me
                  )),

  -- Not identity, and not trusted. Context for the human reading an incident:
  -- "the reused token came from a different device and a different country" is
  -- the difference between a stolen token and a client with a race condition.
  user_agent    text,
  ip            inet,

  -- The lookup on every single refresh, and the index the spec asks for: a
  -- UNIQUE constraint *is* a unique index, so adding a second index on the same
  -- column would only be a second thing to keep in sync. Named explicitly
  -- rather than left to Postgres's `<table>_<column>_key` generator, so nothing
  -- downstream depends on a generated string.
  CONSTRAINT refresh_session_token_hash_key UNIQUE (token_hash),

  -- A revoked row that does not say why is a row nobody can act on.
  CONSTRAINT refresh_session_revocation_complete
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),

  CONSTRAINT refresh_session_expires_after_issue
    CHECK (expires_at > issued_at)
);

-- Reuse detection revokes by family, and it does so on the request that is
-- already known to be an incident. A sequential scan there is a scan while an
-- attacker holds a live token.
CREATE INDEX refresh_session_family ON identity.refresh_session(family_id);

-- Postgres does not index a foreign key for you. Without this, `DELETE /me`
-- scans the whole table to find the rows to cascade — on the one endpoint whose
-- contract is that it returns only after the rows are gone.
CREATE INDEX refresh_session_account ON identity.refresh_session(account_id);

-- For the purge job. Partial, because revoked rows are not what it looks for
-- and there will eventually be far more of them than live ones.
CREATE INDEX refresh_session_live_expiry
  ON identity.refresh_session(expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- ENABLE and FORCE, as on every other table that gates access to a person.
-- FORCE is the half the model repo omitted; without it the owning role, which
-- is what migrations and maintenance scripts connect as, bypasses everything
-- below.
ALTER TABLE identity.refresh_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.refresh_session FORCE  ROW LEVEL SECURITY;

-- The choice, stated: deny-all for everyone, plus one role that may act.
--
-- The other tables in this schema use `account_id = app_account_id()`, because
-- their rows belong to the account reading them. That policy would be wrong
-- here, and dangerously close to right. Two of the three operations this table
-- exists for happen when the reader's identity is *not yet established* — the
-- whole point of presenting a refresh token is that you have no valid access
-- token, so `app.account_id` is unset and an account-scoped policy would match
-- nothing. The third, reuse detection, must revoke rows belonging to a family
-- while the caller has actively failed to prove they own it.
--
-- So this table is not user-scoped at all. It is service-scoped: only
-- `tether_auth` ever touches it, and the policy says exactly that. Anything
-- else reaching this database — another service's role, a connection with a
-- principal set, a psql session as the owner — matches `false` and sees an
-- empty table. That is a smaller and more honest grant than `app_account_id()`,
-- which would read like a user-ownership rule while never actually firing.
CREATE POLICY refresh_session_deny_all ON identity.refresh_session
  FOR ALL TO PUBLIC
  USING (false) WITH CHECK (false);

-- Permissive policies are OR'd, so this is the one that grants. Scoped to the
-- role rather than written as `USING (true)` for everyone, because FORCE means
-- the owner is subject to policies too and a blanket `true` would hand the
-- table back to every role that has been granted SELECT on it.
CREATE POLICY refresh_session_auth_service ON identity.refresh_session
  FOR ALL TO tether_auth
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- What the auth service, and only the auth service, needs to do its job. It
-- reads no PHI: there is no grant here on `programme`, `record`, `care` or
-- `chronic`, and adding one would mean the identity service had become able to
-- read a health answer.
GRANT USAGE ON SCHEMA identity, ops TO tether_auth;

-- Accounts: created on first sign-in, read by `GET /me`, removed by
-- `DELETE /me` (which is what triggers the cascade through enrolments into the
-- record tables).
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.account TO tether_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.refresh_session TO tether_auth;

-- INSERT only. `ops.audit_event` carries the proof that a deletion completed,
-- and 0001 already forbids UPDATE and DELETE on it by rule; withholding the
-- privilege as well means the service cannot even attempt it.
GRANT INSERT ON ops.audit_event TO tether_auth;
