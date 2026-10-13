# Database roles

Each service that touches Postgres connects as its **own login role**. None of
them is a superuser, none bypasses row-level security, and none owns an object.
This is the control behind risk-register rows R-032 and R-033; the migrations are
`supabase/migrations/20260914120800_service_roles.sql`,
`…120900_rls_consent_policies.sql` and `…121000_service_grants.sql`.

Before these existed every service shared one DSN, and that DSN was the project's
superuser. A superuser bypasses RLS even on a `FORCE`d table, so none of the
policies in 0003 to 0007 ever ran, and a query that forgot its
`WHERE account_id = …` could read or delete another patient's rows.

## The two layers

| Layer | Names | Can log in | Holds |
|---|---|---|---|
| Group | `tether_auth`, `tether_catalogue`, `tether_enrolment`, `tether_records`, `tether_care_team`, `tether_notification`, `tether_website`, `tether_chronic`, `tether_realtime` | no | every grant, and every policy `TO` clause |
| Login | the same names with `_login` appended | yes | nothing: it is a member of exactly one group |

A credential can therefore be rotated by replacing the login role without
touching a grant. `tether-api-gateway` holds no data and has no role.

Login roles are created **locked**: `LOGIN`, no password, `VALID UNTIL
'-infinity'`. A role in that state cannot authenticate even if `pg_hba.conf` is
permissive and even if somebody sets a password and forgets the second step.

## What each role may do

Derived from the SQL each service runs. `S` select, `I` insert, `U` update, `D`
delete; a column list means that verb on those columns only. Anything not
listed is denied. The test `db/test/service-roles.integration.test.ts` holds this
same matrix independently and compares it with the live catalogue for every
table and column, so the two cannot drift silently.

| Service → login role | Schema USAGE | Table | Privileges | Why (source) |
|---|---|---|---|---|
| auth → `tether_auth_login` | identity, ops | `identity.account` | S, D, I(external_id, email, last_seen_at), U(email, last_seen_at) | `auth-service/src/accounts.ts:70,114,165,196` |
| | | `identity.refresh_session` | S, I(account_id, family_id, token_hash, issued_at, expires_at, user_agent, ip), U(revoked_at, revoked_reason) | `auth-service/src/store.ts:64,75,100,109,120` |
| | | `ops.audit_event` | I | `accounts.ts:179` |
| catalogue → `tether_catalogue_login` | catalogue | the ten `catalogue.*` tables | S | `catalogue-service/src/repository.ts:238-468` |
| enrolment → `tether_enrolment_login` | programme, record, catalogue, ops | `programme.enrolment` | S, I(account_id, area_id, status), U(status, ended_at, hidden) | `enrolment-service/src/repository.ts:171,199,230,282,307,323` |
| | | `programme.sharing_consent` | S, I(enrolment_id, scope, recipient_kind, recipient_id, consent_version, consent_text), U(revoked_at) | `repository.ts:156,359,396,430` |
| | | `record.observation`, `record.screen_answer`, `record.lapse_event` | S | share preview, `repository.ts:506-543` |
| | | `catalogue.shell_rule`, `.area`, `.measure` | S(id, rule), S(id, name, product_id), S(id, label) | `repository.ts:251,267,515` |
| | | `ops.audit_event` | I | `enrolment-service/src/audit.ts:73` |
| records → `tether_records_login` | programme, record, catalogue, ops | `programme.enrolment`, `programme.sharing_consent` | S, D | `records-service/src/postgres-store.ts:143,153,334,391,402,417` |
| | | `record.screen_answer` | S, D, I(enrolment_id, screen_id, block_index, kind, value), U(kind, value) | `postgres-store.ts:191,478` |
| | | `record.lapse_event` | S, D, I(enrolment_id, occurred_at, severity, context) | `postgres-store.ts:229,402` |
| | | `record.observation` | S, D, I(enrolment_id, measure_id, value_num, value_text, unit, observed_at, source, platform) | `postgres-store.ts:282,402` |
| | | `catalogue.area` | S(id, name) | `postgres-store.ts:357` |
| | | `ops.audit_event` | S, I | `records-service/src/audit.ts:52`; sync receipts `postgres-store.ts:373` |
| care_team → `tether_care_team_login` | programme, record, care, ops | `programme.sharing_consent` | S(id, enrolment_id, scope, recipient_kind, recipient_id, consent_version, granted_at, revoked_at) | `care-team-service/src/postgres-store.ts:201,237` |
| | | `programme.enrolment` | S(id, account_id, area_id, status, joined_on) | `postgres-store.ts:198-202,267,309` |
| | | `record.screen_answer` | S(id, enrolment_id, screen_id, block_index, kind, value, answered_at) | `postgres-store.ts:295,297,414` |
| | | `record.lapse_event` | S(id, enrolment_id, occurred_at) | `postgres-store.ts:299-303,319`; detail only through `care.lapse_details()` (`:441`) |
| | | `record.observation` | S(id, enrolment_id, measure_id, value_num, value_text, unit, observed_at, source, platform) | `postgres-store.ts:305-307,358,372,464` |
| | | `care.escalation_policy` | S | `postgres-store.ts:487` |
| | | `care.escalation` | S, I(enrolment_id, raised_by, consent_id, signal, detail, policy_area_id, policy_version, routed_to_kind, routed_to, acknowledge_by) | `postgres-store.ts:503,538` |
| | | `ops.audit_event` | I | `care-team-service/src/audit.ts:62` |
| notification → `tether_notification_login` | ops | `ops.device_token` | S, D, I(account_id, token, platform, area_id), U(account_id, platform, area_id, last_seen_at) | `notification-service/src/store.ts:45,76,88,110` |
| | | `ops.notification_preference` | S, I(account_id, specific_content, opted_in_at, consent_text), U(specific_content, opted_in_at, consent_text) | `store.ts:135,167` |
| | | `ops.notification_log` | I(account_id, kind, variant, device_count, delivered_count, failed_count, provider) | `store.ts:195` |
| website → `tether_website_login` | ops | `ops.waitlist_enquiry` | S(id, email, received_at, purge_after), I(name, email, role, interest, message, source), D | `website-service/src/waitlist.ts:46,53,95,124` |
| | | `ops.audit_event` | I | `waitlist.ts:163` |
| chronic → `tether_chronic_login` | chronic | `chronic.profile` | S, I(account_id), U(display_name, avatar_emoji, dob, health_score) | `chronic-service/src/store.ts:96,121,162` |
| | | `chronic.condition` | S, I(profile_id, kind, status, goal_value, goal_unit, diagnosed_at), U(status, goal_value, goal_unit, diagnosed_at) | `store.ts:236,262` |
| | | `chronic.vital_entry` | S, I(condition_id, metric_key, label, value, unit, note, observed_at, source) | `store.ts:361,386` |
| | | `chronic.medication` | S, D, I(profile_id, condition_id, name, dosage, schedule, times, reminders_enabled, last_taken_at, active) | `store.ts:477,507,556` |
| realtime → `tether_realtime_login` | programme | `programme.enrolment` | S(id, account_id) | `realtime-service/src/allowlist.ts:29` |
| | | `programme.sharing_consent` | S(enrolment_id, recipient_id, revoked_at) | `allowlist.ts:34` |

