#!/usr/bin/env bash
# OPS-021 · Local rehearsal of the production migration-history plan.
#
# See docs/MIGRATION_HISTORY_PLAN.md. This script is LOCAL ONLY. It starts its
# own disposable Supabase stack (Docker) from a temporary project directory,
# on ports that are not the CLI defaults, and it never links, pushes or
# queries a hosted project.
#
#   rehearse         Plan section 4. Apply Tether-Health's 9 migrations, seed
#                    SYNTHETIC users, apply Backend's 12 migrations re-versioned
#                    to sort after 202610030001, then assert that nothing the
#                    live project holds was dropped, renamed or rewritten.
#   probe-ordering   Plan section 3. Put Backend's 12 migrations at their
#                    CURRENT (older) versions next to the applied 9 and record,
#                    verbatim, what the local CLI does. Observation only.
#
# Needs: bash, git, psql, docker, the supabase CLI. None of them is run by the
# agent that wrote this file (no Docker on that machine): the run is an owner
# check, see plan section 11.
#
# Environment:
#   PGPASSWORD            required. The password of the LOCAL stack's postgres
#                         role. This file never contains it.
#   TETHER_HEALTH_REPO    required. Path to a Tether-Health clone. Its 9
#                         migrations are read with `git show origin/develop:`.
#   PGHOST                optional, loopback only (127.0.0.1, localhost, ::1).
#   REHEARSAL_VERSION_DATE optional, 8 digits, default 20261015. The date prefix
#                         the Backend files are re-versioned to.
#   KEEP_STACK=1          leave the local stack running afterwards.
#
# Exit status: 0 only when every assertion passed. 2 for a refusal.

set -euo pipefail

MODE="${1:-}"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LOCAL_DB_PORT=55322
LOCAL_API_PORT=55321
LOCAL_SHADOW_PORT=55320
LOCAL_PROJECT_ID="ops021-rehearsal"
DB_USER=postgres
DB_NAME=postgres

# BASELINE.md:100 and OPS-021.md:18: the applied remote versions.
EXPECTED_TETHER_VERSIONS="202609110001 202609150001 202609150002 202609150003 202609150004 202609150005 202609200001 202609260001 202610030001"
NEWEST_TETHER_VERSION=202610030001

# Synthetic identities. example.invalid is reserved (RFC 2606) and never routes.
USER_A=00000000-0000-4000-8000-0000000000a1
USER_B=00000000-0000-4000-8000-0000000000b2
USER_C=00000000-0000-4000-8000-0000000000c3
ENROLMENT_A=00000000-0000-4000-8000-0000000000e1
ENROLMENT_B=00000000-0000-4000-8000-0000000000e2

# 3 Tether-Health tables + 19 Backend tables (plan section 6.5). A different
# count means a table was added or removed: re-read the plan before trusting it.
EXPECTED_FORCED_TABLES=22

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${PGHOST:-127.0.0.1}"
VERSION_DATE="${REHEARSAL_VERSION_DATE:-20261015}"
WORKDIR=""
TEMP_FILES=""
FAILURES=0
CHECKS=0

# ---------------------------------------------------------------------------
# Guards: refuse anything that is not a local, disposable stack
# ---------------------------------------------------------------------------

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 2
}

case "$MODE" in
  rehearse | probe-ordering) ;;
  *) refuse "usage: $0 rehearse | probe-ordering" ;;
esac

case "$HOST" in
  127.0.0.1 | localhost | ::1) ;;
  *) refuse "PGHOST must be a loopback address, got a non-local host" ;;
esac

# Variables that make libpq or the CLI connect somewhere else, or that carry a
# hosted credential. Their presence is refused, not ignored.
for name in DATABASE_URL PGSERVICE PGSERVICEFILE PGHOSTADDR SUPABASE_DB_URL SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_ID; do
  if [ -n "${!name:-}" ]; then
    refuse "$name is set; unset it so nothing can be redirected to a hosted project"
  fi
done

if [ -n "${PGPORT:-}" ] && [ "$PGPORT" != "$LOCAL_DB_PORT" ]; then
  refuse "PGPORT must be unset or $LOCAL_DB_PORT (the rehearsal stack's own port)"
fi
export PGPORT="$LOCAL_DB_PORT"

