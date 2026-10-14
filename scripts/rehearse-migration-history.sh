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
#                    verbatim, what the local CLI does. Observation only. Only
#                    meaningful before the implementing ticket (S1) renames them.
#   print-catalogue-sql
#                    Plan section 5, step S3. Prints, and connects to nothing,
#                    the read-only catalogue query (no row data) that the owner
#                    pastes into the hosted SQL editor before and after S6.
#
# Layouts. Backend's migration directory is read in either of two layouts:
#   pre-S1   Backend's 12 files at 20260914... (today). They are re-versioned in
#            the temporary project only; nothing in the repository is renamed.
#   post-S1  The 9 adopted Tether-Health files (12-digit versions) plus the 12
#            Backend files already at their new 14-digit versions. Nothing is
#            re-versioned; the adopted files are checked against the plan's
#            section 2.1 hashes and are not copied from the repository.
# PASS means the same in both: every assertion below holds. Before P-1 (plan
# section 4.2) one FAIL, def.set_updated_at(), is the expected result.
#
# Needs: bash, git, psql, docker (a RUNNING daemon), the supabase CLI. None of
# them has been run by the agent that wrote this file (no Docker daemon, no
# psql on that machine): the run is an owner check, see plan section 7 (OC-3).
#
# Output. CLI output is passed through a redactor (JWTs, sb_ keys, URLs). Do not
# paste the output of `supabase status` or `supabase start` anywhere.
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

# 3 Tether-Health tables + 19 Backend tables (plan section 6.6). A different
# count means a table was added or removed: re-read the plan before trusting it.
EXPECTED_FORCED_TABLES=22

# Plan section 2.1: sha256 of each adopted Tether-Health file, by file name.
tether_expected_sha() {
  case "$1" in
    202609110001_profiles.sql) printf '%s' dabd83f95b7c4e2f951d1aeb4375cccbec72d67012c653708224492936c2439b ;;
    202609150001_quit_plans.sql) printf '%s' 641cfc47492832f8650616fb3dbbf30b2cd79eb2c54aa8a84743b9549fc3005a ;;
    202609150002_quit_plan_validator_grant.sql) printf '%s' edb340f1764cde4dd2b064b0b44e3f8034ce1027ec06b9963d1708d72ee0807b ;;
    202609150003_quit_plan_upsert_grant.sql) printf '%s' 7ae8f7d97cf480fd3956a4f81a62d0376e219029eac07f49486c455ef0d4c2d4 ;;
    202609150004_quit_plan_integrity.sql) printf '%s' 399060bca03aa3ec1f3064c322b547a6c28bb6d0ec3f95e1c01c003e61a3b2ef ;;
    202609150005_quit_plan_contract_hardening.sql) printf '%s' 6aacf5b684623d38bf8c0efa81b29220b698ffd179befaf89f301d3c3072708a ;;
    202609200001_account_data_deletion.sql) printf '%s' 6490ab749a25e60fed1f7091557a8753234a892b130e5b5f68e13b314cf295bf ;;
    202609260001_program_data.sql) printf '%s' 6b011ad26db77e5d32cf495a8b7191802c7cec12720e0c1d734c19f294bc1cd9 ;;
    202610030001_avatar_deletion_barrier.sql) printf '%s' 18014a8af83712618db7f165e0056657e7fd4216195e136fffafdc34a8fe1db9 ;;
    *) printf '%s' unknown ;;
  esac
}

# Plan section 2.2: sha256 of each Backend file at 79685b2, by name without the
# version. A different hash means the plan describes other content: re-read its
# section 11 (B1, R-063) and 4.2 (P-1) before trusting a PASS.
backend_expected_sha() {
  case "$1" in
    foundation) printf '%s' 4e5a06dacae82e2bc7a3134d8fe536f9a2b1ad0828495802b0312050d565d8eb ;;
    catalogue) printf '%s' a808949ed049022bb5270502380baa0184820be25220c6414c42ae20d799a380 ;;
    programme_and_record) printf '%s' 358865c3e46c39dd4618858add6705783a563ad199e335053e3b50663d23ae68 ;;
    auth_sessions) printf '%s' 2ad54308561a0c732392d4a984d901fc1f7b8e62c0dbe5fc4b19495972f81e72 ;;
    care) printf '%s' 0e746c6823697b1ea5bef6aecdea8845fdf0933e0402361ac378eac4d0051a62 ;;
    notifications) printf '%s' 8e5de43ee0dfc7671880ddf530930c695fd53f3d776ef2543df6abe3b909b240 ;;
    chronic) printf '%s' 61f89fe5fbe9efe32123f88d055c8e2b57a5e48f20e315e02d212fd7fbd0fae6 ;;
    realtime) printf '%s' a848b11e1a95eec8ef34fc559d0c450eb9e267c0906654069395d8e63f0807a9 ;;
    service_roles) printf '%s' 3e0456419be80158403497474d27e1d61ad0aa2a507568b3103cb56479db5724 ;;
    rls_consent_policies) printf '%s' 2a9a757df853a2f000aa9ce59588a1fac68d1df4b109251ce1814758d4b2b82b ;;
    service_grants) printf '%s' 96e9778f66a7a0abe9d471cf19e0ee8176c2791e5a5c6e1d910ea459bfa8dbd5 ;;
    consent_revocation_recipient) printf '%s' 43583f6b2b9d721dda653f4e6f8a254a6112af598d3d9292fa72f3669615107f ;;
    *) printf '%s' unknown ;;
  esac
}

