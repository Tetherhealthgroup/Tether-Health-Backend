-- 0009 · A database role per service, so that RLS applies to every one of them.
--
-- Why this exists (risk register R-032): every service was handed one shared
-- DSN, and the DSN in `render.yaml` is the project's superuser. A superuser
-- bypasses row-level security — FORCE included — so none of the policies in
-- 0003 to 0007 could fire, and a query that forgot its `WHERE account_id` read
-- or deleted another patient's rows. 0001's header promised "a role per
-- service" and 0004 created exactly one of them; this migration finishes the
-- job.
--
-- The shape, in two layers:
--
--   * NOLOGIN group roles `tether_<service>` hold every grant and are what each
--     policy names. Nothing connects as them.
--   * LOGIN roles `tether_<service>_login` are members of exactly one group.
--     They hold no privilege of their own, so a credential can be rotated by
--     replacing the login role without touching a single grant.
--
-- Every role below is created with PostgreSQL's defaults, which are NOSUPERUSER,
-- NOBYPASSRLS, NOCREATEDB, NOCREATEROLE and NOREPLICATION, and none of them owns
-- an object, so FORCE and ENABLE are both in play for all of them. The attributes
-- are deliberately NOT re-asserted with ALTER ROLE: a migrator that is not a
-- superuser (Supabase's `postgres`) may be refused an ALTER that names an
-- attribute it does not itself hold, even to switch it off. Instead a guard at
-- the end of this file RAISEs if any `tether_` role has ended up privileged, so
-- a role someone loosened by hand fails the next apply loudly rather than being
-- quietly tightened.
--
-- No password is set here, and none ever should be: a credential in a migration
-- is a credential in every clone of the repository. The login roles are also
-- created LOCKED (`VALID UNTIL '-infinity'`), so that a database whose
-- `pg_hba.conf` is permissive, or a deployment that forgets this step, does not
-- end up with nine passwordless accounts that can connect. The operator sets
-- the password and unlocks each role out of band; see `db/ROLES.md`.
--
-- Safe to run twice: roles are created only if absent. (The other two files
-- this branch adds are applied once, like any migration; 0010 is not
-- idempotent.)

-- ---------------------------------------------------------------------------
-- Group roles (NOLOGIN) — hold the privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  service text;
BEGIN
  -- `tether_auth` already exists, from 0004, and is deliberately left as that
  -- migration made it: NOLOGIN, with its policies and grants attached.
  FOREACH service IN ARRAY ARRAY[
    'auth', 'catalogue', 'enrolment', 'records', 'care_team',
    'notification', 'website', 'chronic', 'realtime'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tether_' || service) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', 'tether_' || service);
    END IF;

    -- `tether_auth` was created NOLOGIN by 0004 and is left exactly as it is.
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Login roles — hold the credential, and nothing else
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  service text;
  login   text;
BEGIN
  FOREACH service IN ARRAY ARRAY[
    'auth', 'catalogue', 'enrolment', 'records', 'care_team',
    'notification', 'website', 'chronic', 'realtime'
  ]
  LOOP
    login := 'tether_' || service || '_login';

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login) THEN
      -- Created locked. `ALTER ROLE ... PASSWORD` does not clear VALID UNTIL, so
      -- an operator who sets a password and forgets to unlock gets a clear
      -- authentication failure rather than a working login.
      EXECUTE format(
        'CREATE ROLE %I LOGIN VALID UNTIL %L IN ROLE %I',
        login, '-infinity', 'tether_' || service
      );
    END IF;

    -- LOGIN and INHERIT only. VALID UNTIL is deliberately NOT touched here:
    -- once an operator has unlocked a role, re-running this migration must not
    -- lock the service out of its own database.
    EXECUTE format('ALTER ROLE %I LOGIN INHERIT', login);

    -- Membership of exactly one group. Granted explicitly as well as by
    -- IN ROLE above, so that a role created by an earlier run of a different
    -- version of this file still ends up in the right place.
    EXECUTE format('GRANT %I TO %I', 'tether_' || service, login);
  END LOOP;
END
$$;

COMMENT ON ROLE tether_auth IS
  'NOLOGIN group: privileges of auth-service. Connect as tether_auth_login.';
COMMENT ON ROLE tether_catalogue IS
  'NOLOGIN group: privileges of catalogue-service. Connect as tether_catalogue_login.';
COMMENT ON ROLE tether_enrolment IS
  'NOLOGIN group: privileges of enrolment-service. Connect as tether_enrolment_login.';
COMMENT ON ROLE tether_records IS
  'NOLOGIN group: privileges of records-service. Connect as tether_records_login.';
COMMENT ON ROLE tether_care_team IS
  'NOLOGIN group: privileges of care-team-service. Connect as tether_care_team_login.';
COMMENT ON ROLE tether_notification IS
  'NOLOGIN group: privileges of notification-service. Connect as tether_notification_login.';
COMMENT ON ROLE tether_website IS
  'NOLOGIN group: privileges of website-service. Connect as tether_website_login.';
COMMENT ON ROLE tether_chronic IS
  'NOLOGIN group: privileges of chronic-service. Connect as tether_chronic_login.';
COMMENT ON ROLE tether_realtime IS
  'NOLOGIN group: privileges of realtime-service. Connect as tether_realtime_login.';

-- ---------------------------------------------------------------------------
-- Defence in depth against the Supabase API roles
-- ---------------------------------------------------------------------------

-- `supabase/config.toml` exposes every schema below through PostgREST, and a
-- hosted project may carry default privileges that hand new tables to `anon`
-- and `authenticated`. This service backend is the only intended path to these
-- schemas, so withdraw anything those two roles hold on them. A no-op where the
-- roles or the privileges are absent, and a no-op for the owner and for
-- `service_role`, which is the Supabase service key and which no service in
-- this repository may ever be handed.
DO $$
DECLARE
  api_role text;
  schema_name text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH schema_name IN ARRAY ARRAY[
        'identity', 'catalogue', 'programme', 'record', 'care', 'chronic', 'ops'
      ]
      LOOP
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', schema_name, api_role);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', schema_name, api_role);
        EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', schema_name, api_role);
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', schema_name, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Guard: no tether_ role may be privileged
-- ---------------------------------------------------------------------------

-- Fails the migration, and so rolls the transaction back, if a `tether_` role is
-- a superuser, bypasses RLS, can replicate, or can create roles or databases.
-- That is how a pre-existing role of the same name that someone made powerful, or
-- a platform that hands every new role an attribute, is caught on the apply that
-- would have trusted it.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO offender
    FROM pg_roles
   WHERE rolname LIKE 'tether\_%'
     AND (rolsuper OR rolbypassrls OR rolreplication OR rolcreaterole OR rolcreatedb);

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'service role(s) hold a privileged attribute: %', offender
      USING HINT = 'A service role must not be SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE or CREATEDB.';
  END IF;
END
$$;