[ -n "${PGPASSWORD:-}" ] || refuse "PGPASSWORD (the local stack's password) must be set in the environment"
[ -n "${TETHER_HEALTH_REPO:-}" ] || refuse "TETHER_HEALTH_REPO must point at a Tether-Health clone"
git -C "$TETHER_HEALTH_REPO" rev-parse --verify --quiet origin/develop > /dev/null \
  || refuse "origin/develop not found in TETHER_HEALTH_REPO"

case "$VERSION_DATE" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) refuse "REHEARSAL_VERSION_DATE must be 8 digits" ;;
esac

for tool in psql supabase docker git; do
  command -v "$tool" > /dev/null || refuse "$tool is not installed"
done

# Something already listening on the rehearsal port is somebody else's database.
# Never reset, overwrite or stop it.
if (exec 3<> "/dev/tcp/127.0.0.1/$LOCAL_DB_PORT") 2> /dev/null; then
  refuse "port $LOCAL_DB_PORT is already in use; this script only ever creates its own stack"
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

psql_local() {
  psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$HOST" -p "$LOCAL_DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"
}

say() {
  printf '%s\n' "$*"
}

cleanup() {
  if [ -n "$TEMP_FILES" ]; then
    # Two mktemp paths, no spaces: word splitting is intended.
    # shellcheck disable=SC2086
    rm -f -- $TEMP_FILES
  fi
  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    if [ "${KEEP_STACK:-0}" != "1" ]; then
      supabase stop --no-backup --workdir "$WORKDIR" > /dev/null 2>&1 || true
      rm -r -- "$WORKDIR"
    else
      say "KEEP_STACK=1: stack left running, project directory $WORKDIR"
    fi
  fi
}
trap cleanup EXIT

check() {
  # check LABEL EXPECTED ACTUAL
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then
    say "PASS  $1"
  else
    FAILURES=$((FAILURES + 1))
    say "FAIL  $1 (expected '$2', got '$3')"
  fi
}

expect_error() {
  # expect_error LABEL PATTERN  (SQL on stdin; must fail with PATTERN in stderr)
  local label="$1" pattern="$2" err
  CHECKS=$((CHECKS + 1))
  if err="$(psql_local 2>&1 > /dev/null)"; then
    FAILURES=$((FAILURES + 1))
    say "FAIL  $label (statement succeeded; it must be refused)"
  elif printf '%s' "$err" | grep -q "$pattern"; then
    say "PASS  $label"
  else
    FAILURES=$((FAILURES + 1))
    say "FAIL  $label (failed, but not with '$pattern')"
  fi
}

# Run SQL as a Supabase API role carrying a synthetic JWT subject.
as_authenticated() {
  # as_authenticated USER_UUID  (SQL on stdin; prints the last result)
  local sub="$1"
  {
    printf "begin;\nset local role authenticated;\n"
    printf "select set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true) as x \\\\gset\n" "$sub"
    cat
    printf "\nrollback;\n"
  } | psql_local
}

# Run SQL as a Backend group role with a principal (or none: pass "-").
as_service() {
  # as_service ROLE ACCOUNT_UUID|-  (SQL on stdin)
  local role="$1" account="$2"
  {
    printf 'begin;\nset local role %s;\n' "$role"
    if [ "$account" != "-" ]; then
      printf "select set_config('app.account_id', '%s', true) as x \\\\gset\n" "$account"
    fi
    cat
    printf "\nrollback;\n"
  } | psql_local
}

new_version() {
  # 20260914120000 -> <VERSION_DATE>120000: same time-of-day, so order is kept.
  printf '%s%s' "$VERSION_DATE" "${1:8}"
}

# ---------------------------------------------------------------------------
# Disposable project directory and stack
# ---------------------------------------------------------------------------

write_config() {
  cat > "$WORKDIR/supabase/config.toml" << TOML
project_id = "$LOCAL_PROJECT_ID"

[api]
enabled = true
port = $LOCAL_API_PORT

[db]
port = $LOCAL_DB_PORT
shadow_port = $LOCAL_SHADOW_PORT
major_version = 16

[db.pooler]
enabled = false

[studio]
enabled = false

[inbound_email]
enabled = false

[analytics]
enabled = false

# Backend's own supabase/config.toml has storage disabled, which would make
# Tether-Health's 202609110001 (it inserts into storage.buckets) impossible to
# apply. The rehearsal needs the storage schema, so it is enabled here only.
[storage]
enabled = true

[auth]
enabled = true
TOML
}