file_sha256() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The catalogue-only snapshot: one read-only SELECT, no row data from any table
# (no rows.* and no count.* keys), one text line per key. The rehearsal compares
# it before and after the Backend chain. The owner may also paste it into the
# hosted SQL editor before and after S6 (`print-catalogue-sql`), because the
# editor shows only the last statement's result, so it is a single query.
catalogue_sql() {
  cat << 'SQL'
select line from (
  select 'bucket.avatars|' || id || ',' || public || ',' || coalesce(file_size_limit::text, '') || ',' || coalesce(allowed_mime_types::text, '') as line
    from storage.buckets where id = 'avatars'
  union all
  select 'force.' || c.relname || '|' || c.relrowsecurity || ',' || c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in ('profiles', 'quit_plans', 'program_data')
  union all
  select 'def.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' || md5(pg_get_functiondef(p.oid))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('delete_my_app_data', 'begin_account_deletion', 'avatar_write_allowed',
                       'save_program_data', 'set_updated_at', 'handle_new_auth_user',
                       'is_valid_support_people', 'is_unique_text_array')
  union all
  select 'acl.function.' || p.proname || '|' || coalesce(p.proacl::text, '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('delete_my_app_data', 'begin_account_deletion', 'avatar_write_allowed',
                       'save_program_data', 'set_updated_at', 'handle_new_auth_user',
                       'is_valid_support_people', 'is_unique_text_array')
  union all
  select 'policies.public|' || coalesce(md5(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles, qual, with_check), E'\n' order by tablename, policyname)), '')
    from pg_policies where schemaname = 'public' and tablename in ('profiles', 'quit_plans', 'program_data')
  union all
  select 'policies.public.count|' || count(*)
    from pg_policies where schemaname = 'public' and tablename in ('profiles', 'quit_plans', 'program_data')
  union all
  select 'policies.avatars|' || coalesce(md5(string_agg(format('%s|%s|%s|%s|%s', policyname, cmd, roles, qual, with_check), E'\n' order by policyname)), '')
    from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars\_%'
  union all
  select 'policies.avatars.count|' || count(*)
    from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'avatars\_%'
  union all
  select 'triggers.auth_users|' || coalesce(md5(string_agg(pg_get_triggerdef(oid), E'\n' order by tgname)), '')
    from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal
  union all
  select 'trigger.name.' || tgname || '|present'
    from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal
  union all
  select 'triggers.public_tables|' || coalesce(md5(string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.tgname)), '')
    from pg_trigger t
   where t.tgrelid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
     and not t.tgisinternal
  union all
  select 'columns.' || c.relname || '|' || md5(string_agg(format('%s|%s|%s|%s', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '')), E'\n' order by a.attnum))
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where c.oid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
   group by c.relname
  union all
  select 'constraints.' || conrelid::regclass::text || '|' || md5(string_agg(conname || ':' || pg_get_constraintdef(oid), E'\n' order by conname))
    from pg_constraint
   where conrelid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
   group by conrelid
  union all
  select 'acl.table.' || c.relname || '|' || coalesce(c.relacl::text, '')
    from pg_class c where c.oid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
  union all
  select 'acl.columns.' || c.relname || '|' || coalesce(md5(string_agg(a.attname || ':' || a.attacl::text, E'\n' order by a.attname)), '')
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attacl is not null
   where c.oid in ('public.profiles'::regclass, 'public.quit_plans'::regclass, 'public.program_data'::regclass)
   group by c.relname
  union all
  select 'ledger.statements.' || version || '|' || md5(array_to_string(statements, E'\n'))
    from supabase_migrations.schema_migrations
   where version in ('202609110001', '202609150001', '202609150002', '202609150003', '202609150004',
                     '202609150005', '202609200001', '202609260001', '202610030001')
) q
order by line;
SQL
}