Two functions are executable by one role each and by nobody else:
`care.lapse_details(uuid)` by `tether_care_team` (a lapse's free-text severity and
context, only to a live `notes` consent) and `ops.release_device_token(text)` by
`tether_notification` (moves a push token to the newest account holding the
device).

Also: a table's own policies may reference columns the caller cannot select, but
the tables a policy's **subquery** reads need a grant for the caller. That is why
`tether_care_team` can select `programme.enrolment(id, account_id)` even though a
few of its statements never name that table.

## How the policies know who is asking

`@tether/core`'s `withPrincipal(accountId, fn)` opens a transaction and runs
`SELECT set_config('app.account_id', $1, true)`; every policy reads it through
`app_account_id()`. The `true` makes it transaction-local, so a pooled connection
cannot carry one request's identity into the next. `withPrincipal` now refuses an
account id that is not a UUID before it reaches the setting.

## Operator runbook

Nothing here is run by an agent, by CI, or by a deploy. Each step is yours.

### 0 · Before you start

* These migrations are **new files**. Do not merge to the branch the Supabase
  GitHub integration deploys until `BE-001` is reviewed and the migration-history
  plan says how this repository's migrations reach a database that already holds
  Tether-Health's nine (BASELINE, "Live Supabase project").
* The login roles are database-wide objects. On a project that already has the
  `tether_` prefix in use, check `\du tether_*` first.

### 1 · Apply the migrations

Through `supabase db push` behind whatever approval you use, or locally with
`supabase db reset`. The files are applied in order, once each, like every other
migration; the roles file is also safe to re-run (it re-asserts attributes and
never touches `VALID UNTIL`). They create the roles locked, with no password.

### 2 · Set each password and unlock each role

For each of the nine login roles, in `psql` connected as the project owner. Do
not type the password into a statement: `\password` hashes it **on the client**
(SCRAM) so it never reaches the server log, which `ALTER ROLE … PASSWORD '…'`
would if `log_statement` is `ddl` or `all`.

```sql
\password tether_auth_login
ALTER ROLE tether_auth_login VALID UNTIL 'infinity';
```

Repeat for `tether_catalogue_login`, `tether_enrolment_login`,
`tether_records_login`, `tether_care_team_login`, `tether_notification_login`,
`tether_website_login`, `tether_chronic_login`, `tether_realtime_login`. Use a
different generated password for each and keep them in your secret manager. The
second statement is the unlock: without it the role is still refused.