copy_tether_migrations() {
  local path name count=0 expected="" version
  while IFS= read -r path; do
    name="${path##*/}"
    git -C "$TETHER_HEALTH_REPO" show "origin/develop:$path" > "$WORKDIR/supabase/migrations/$name"
    version="${name%%_*}"
    expected="$expected $version"
    count=$((count + 1))
  done < <(git -C "$TETHER_HEALTH_REPO" ls-tree --name-only origin/develop supabase/migrations/)
  expected="${expected# }"
  [ "$count" -eq 9 ] || refuse "expected 9 Tether-Health migrations on origin/develop, found $count"
  [ "$expected" = "$EXPECTED_TETHER_VERSIONS" ] || refuse "Tether-Health versions differ from the plan: $expected"
  say "Tether-Health origin/develop at $(git -C "$TETHER_HEALTH_REPO" rev-parse origin/develop): 9 migrations copied"
}

copy_backend_migrations() {
  # copy_backend_migrations renamed|original
  local style="$1" file name version target count=0
  for file in "$ROOT"/supabase/migrations/*.sql; do
    name="${file##*/}"
    version="${name%%_*}"
    if [ "$style" = "renamed" ]; then
      target="$(new_version "$version")_${name#*_}"
      # Must sort after the newest applied version as a string AND as a number,
      # because which comparison the CLI uses is Unknown (plan section 3).
      # A string comparison on purpose (SC2071): that is the comparison in question.
      # shellcheck disable=SC2071
      [[ "${target%%_*}" > "$NEWEST_TETHER_VERSION" ]] || refuse "re-versioned $target does not sort after $NEWEST_TETHER_VERSION as a string"
      [ "${target%%_*}" -gt "$NEWEST_TETHER_VERSION" ] || refuse "re-versioned $target is not greater than $NEWEST_TETHER_VERSION as a number"
    else
      target="$name"
    fi
    cp "$file" "$WORKDIR/supabase/migrations/$target"
    count=$((count + 1))
  done
  [ "$count" -eq 12 ] || refuse "expected 12 Backend migrations in $ROOT/supabase/migrations, found $count"
  say "Backend migrations copied as '$style': $count files"
}

start_stack() {
  WORKDIR="$(mktemp -d)"
  mkdir -p "$WORKDIR/supabase/migrations"
  write_config
  copy_tether_migrations
  say "Starting the disposable stack (project_id $LOCAL_PROJECT_ID, db port $LOCAL_DB_PORT)"
  supabase start --workdir "$WORKDIR"
  # Fresh stack, fresh data: if either differs this is not the stack we made.
  check "stack starts empty (auth.users rows)" "0" "$(psql_local -c 'select count(*) from auth.users')"
  check "ledger holds exactly the 9 Tether-Health versions" "$EXPECTED_TETHER_VERSIONS" \
    "$(psql_local -c "select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations")"
}

# ---------------------------------------------------------------------------
# Synthetic data
# ---------------------------------------------------------------------------

seed_tether() {
  # Everything here is invented. Addresses are example.invalid; ids are fixed.
  psql_local << SQL
insert into auth.users (id, instance_id, aud, role, email) values
  ('$USER_A', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'synthetic-a@example.invalid'),
  ('$USER_B', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'synthetic-b@example.invalid'),
  ('$USER_C', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'synthetic-c@example.invalid');

-- auth_user_created_profile (202609110001:57-59) has created the profile rows.
update public.profiles set display_name = 'Synthetic A', avatar_path = id::text || '/avatar.png' where id = '$USER_A';
update public.profiles set display_name = 'Synthetic B' where id = '$USER_B';

insert into public.quit_plans (user_id, quit_date) values
  ('$USER_A', '2026-12-01'), ('$USER_B', '2026-12-02'), ('$USER_C', '2026-12-03');

insert into public.program_data (user_id, program_id, payload) values
  ('$USER_A', 'heartwise', '{"synthetic": true}'),
  ('$USER_B', 'steady',    '{"synthetic": true}'),
  ('$USER_C', 'clearair',  '{"synthetic": true}');

insert into storage.objects (bucket_id, name) values
  ('avatars', '$USER_A/avatar.png'),
  ('avatars', '$USER_B/avatar.png');
SQL
}