# Row-level keys: counts and row hashes of the three tables. Synthetic data only,
# local only. Never printed for the hosted project.
row_sql() {
  cat << 'SQL'
select 'count.auth_users|' || count(*) from auth.users
union all select 'count.profiles|' || count(*) from public.profiles
union all select 'count.quit_plans|' || count(*) from public.quit_plans
union all select 'count.program_data|' || count(*) from public.program_data
union all select 'count.avatar_objects|' || count(*) from storage.objects where bucket_id = 'avatars'
union all select 'rows.profiles|' || coalesce(md5(string_agg(p::text, E'\n' order by p.id)), '') from public.profiles p
union all select 'rows.quit_plans|' || coalesce(md5(string_agg(q::text, E'\n' order by q.user_id)), '') from public.quit_plans q
union all select 'rows.program_data|' || coalesce(md5(string_agg(d::text, E'\n' order by d.user_id, d.program_id)), '') from public.program_data d;
SQL
}

redact() {
  # Strip anything key-, token- or URL-shaped from CLI output.
  sed -E \
    -e 's/eyJ[A-Za-z0-9._-]+/[redacted-jwt]/g' \
    -e 's/sb_[a-z]+_[A-Za-z0-9_-]+/[redacted-key]/g' \
    -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+#[redacted-url]#g'
}

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
  print-catalogue-sql)
    # Connects to nothing, needs no tool and no environment.
    catalogue_sql
    exit 0
    ;;
  rehearse | probe-ordering) ;;
  *) refuse "usage: $0 rehearse | probe-ordering | print-catalogue-sql" ;;
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

cli() {
  # Run the supabase CLI against the temporary project, output redacted. The
  # pipeline keeps the CLI's own exit status (pipefail).
  supabase "$@" --workdir "$WORKDIR" 2>&1 | redact
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
  local path name count=0 expected="" version actual
  while IFS= read -r path; do
    name="${path##*/}"
    git -C "$TETHER_HEALTH_REPO" show "origin/develop:$path" > "$WORKDIR/supabase/migrations/$name"
    # Pinned by content (plan section 2.1), not by branch name: a moved
    # origin/develop that changes any of the 9 is refused.
    actual="$(file_sha256 "$WORKDIR/supabase/migrations/$name")"
    [ "$actual" = "$(tether_expected_sha "$name")" ] || refuse "$name differs from the plan's section 2.1 sha256"
    version="${name%%_*}"
    expected="$expected $version"
    count=$((count + 1))
  done < <(git -C "$TETHER_HEALTH_REPO" ls-tree --name-only origin/develop supabase/migrations/)
  expected="${expected# }"
  [ "$count" -eq 9 ] || refuse "expected 9 Tether-Health migrations on origin/develop, found $count"
  [ "$expected" = "$EXPECTED_TETHER_VERSIONS" ] || refuse "Tether-Health versions differ from the plan: $expected"
  say "Tether-Health origin/develop at $(git -C "$TETHER_HEALTH_REPO" rev-parse origin/develop): 9 migrations copied, all match plan section 2.1"
}