Confirm:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolvaliduntil
  FROM pg_roles WHERE rolname LIKE 'tether\_%\_login' ORDER BY 1;
-- expect: canlogin t, super f, bypassrls f, validuntil infinity
```

### 3 · Build each service's DSN

```
postgres://tether_<service>_login:<password>@<host>:<port>/postgres?sslmode=require
```

* On Supabase the pooler user name is `tether_<service>_login.<project-ref>`.
* Use the **transaction pooler** (port 6543) for every service except
  `realtime-service`. `set_config(…, true)` is transaction-local, so it is safe
  there.
* `realtime-service` holds a `LISTEN` connection and needs a **direct connection
  or the session pooler**: `LISTEN` does not survive transaction pooling.

### 4 · Set the per-service variable

In the Render dashboard, on each service, set `DATABASE_URL` to that service's own
DSN. `render.yaml` declares the variable on each service with `sync: false` and no
longer carries it in the `tether-shared` group, so the old shared value is
removed when the Blueprint is applied. Do not paste a superuser DSN into any of
them. The gateway needs none.

### 5 · Order of rollout

1. Apply migrations (step 1), then set passwords and unlock (step 2).
2. Deploy the builds that contain this branch's code, each with its own
   `DATABASE_URL` (steps 3 and 4). **Code and DSN move together.** The previous
   build's SQL has no account predicates and appends audit rows with `RETURNING`,
   which the new policies refuse for a clinician's disclosure row; it was written
   for a role that bypassed RLS.
3. Check `/readyz` on each service, then exercise one request that touches each
   role's tables.
4. Retire the old shared DSN, and **rotate the superuser password**: it was shared
   by nine services and sat in a Render environment group, so treat it as
   exposed. This repository does not do that for you.

### 6 · Rotating a role

Create a second login role in the same group, move the service to it, then drop
the first:

```sql
CREATE ROLE tether_chronic_login_2 LOGIN VALID UNTIL '-infinity' IN ROLE tether_chronic;
\password tether_chronic_login_2
ALTER ROLE tether_chronic_login_2 VALID UNTIL 'infinity';
-- redeploy chronic-service with the new DSN, then:
DROP ROLE tether_chronic_login;
```

### 7 · Local stack

`docker-compose.yml` already expects a DSN per service
(`AUTH_DATABASE_URL`, `CATALOGUE_DATABASE_URL`, …). After
`docker compose --profile migrate run --rm db-migrate`, do step 2 against the
local container (`docker compose exec postgres psql -U tether -d tether`) and
point each `*_DATABASE_URL` in your local `.env` at the matching login role.
`.env.example` is not edited by this change; set the nine values by hand.

## Changing a query, a table or a column

A grant and the SQL that needs it are one change. When a service's SQL changes:

1. Update the grant in a **new** migration (never edit one that has been applied).
2. Update the `MATRIX` in `db/test/service-roles.integration.test.ts`. The
   privilege test fails in both directions, so a grant added or dropped without
   the matrix, or the matrix changed without the grant, is a red build.
3. Every new statement on a patient's data names the account itself
   (`account_id = $n`, or a join through the caller's enrolment or profile) and
   the policy is the backstop. `assertScopedTo` in
   `packages/core/test/support/recording-tx.ts` is the unit-level check.

## Tests

* `npm test` runs everything. The DB suite needs Docker; without it the suite is
  **skipped, and reported as skipped with the reason**, never faked:
  `ok 1 - service-role integration suite # SKIP NOT RUN: docker is not installed…`.
  A skipped suite is not a passing suite.
* `TETHER_PG_TEST_SKIP=1` skips it on a machine where Docker answers but
  containers are not wanted. `TETHER_PG_TEST_DRIVER=<module>` runs the same
  assertions against another Postgres (the module exports `start()`; see
  `db/test/support/postgres.ts`).
* `db/test/migrations.test.ts` is the static half and always runs.

## What this does not do

* **The GUC is a convention, not a credential.** Any login role can
  `SET app.account_id = '<someone else>'` for its own session. It then reaches only
  what its own grants reach, so the protection is the grants, and the policies
  limit each role *within* its tables. A compromised service is bounded; it is
  not blind.
* **Any login role can `LISTEN tether_change`.** Payloads are an enrolment id, a
  table and a verb, never a row, and `realtime-service` is the only one that does
  it. PostgreSQL has no per-role channel ACL.
* **`service_role` and the project owner bypass RLS by design** (Supabase). No
  service in this repository may be handed either, and the migrations withdraw
  the `anon` and `authenticated` privileges the hosted defaults can carry on
  these schemas.
* **`pg_hba.conf` is not ours.** The locked-by-default roles are a second lock,
  not a substitute for requiring SCRAM and TLS.