seed_backend() {
  psql_local << SQL
insert into catalogue.area (id, name, scope, status, position)
  values ('synthetic-area', 'Synthetic Area', 'synthetic', 'design', 1);

insert into identity.account (id, external_id, email) values
  ('$USER_A', 'synthetic-ext-a', 'synthetic-a@example.invalid'),
  ('$USER_B', 'synthetic-ext-b', 'synthetic-b@example.invalid');

insert into programme.enrolment (id, account_id, area_id) values
  ('$ENROLMENT_A', '$USER_A', 'synthetic-area'),
  ('$ENROLMENT_B', '$USER_B', 'synthetic-area');

insert into record.lapse_event (enrolment_id, occurred_at, severity) values
  ('$ENROLMENT_A', now(), 'synthetic'),
  ('$ENROLMENT_B', now(), 'synthetic');
SQL
}

# ---------------------------------------------------------------------------
# Snapshot of everything the plan promises not to touch (plan section 6)
# ---------------------------------------------------------------------------

snapshot() {
  psql_local << 'SQL' | LC_ALL=C sort
select 'count.auth_users|' || count(*) from auth.users;
select 'count.profiles|' || count(*) from public.profiles;
select 'count.quit_plans|' || count(*) from public.quit_plans;
select 'count.program_data|' || count(*) from public.program_data;
select 'count.avatar_objects|' || count(*) from storage.objects where bucket_id = 'avatars';
select 'rows.profiles|' || coalesce(md5(string_agg(p::text, E'\n' order by p.id)), '') from public.profiles p;
select 'rows.quit_plans|' || coalesce(md5(string_agg(q::text, E'\n' order by q.user_id)), '') from public.quit_plans q;
select 'rows.program_data|' || coalesce(md5(string_agg(d::text, E'\n' order by d.user_id, d.program_id)), '') from public.program_data d;

select 'bucket.avatars|' || id || ',' || public || ',' || coalesce(file_size_limit::text, '') || ',' || coalesce(allowed_mime_types::text, '')
  from storage.buckets where id = 'avatars';

select 'force.' || c.relname || '|' || c.relrowsecurity || ',' || c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('profiles', 'quit_plans', 'program_data');

select 'def.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('delete_my_app_data', 'begin_account_deletion', 'avatar_write_allowed',
                     'save_program_data', 'set_updated_at', 'handle_new_auth_user',
                     'is_valid_support_people', 'is_unique_text_array');

select 'acl.function.' || p.proname || '|' || coalesce(p.proacl::text, '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('delete_my_app_data', 'begin_account_deletion', 'avatar_write_allowed',
                     'save_program_data', 'set_updated_at', 'handle_new_auth_user',
                     'is_valid_support_people', 'is_unique_text_array');

select 'policies.public|' || md5(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), E'\n' order by tablename, policyname))
  from pg_policies where schemaname = 'public' and tablename in ('profiles', 'quit_plans', 'program_data');
select 'policies.public.count|' || count(*)
  from pg_policies where schemaname = 'public' and tablename in ('profiles', 'quit_plans', 'program_data');

select 'policies.avatars|' || md5(string_agg(format('%s|%s|%s|%s|%s', policyname, cmd, roles, qual, with_check), E'\n' order by policyname))
  from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars\_%';
select 'policies.avatars.count|' || count(*)
  from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars\_%';

select 'triggers.auth_users|' || coalesce(md5(string_agg(pg_get_triggerdef(oid), E'\n' order by tgname)), '')
  from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
select 'trigger.name.' || tgname || '|present'
  from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
select 'triggers.public_tables|' || md5(string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.tgname))
  from pg_trigger t
 where t.tgrelid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
   and not t.tgisinternal;