copy_backend_migrations() {
  # copy_backend_migrations renamed|original
  local style="$1" file name version rest key target actual expected
  local count=0 adopted=0 already=0 pre=0
  say "Backend HEAD: $(git -C "$ROOT" rev-parse HEAD)"
  if [ -n "$(git -C "$ROOT" status --porcelain -- supabase/migrations)" ]; then
    say "WARNING: uncommitted changes under supabase/migrations; the run describes the working tree, not HEAD"
  fi
  for file in "$ROOT"/supabase/migrations/*.sql; do
    name="${file##*/}"
    version="${name%%_*}"
    rest="${name#*_}"
    key="${rest%.sql}"
    case "${#version}" in
      12)
        # post-S1: an adopted Tether-Health file. Already placed from git by
        # copy_tether_migrations; here it only has to be byte-identical.
        actual="$(file_sha256 "$file")"
        [ "$actual" = "$(tether_expected_sha "$name")" ] || refuse "adopted file $name differs from the plan's section 2.1 sha256"
        adopted=$((adopted + 1))
        continue
        ;;
      14) ;;
      *) refuse "$name: a version must be 12 digits (adopted) or 14 digits (Backend)" ;;
    esac

    actual="$(file_sha256 "$file")"
    expected="$(backend_expected_sha "$key")"
    if [ "$actual" != "$expected" ]; then
      if [ "${ACCEPT_BACKEND_HASH_DRIFT:-0}" = "1" ]; then
        say "NOTE: $name differs from plan section 2.2 (accepted by ACCEPT_BACKEND_HASH_DRIFT=1); re-read plan sections 4.2 and 11"
      else
        refuse "$name differs from the plan's section 2.2 sha256; set ACCEPT_BACKEND_HASH_DRIFT=1 only after re-reading plan sections 4.2 and 11"
      fi
    fi

    # Is this 14-digit version already past the newest adopted one (post-S1), or
    # is it still a 20260914... version (pre-S1)? Both are compared the two ways
    # the CLI might compare them, because which one it uses is Unknown.
    # shellcheck disable=SC2071
    if [[ "$version" > "$NEWEST_TETHER_VERSION" ]] && [ "$version" -gt "$NEWEST_TETHER_VERSION" ]; then
      already=$((already + 1))
      target="$name"
    else
      pre=$((pre + 1))
      if [ "$style" = "renamed" ]; then
        target="$(new_version "$version")_${rest}"
        # shellcheck disable=SC2071
        [[ "${target%%_*}" > "$NEWEST_TETHER_VERSION" ]] || refuse "re-versioned $target does not sort after $NEWEST_TETHER_VERSION as a string"
        [ "${target%%_*}" -gt "$NEWEST_TETHER_VERSION" ] || refuse "re-versioned $target is not greater than $NEWEST_TETHER_VERSION as a number"
      else
        target="$name"
      fi
    fi
    cp "$file" "$WORKDIR/supabase/migrations/$target"
    count=$((count + 1))
  done
  [ "$count" -eq 12 ] || refuse "expected 12 Backend migrations in $ROOT/supabase/migrations, found $count"
  [ "$pre" -eq 0 ] || [ "$already" -eq 0 ] || refuse "mixed layout: some Backend files are re-versioned and some are not"
  [ "$adopted" -eq 0 ] || [ "$adopted" -eq 9 ] || refuse "found $adopted adopted Tether-Health files, expected 0 or 9"
  if [ "$already" -gt 0 ]; then
    [ "$adopted" -eq 9 ] || refuse "post-S1 layout without the 9 adopted files"
    [ "$style" = "renamed" ] || refuse "probe-ordering needs the pre-S1 layout (files at their old versions); this directory is post-S1"
    say "Layout: post-S1 ($adopted adopted files verified, $already Backend files already re-versioned, nothing renamed)"
  else
    say "Layout: pre-S1 ($pre Backend files, copied as '$style')"
  fi
}

start_stack() {
  WORKDIR="$(mktemp -d)"
  mkdir -p "$WORKDIR/supabase/migrations"
  write_config
  copy_tether_migrations
  say "Starting the disposable stack (project_id $LOCAL_PROJECT_ID, db port $LOCAL_DB_PORT)"
  # `supabase start` prints local API keys and URLs. Its output goes to a file in
  # the temporary directory (deleted at exit); only redacted error lines are shown.
  if ! supabase start --workdir "$WORKDIR" > "$WORKDIR/start.log" 2>&1; then
    say "supabase start failed. Redacted error lines:"
    grep -i -E 'error|fail|denied|refused|port' "$WORKDIR/start.log" | tail -n 20 | redact || true
    exit 1
  fi
  say "Stack started (its output was withheld: it contains local keys)"
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
  # The catalogue keys and the row keys, one sorted `key|value` line each.
  { catalogue_sql; row_sql; } | psql_local | LC_ALL=C sort
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
  # Plan section 5, S3: the owner compares these ledger hashes with the hosted
  # project's (the same md5 over the same column).
  grep -E '^ledger\.statements\.' "$before"

  say
  say "== 3. apply the Backend chain (must sort after $NEWEST_TETHER_VERSION) =="
  copy_backend_migrations renamed
  cli migration list --local
  cli migration up --local
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

  probe "list" cli migration list --local
  probe "db push dry run" cli db push --local --dry-run
  probe "migration up, no flags" cli migration up --local
  probe "db push, no flags" cli db push --local
  probe "db push --include-all" cli db push --local --include-all
  say
  say "Record each block above verbatim in plan section 3.2. The GitHub integration cannot be probed here."
}

case "$MODE" in
  rehearse) run_rehearse ;;
  probe-ordering) run_probe ;;
esac