select 'columns.' || c.relname || '|' || md5(string_agg(format('%s|%s|%s|%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '')), E'\n' order by a.attnum))
  from pg_class c
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
 where c.oid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
 group by c.relname;

select 'constraints.' || conrelid::regclass::text || '|' || md5(string_agg(conname || ':' || pg_get_constraintdef(oid), E'\n' order by conname))
  from pg_constraint
 where conrelid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
 group by conrelid;

select 'acl.table.' || c.relname || '|' || coalesce(c.relacl::text, '')
  from pg_class c where c.oid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass);
select 'acl.columns.' || c.relname || '|' || coalesce(md5(string_agg(a.attname || ':' || a.attacl::text, E'\n' order by a.attname)), '')
  from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attacl is not null
 where c.oid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
 group by c.relname;

select 'ledger.first9|' || string_agg(version, ' ' order by version)
  from (select version from supabase_migrations.schema_migrations order by version limit 9) v;
SQL
}

compare_snapshots() {
  # compare_snapshots BEFORE AFTER: one verdict per key, both files are sorted.
  local before="$1" after="$2" key before_value after_value
  while IFS='|' read -r key before_value; do
    after_value="$(awk -F'|' -v k="$key" '$1 == k { print substr($0, length(k) + 2); exit }' "$after")"
    check "unchanged: $key" "$before_value" "$after_value"
  done < "$before"
  # A key that exists only afterwards is a new object where none was promised.
  while IFS= read -r key; do
    if ! awk -F'|' -v k="$key" '$1 == k { found = 1 } END { exit !found }' "$before"; then
      CHECKS=$((CHECKS + 1))
      FAILURES=$((FAILURES + 1))
      say "FAIL  unexpected new protected key after the Backend chain: $key"
    fi
  done < <(cut -d'|' -f1 "$after")
}

# ---------------------------------------------------------------------------
# rehearse
# ---------------------------------------------------------------------------

assert_post_state() {
  local offenders forced rolebypass

  say
  say "== recorded for R-061(a): the migrator role and FORCE on every app table =="
  rolebypass="$(psql_local -c "select rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls from pg_roles where rolname = current_user")"
  say "migrator: $rolebypass"
  psql_local -c "
    select n.nspname || '.' || c.relname || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and (n.nspname in ('identity', 'programme', 'record', 'care', 'chronic', 'ops')
            or (n.nspname = 'public' and c.relname in ('profiles', 'quit_plans', 'program_data')))
     order by 1"

  say
  say "== FORCE ROW LEVEL SECURITY on every PHI table (Tether-Health's and Backend's) =="
  offenders="$(psql_local -c "
    select coalesce(string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname, c.relname), '')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and (n.nspname in ('identity', 'programme', 'record', 'care', 'chronic', 'ops')
            or (n.nspname = 'public' and c.relname in ('profiles', 'quit_plans', 'program_data')))
       and not (c.relrowsecurity and c.relforcerowsecurity)")"
  check "no PHI table lacks ENABLE + FORCE (offenders)" "" "$offenders"
  forced="$(psql_local -c "
    select count(*)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and c.relrowsecurity and c.relforcerowsecurity
       and (n.nspname in ('identity', 'programme', 'record', 'care', 'chronic', 'ops')
            or (n.nspname = 'public' and c.relname in ('profiles', 'quit_plans', 'program_data')))")"
  check "number of tables with ENABLE + FORCE" "$EXPECTED_FORCED_TABLES" "$forced"

  say
  say "== cross-user reads fail closed: Tether-Health tables (API role authenticated) =="
  check "user B sees their own profile (the query is not vacuous)" "1" \
    "$(as_authenticated "$USER_B" <<< "select count(*) from public.profiles where id = '$USER_B';")"
  check "user B reads user A's profile" "0" \
    "$(as_authenticated "$USER_B" <<< "select count(*) from public.profiles where id = '$USER_A';")"
  check "user B reads user A's quit plan" "0" \
    "$(as_authenticated "$USER_B" <<< "select count(*) from public.quit_plans where user_id = '$USER_A';")"
  check "user B reads user A's program data" "0" \
    "$(as_authenticated "$USER_B" <<< "select count(*) from public.program_data where user_id = '$USER_A';")"
  check "user B reads user A's avatar object" "0" \
    "$(as_authenticated "$USER_B" <<< "select count(*) from storage.objects where bucket_id = 'avatars' and name like '$USER_A/%';")"
  check "user B sees their own avatar object (not vacuous)" "1" \
    "$(as_authenticated "$USER_B" <<< "select count(*) from storage.objects where bucket_id = 'avatars' and name like '$USER_B/%';")"
  check "user B updates user A's profile (rows changed)" "0" \
    "$(as_authenticated "$USER_B" <<< "with u as (update public.profiles set display_name = 'x' where id = '$USER_A' returning 1) select count(*) from u;")"
  expect_error "anon cannot read public.profiles" "permission denied" << 'SQL'
begin;
set local role anon;
select count(*) from public.profiles;
SQL

  say
  say "== cross-user reads fail closed: Backend tables (service group role + principal) =="
  # postgres may be a member of the group roles without the SET option. This is a
  # fixture step on the disposable stack only.
  psql_local -c "grant tether_records to $DB_USER with set true"
  check "principal A sees their enrolment (not vacuous)" "1" \
    "$(as_service tether_records "$USER_A" <<< "select count(*) from programme.enrolment where id = '$ENROLMENT_A';")"
  check "principal B reads A's enrolment" "0" \
    "$(as_service tether_records "$USER_B" <<< "select count(*) from programme.enrolment where id = '$ENROLMENT_A';")"
  check "principal B reads A's lapse events" "0" \
    "$(as_service tether_records "$USER_B" <<< "select count(*) from record.lapse_event where enrolment_id = '$ENROLMENT_A';")"
  check "no principal set: enrolments visible" "0" \
    "$(as_service tether_records - <<< "select count(*) from programme.enrolment;")"
  check "no principal set: lapse events visible" "0" \
    "$(as_service tether_records - <<< "select count(*) from record.lapse_event;")"

  say
  say "== the deletion functions still work (rolled back; user C is synthetic) =="
  check "begin_account_deletion returns true" "t" \
    "$(as_authenticated "$USER_C" <<< "select public.begin_account_deletion('DELETE');")"
  # The two calls run in one transaction that is rolled back, so nothing persists.
  local deleted
  deleted="$({
    printf "begin;\nset local role authenticated;\n"
    printf "select set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true) as x \\\\gset\n" "$USER_C"
    printf "select public.begin_account_deletion('DELETE') as b \\\\gset\n"
    printf "select public.delete_my_app_data('DELETE');\nrollback;\n"
  } | psql_local)"
  check "delete_my_app_data removes user C's three rows" \
    '{"profiles": 1, "quit_plans": 1, "program_data": 1}' "$deleted"
  check "user C's rows are still there after the rollback" "1,1,1" \
    "$(psql_local -c "select (select count(*) from public.profiles where id = '$USER_C') || ',' || (select count(*) from public.quit_plans where user_id = '$USER_C') || ',' || (select count(*) from public.program_data where user_id = '$USER_C')")"

  say
  say "== ledger =="
  check "ledger holds 9 + 12 versions" "21" \
    "$(psql_local -c 'select count(*) from supabase_migrations.schema_migrations')"
}

run_rehearse() {
  local before after
  before="$(mktemp)"
  after="$(mktemp)"
  TEMP_FILES="$before $after"

  say "== 1. apply Tether-Health's 9 migrations =="
  start_stack

  say
  say "== 2. seed synthetic users =="
  seed_tether
  snapshot > "$before"
  say "snapshot taken: $(wc -l < "$before" | tr -d ' ') keys"
  grep -E '^count\.' "$before"

  say
  say "== 3. apply the Backend chain, re-versioned to sort after $NEWEST_TETHER_VERSION =="
  copy_backend_migrations renamed
  supabase migration list --local --workdir "$WORKDIR"
  supabase migration up --local --workdir "$WORKDIR"
  seed_backend
  snapshot > "$after"

  say
  say "== 4. nothing the live project holds changed =="
  compare_snapshots "$before" "$after"
  assert_post_state

  say
  say "Checks: $CHECKS, failed: $FAILURES"
  if [ "$FAILURES" -ne 0 ]; then
    say "RESULT: FAIL"
    exit 1
  fi
  say "RESULT: PASS"
}

# ---------------------------------------------------------------------------
# probe-ordering: record what the CLI does with local versions that are older
# than the newest applied version. Observation only, no assertions.
# ---------------------------------------------------------------------------

ledger_versions() {
  psql_local -c "select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations"
}

probe() {
  # probe LABEL COMMAND...
  local label="$1" status=0
  shift
  say
  say "---- $label"
  say "command: $*"
  "$@" || status=$?
  say "exit status: $status"
  say "ledger after: $(ledger_versions)"
}

run_probe() {
  say "== probe: Backend's 12 migrations at their CURRENT versions, next to the applied 9 =="
  start_stack
  copy_backend_migrations original

  probe "list" supabase migration list --local --workdir "$WORKDIR"
  probe "db push dry run" supabase db push --local --dry-run --workdir "$WORKDIR"
  probe "migration up, no flags" supabase migration up --local --workdir "$WORKDIR"
  probe "db push, no flags" supabase db push --local --workdir "$WORKDIR"
  probe "db push --include-all" supabase db push --local --include-all --workdir "$WORKDIR"
  say
  say "Record each block above verbatim in plan section 3.2. The GitHub integration cannot be probed here."
}

case "$MODE" in
  rehearse) run_rehearse ;;
  probe-ordering) run_probe ;;
esac
