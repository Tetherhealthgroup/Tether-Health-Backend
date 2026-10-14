# Migration-history plan: Tether-Health's 9 live migrations to Tether-Health-Backend's schema

Ticket OPS-021 (security, privacy, health-data, release-blocker). Author: th-backend-node.
Status: **DRAFT for owner review. Approving this plan is Tier 3 and is the owner's. Approving it does not authorise executing any step in it.**

Evidence labels: **Verified** (command output seen in this session), **Observed** (read in a file, `file:line` given), **Inferred** (reasoned from Observed facts), **Assumed** (stated so the owner can overrule it), **Unknown** (could not be determined here).

Citation forms. `B:file:line` is a file in this worktree at commit `79685b2`. `T:file:line` is a file in `Tether-Health` at `origin/develop` (`7b9dab6`, Verified by `git rev-parse`), read with `git show origin/develop:supabase/migrations/<file>`. Backend migration files are all under `supabase/migrations/`.

## 0. Base, scope and what this plan is not

- **Base: `79685b2` on `office/BE-001-rls-roles`, not `ffba1e5` as the ticket says** (Observed, OPS-021.md:5). BE-001 rework 3 changed two migrations after `ffba1e5`: `20260914120900_rls_consent_policies.sql` and `20260914121100_consent_revocation_recipient.sql` (`runs/2026-10-13-BE-001-rework3.md:30-40`; Verified here: `git diff --stat ffba1e5 79685b2 -- supabase/migrations` lists exactly those two files). The ticket itself says to re-run against a new head if the files change (OPS-021.md:5). `runs/2026-10-13-BE-001-b2-review.md:188` advised against re-basing; the owner's direction of 2026-10-14 overrides that, and this plan records the choice.
- BE-001 is not approved, and two owner decisions that touch its migrations are open: **B1** (`care.lapse_details` design) and **R-063** (`recipientId` contract) (`runs/2026-10-13-BE-001-b2-review.md:175-188`). **The content of `…120900` and `…121100` is PENDING.** This plan decides neither. Section 11 lists what to re-check if either file changes.
- Out of scope, as in the ticket: data backfill (BE-041), applying anything to the hosted project (OPS-023, owner), new tables for quit plan, profile and program data (BE-042..BE-044).
- Nothing in this plan was executed against any database. No Supabase CLI subcommand, no Docker, no `npm run db:migrate` was run while writing it (Verified: none was invoked).

## 1. Starting facts

| # | Fact | Label and source |
|---|---|---|
| 1.1 | The live project `TetherHealth-DB` has applied exactly Tether-Health's 9 migrations `202609110001` to `202610030001`, and none of Backend's | Verified by the owner's read-only CLI on 2026-10-12 (BASELINE.md:100). Not re-checked in this session, because hosted access is out of bounds |
| 1.2 | Live tables `public.profiles`, `public.quit_plans`, `public.program_data` have RLS enabled and forced; bucket `avatars` is private; 11 auth users, some real-looking | Verified 2026-10-12 (BASELINE.md:116-118). Not re-checked |
| 1.3 | Tether-Health's 9 files on `origin/develop` are the ones listed in 2.1 | Verified here: `git ls-tree --name-only origin/develop supabase/migrations/` |
| 1.4 | Backend has 12 migrations at `79685b2`: 8 on `origin/main` (`0533885`) and 4 added by BE-001 | Verified here: `git ls-tree` on `origin/main` and `ls` of the worktree |
| 1.5 | Backend's 14-digit versions `20260914…` sort between Tether-Health's `202609110001` and `202609150001` **as strings**, and after all 9 **as numbers** (14 digits against 12). Backend's `20260914…` also sorts before `202610030001` as a string | Inferred (arithmetic on the file names). Which comparison the CLI uses is Unknown, see section 3 |
| 1.6 | Backend migrations contain no `BEGIN`/`COMMIT` (`B:…120000_foundation.sql:9-19`) | Observed |
| 1.7 | Backend `supabase/config.toml` has `[storage] enabled = false` | Observed (`B:supabase/config.toml:52-53`). A stack started from it cannot apply Tether-Health's `202609110001`, which inserts into `storage.buckets` (`T:202609110001_profiles.sql:87-92`). The rehearsal script writes its own config for that reason |
| 1.8 | `.github/workflows` `migrate` job still runs `node --experimental-strip-types db/migrate.ts` against `db/migrations/…`, files that do not exist at this commit | Observed (workflow lines 178-213, `ls db`: no `migrate.ts`, no `migrations/`). BASELINE.md:31 records the same. Out of scope here; it means there is no working CI check of the chain today |

## 2. Inventory

### 2.1 The 9 applied files (Tether-Health, `origin/develop`), sha256 of the file as committed

| Version | File | sha256 |
|---|---|---|
| 202609110001 | `_profiles.sql` | `dabd83f95b7c4e2f951d1aeb4375cccbec72d67012c653708224492936c2439b` |
| 202609150001 | `_quit_plans.sql` | `641cfc47492832f8650616fb3dbbf30b2cd79eb2c54aa8a84743b9549fc3005a` |
| 202609150002 | `_quit_plan_validator_grant.sql` | `edb340f1764cde4dd2b064b0b44e3f8034ce1027ec06b9963d1708d72ee0807b` |
| 202609150003 | `_quit_plan_upsert_grant.sql` | `7ae8f7d97cf480fd3956a4f81a62d0376e219029eac07f49486c455ef0d4c2d4` |
| 202609150004 | `_quit_plan_integrity.sql` | `399060bca03aa3ec1f3064c322b547a6c28bb6d0ec3f95e1c01c003e61a3b2ef` |
| 202609150005 | `_quit_plan_contract_hardening.sql` | `6aacf5b684623d38bf8c0efa81b29220b698ffd179befaf89f301d3c3072708a` |
| 202609200001 | `_account_data_deletion.sql` | `6490ab749a25e60fed1f7091557a8753234a892b130e5b5f68e13b314cf295bf` |
| 202609260001 | `_program_data.sql` | `6b011ad26db77e5d32cf495a8b7191802c7cec12720e0c1d734c19f294bc1cd9` |
| 202610030001 | `_avatar_deletion_barrier.sql` | `18014a8af83712618db7f165e0056657e7fd4216195e136fffafdc34a8fe1db9` |

(Verified: computed with `shasum -a 256` over `git show` output.) The remote ledger also stores a statements hash or the statements themselves; whether it must match the local file byte for byte is Unknown (section 3.3). The strategy below keeps the files byte-identical so the answer does not matter.

### 2.2 Backend's 12 files at `79685b2`, current version and proposed version

The proposed version keeps the time-of-day and replaces the date `20260914` with `20261015` (Assumed: any date prefix strictly greater than `202610030001` and not earlier than the first apply works; the owner or the implementing ticket may choose another. The rehearsal script takes it as `REHEARSAL_VERSION_DATE`).

| Current version | Proposed version | Name | sha256 |
|---|---|---|---|
| 20260914120000 | 20261015120000 | `_foundation.sql` | `4e5a06dacae82e2bc7a3134d8fe536f9a2b1ad0828495802b0312050d565d8eb` |
| 20260914120100 | 20261015120100 | `_catalogue.sql` | `a808949ed049022bb5270502380baa0184820be25220c6414c42ae20d799a380` |
| 20260914120200 | 20261015120200 | `_programme_and_record.sql` | `358865c3e46c39dd4618858add6705783a563ad199e335053e3b50663d23ae68` |
| 20260914120300 | 20261015120300 | `_auth_sessions.sql` | `2ad54308561a0c732392d4a984d901fc1f7b8e62c0dbe5fc4b19495972f81e72` |
| 20260914120400 | 20261015120400 | `_care.sql` | `0e746c6823697b1ea5bef6aecdea8845fdf0933e0402361ac378eac4d0051a62` |
| 20260914120500 | 20261015120500 | `_notifications.sql` | `8e5de43ee0dfc7671880ddf530930c695fd53f3d776ef2543df6abe3b909b240` |
| 20260914120600 | 20261015120600 | `_chronic.sql` | `61f89fe5fbe9efe32123f88d055c8e2b57a5e48f20e315e02d212fd7fbd0fae6` |
| 20260914120700 | 20261015120700 | `_realtime.sql` | `a848b11e1a95eec8ef34fc559d0c450eb9e267c0906654069395d8e63f0807a9` |
| 20260914120800 | 20261015120800 | `_service_roles.sql` | `3e0456419be80158403497474d27e1d61ad0aa2a507568b3103cb56479db5724` |
| 20260914120900 | 20261015120900 | `_rls_consent_policies.sql` **(PENDING: B1)** | `2a9a757df853a2f000aa9ce59588a1fac68d1df4b109251ce1814758d4b2b82b` |
| 20260914121000 | 20261015121000 | `_service_grants.sql` | `96e9778f66a7a0abe9d471cf19e0ee8176c2791e5a5c6e1d910ea459bfa8dbd5` |
| 20260914121100 | 20261015121100 | `_consent_revocation_recipient.sql` **(PENDING: R-063)** | `43583f6b2b9d721dda653f4e6f8a254a6112af598d3d9292fa72f3669615107f` |

(Verified: `shasum -a 256` at `79685b2`.) A re-version is a rename. The 12 files are not in the remote ledger (fact 1.1), so a rename has no ledger consequence.

## 3. How the CLI and the GitHub integration treat versions older than the newest remote version (acceptance criterion 1)

### 3.1 What is established and what is not

| Question | Answer | Label |
|---|---|---|
| Does any local version sort before the newest remote version under the chosen strategy? | No. All 12 proposed versions are greater than `202610030001` as a string and as a number (the script refuses to run if not) | Inferred from the arithmetic in 2.2; Verified only by the script's own guard once it is run |
| What does `supabase db push` / `migration up` do with a local version older than the newest remote one | **Unknown.** I have no documentation fetched and no stack to observe | Unknown |
| Whether it compares versions as strings or as numbers | **Unknown** | Unknown |
| What the CLI does when the remote ledger has a version with no local file | **Unknown** | Unknown |
| What the GitHub integration does on a production-branch merge when a migration is older than the newest remote version | **Unknown**. It cannot be rehearsed locally and must not be tested against the hosted project | Unknown |
| What the integration's preview branches do | **Unknown** (they build from the repo's migrations on a fresh database; Inferred from BASELINE.md:78 and `B:db/test/migrations.test.ts:16`, which says the migrations live where the preview branches read them) | Inferred / Unknown |

### 3.2 Documentation citations

No web tool was available to this agent. Nothing below was fetched, so no sentence is quoted.

| Claim the plan would rely on | Page to consult (not fetched) | Fetch date | Quoted sentence | Label |
|---|---|---|---|---|
| CLI behaviour for a local migration older than the newest remote one (`db push`, `migration up`, `--include-all`) | `https://supabase.com/docs/reference/cli/supabase-db-push` | not fetched (2026-10-14) | none | **Unknown** |
| CLI behaviour when remote and local histories differ; `migration repair` semantics | `https://supabase.com/docs/reference/cli/supabase-migration-repair` | not fetched (2026-10-14) | none | **Unknown** |
| GitHub integration: which migrations run on merge, and what happens to an out-of-order one | `https://supabase.com/docs/guides/deployment/branching` and `https://supabase.com/docs/guides/deployment/managing-environments` | not fetched (2026-10-14) | none | **Unknown** |

The page names above are my recollection of where the topic lives. They are not evidence that the pages say what the plan needs. **Owner check OC-1:** fetch each page, record URL, date and the exact sentence that answers each row of 3.1, and update this section. **Owner check OC-2:** run `scripts/rehearse-migration-history.sh probe-ordering` on a Docker machine and paste the five blocks it prints. That records, on a disposable local stack only, what the CLI does with the old versions. It says nothing about the integration.

### 3.3 Consequence for the design

Because 3.1 is Unknown, the chosen strategy (section 4) is built so that its correctness **does not depend on any of those answers**: no local version is older than the newest remote version, no repair is needed, and no remote ledger row is edited. A strategy that did depend on them would be unsafe to approve today.

## 4. Ledger strategy (acceptance criterion 2)

### 4.1 Chosen: Option A, "adopt the 9 verbatim, then re-version Backend's 12 to sort after `202610030001`"

1. Backend's `supabase/migrations/` gains Tether-Health's 9 files, **byte-identical** (same names, same versions, sha256 as in 2.1), as its first 9 migrations.
2. Backend's 12 files are renamed to the proposed versions in 2.2. The date prefix change is the only edit to a file name. **Content edits are separate** and are limited to the single precondition P-1 below.
3. The first production apply is then "9 already applied, 12 pending, all newer". The remote ledger is never written by hand.

Why it fits: the repository and the remote ledger agree on the first 9 from day one; a fresh database (a preview branch, a new developer, CI) gets the live tables and the bucket before Backend's chain runs, so the two histories describe one database; no local version is older than a remote one.

### 4.2 Required content precondition P-1 (found by this review; no file is changed by this ticket)

`B:20260914120000_foundation.sql:50-53` is `CREATE OR REPLACE FUNCTION set_updated_at()`, unqualified. With the default search path it resolves to `public.set_updated_at()`, which is the function Tether-Health's `T:202609110001_profiles.sql:30-39` created with `set search_path = ''` and which three live triggers call (`T:202609110001:41-43`, `T:202609150001:133-135`, `T:202609260001:28-30`). The replace would rewrite its definition (dropping `set search_path = ''`). Observed (the two statements); the rewrite is Inferred from `CREATE OR REPLACE` semantics and is checked by the script (key `def.set_updated_at()`), which is **expected to FAIL on the unmodified files**.

Required before apply: Backend's foundation must stop touching `public.set_updated_at()`, for example by schema-qualifying Backend's helper into a Backend schema (and its 8 trigger references: `B:…120000:71,99`, `…120100:35`, `…120200:51,169`, `…120400:96`, `…120500:88`, `…120600:89,145,262`), or by defining it with the identical text Tether-Health used. Which one is the implementing ticket's choice. The same applies to `B:…120000:45-48` `public.app_account_id()`, which is a new function in `public`; it does not collide with anything live, but it is a new object exposed to the Data API by default (Inferred) and should move or be revoked. This changes a Backend migration that is on `origin/main` but has not been applied anywhere (fact 1.1), so editing it is safe for the ledger; it is still a schema change and Tier 3.

### 4.3 Rejected options

| Option | Why rejected |
|---|---|
| **B. Keep Backend's `20260914…` versions and use `supabase migration repair` to mark them applied or reverted** | Repair edits `supabase_migrations.schema_migrations` on the production database, which is a ledger rewrite by hand, and it records an apply that did not happen unless done in the right direction. It would also leave a repository whose first migration is `…120000` (no profiles table) and a ledger that says otherwise, so every fresh database differs from production. Repair semantics are also Unknown (3.2). |
| **C. Keep the old versions and apply with `db push --include-all`** | Depends on the Unknown answer to "what happens to an out-of-order version", on both the CLI and the integration; the integration has no such flag that I can show (Unknown). It makes the apply order on production (Backend's 8 after Tether-Health's `…150001`…`…030001`) different from the order on a fresh database (Backend's 8 between Tether-Health's 1st and 2nd). Two histories for one repository. |
| **D. Re-version Backend's 12 but do not add Tether-Health's 9 to Backend** | The remote ledger would hold 9 versions with no local file. CLI behaviour for that is Unknown (3.1), and a fresh preview branch would lack `public.profiles` and `avatars`, so Backend's repo would not describe production. |
| **E. Squash everything into one baseline migration and reset the ledger** | Rewrites the production ledger wholesale and puts the live tables, policies and functions inside a file that runs against an existing database: the opposite of a no-drop guarantee. Not reversible without restore. |
| **F. New hosted project, copy the data** | Moves 11 auth users (some real-looking) and their password hashes and sessions to a new project; secrets, JWKS signing keys, the Play and app configuration all change (BASELINE.md:127). Far larger blast radius for the same outcome. Not rejected on principle: it is the fallback if A cannot be made safe. |

## 5. Target sequence and its order relative to BE-001 (acceptance criterion 6)

All steps are **owner actions or owner-approved** unless marked "local". Tier follows AGENTS.md (Tier 3: migrations, RLS, health-data flows; Tier 4: deploy). No agent performs any step that touches the hosted project.

| Step | What | Who | Tier | Reversible by |
|---|---|---|---|---|
| S0 | Approve this plan. BE-001 approved by th-qa, th-reviewer and th-security. **B1 and R-063 decided.** If either changes `…120900` or `…121100`, re-run section 7 and re-check section 11 | Owner | 3 | n/a |
| S1 | Implementing ticket (new, not this one): add the 9 files verbatim, rename the 12, apply P-1, update the references listed in 5.1. Branch `office/*`, local only | th-backend-node | 2 to push, 3 to approve | `git revert` |
| S2 | Rehearse on a machine with Docker (section 7): `rehearse` must print `RESULT: PASS`, `probe-ordering` output filed in 3.2 | Owner | 3 | local stack is disposable |
| S3 | Verify the live starting state read-only: ledger lists exactly the 9 versions; `relforcerowsecurity` true on the three tables; avatars bucket private (section 6.6 queries) | Owner | 3 | none needed |
| S4 | Take and verify a backup. Whether the project has PITR is Unknown; a logical dump of `public`, `storage.buckets`, `storage.objects` metadata, `auth.users` is the minimum. Storage object files are not in a SQL dump | Owner | 3 | n/a |
| S5 | Merge S1 to Backend `main` **only if** the integration's production branch is still not `main`. Create the `deploy` branch and enable "Deploy to production" **after** S0 to S4. Both are owner pushes and settings changes | Owner | 4 | See section 8 |
| S6 | First apply: 12 pending migrations in one run, **all or none** (never the first 8 without the 4: BE-001 exists because the first 8 grant a service nothing and rely on a superuser DSN, R-032; `B:…120800:1-9`) | Integration, owner-triggered | 4 | See section 8 |
| S7 | Per-service LOGIN roles: created locked by `…120800:68-101`; the owner sets passwords and unlocks (section 9) | Owner | 3 | `ALTER ROLE … VALID UNTIL '-infinity'` |
| S8 | Run the section 6.6 post-apply queries on the live project, read-only | Owner | 3 | n/a |
| S9 | Switch each service's `DATABASE_URL` from the shared superuser DSN to its own login role (render.yaml, R-032) | Owner | 4 | Put the old DSN back (it is the problem; keep it only until S9 is verified) |

**Order relative to BE-001.** The four BE-001 migrations (`…120800` roles, `…120900` consent policies, `…121000` grants, `…121100` revocation recipient) are the **tail** of the 12, after Backend's original 8, and apply in the same run. There is no state in which Backend's first 8 are live without them (S6). BE-001's approval is a precondition of S5, not of the rehearsal.

### 5.1 References that the rename in S1 must update (Observed, `grep` for `20260914` and `supabase/migrations`)

`B:README.md`, `B:supabase/config.toml`, `B:db/ROLES.md` (names the four BE-001 files), `B:db/test/support/postgres.ts`, `B:db/test/migrations.test.ts` (names them at lines 204, 224, 237-240, and `name.slice(0, 14) > '20260914120700'` at line 235, which assumes 14-digit versions and would mis-handle the adopted 12-digit ones), `B:services/realtime-service/src/index.ts`. Not changed by this ticket.

## 6. No-drop proof (acceptance criterion 3)

### 6.1 Method

Two independent arguments, one static and one dynamic.
(a) **Static.** Every statement in Backend's 12 files that names an object is schema-qualified into a Backend schema, or is one of the two unqualified `public` functions in 4.2. Verified by `grep -n -i -E "profiles|quit_plans|program_data|set_updated_at|handle_new_auth_user|avatar|storage\.|auth\.users|delete_my_app_data|begin_account_deletion|drop |truncate|rename"` over `supabase/migrations/*.sql` at `79685b2`. Matches: only `set_updated_at` (trigger references and the foundation definition), the Backend-owned `chronic.profile` and its `avatar_emoji`, `DROP POLICY` on Backend tables (6.7), and comments. **No** match for `public.profiles`, `quit_plans`, `program_data`, `storage.`, `auth.users`, `delete_my_app_data`, `begin_account_deletion`, `avatar_write_allowed`, `TRUNCATE`, `RENAME`.
(b) **Dynamic.** The script snapshots the protected objects after Tether-Health's 9 and after Backend's 12 and requires every key to be equal (section 7). **NOT RUN**: no Docker here.

The 9 files are not re-run on production under Option A (their versions are in the ledger), so their own `DROP POLICY` / `CREATE OR REPLACE` statements (for example `T:202610030001:42-57`) are history, not steps. On a fresh database they run in version order and end in the same state production is in.

### 6.2 Live tables and their RLS policies

| Object | Created and forced at | Policies | Touched by Backend's 12? |
|---|---|---|---|
| `public.profiles` | `T:202609110001:3-25`; ENABLE and FORCE at `:65-66` | `profiles_select_own` `:68-71`, `profiles_update_own` `:73-77`; grants `:79-82`; column added `T:202610030001:3-4` | No (6.1a) |
| `public.quit_plans` | `T:202609150001:54-128`; ENABLE and FORCE `:137-138` | `quit_plans_select_own` `:140-143`, `_insert_own` `:145-148`, `_update_own` `:150-154`; grants `:156-169`, `T:202609150002:3-6`, `T:202609150003:3-4` | No |
| `public.program_data` | `T:202609260001:3-23`; ENABLE and FORCE `:32-33` | `program_data_select_own` `:35-37`, `_insert_own` `:39-41`, `_update_own` `:43-46`, `_delete_own` `:48-50`; grants `:52-54` | No |

Backend creates its tables in `identity`, `catalogue`, `programme`, `record`, `care`, `chronic`, `ops` only (`B:…120000:25-31`); none of them is `public`. The only Backend statements that create an object in `public` are `app_account_id()` and `set_updated_at()` (`B:…120000:45-53`), see 4.2.

### 6.3 The `avatars` bucket and its `storage.objects` policies

Bucket: `T:202609110001:87-92` (private, 5 MiB, jpeg/png/webp). Policies: `avatars_select_own` `:94-96`, `avatars_delete_own` `:107-109`; `avatars_insert_own` and `avatars_update_own` are created at `:98-105` and replaced by `T:202610030001:42-57` to call `public.avatar_write_allowed`. Backend references `storage.` nowhere (6.1a), enables no storage config (`B:supabase/config.toml:52-53`) and creates no bucket or storage policy. Backend's only grant changes on API roles are `REVOKE ALL … ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA`, `REVOKE ALL ON SCHEMA`, for the seven Backend schemas (`B:…120800:133-153`) and `REVOKE ALL ON FUNCTION` for three named Backend functions (`B:…120900:232-241`, `:387-396`, `B:…121100:38-47`). Neither touches `public` or `storage`.

### 6.4 The deletion functions

| Function | Definition (final) | Touched by Backend? |
|---|---|---|
| `public.delete_my_app_data(text)` | `T:202610030001:88-127` (replaces `T:202609260001:110-142`, which replaced `T:202609200001:3-32`) | No: no Backend file names it (6.1a) |
| `public.begin_account_deletion(text)` | `T:202610030001:59-82` | No |
| `public.avatar_write_allowed(text)` (used by the avatar policies) | `T:202610030001:9-36` | No |

Both deletion functions are `security definer` with `set search_path = ''` (`:62-63`, `:91-92`), and their grants are `:84-86` and `:129-131`. Backend sets no default privileges and does not revoke on `public` functions.

### 6.5 The `auth.users` triggers

`auth_user_created_profile` (after insert on `auth.users`, calls `public.handle_new_auth_user()`): `T:202609110001:45-59`. Backend contains no statement naming `auth.users` or `handle_new_auth_user` (6.1a). Backend's schemas have no foreign key to `auth.users` (`identity.account` uses `external_id`, `B:…120000:59-68`), so nothing in Backend can add a trigger there or cascade into it.

### 6.6 FORCE ROW LEVEL SECURITY on every PHI table

Final state per table (the last ENABLE and FORCE in the chain):

| Table | ENABLE and FORCE at |
|---|---|
| `public.profiles`, `quit_plans`, `program_data` | `T:202609110001:65-66`, `T:202609150001:137-138`, `T:202609260001:32-33` |
| `programme.enrolment`, `programme.sharing_consent`, `record.screen_answer`, `record.lapse_event`, `record.observation`, `identity.child_profile` | `B:…120200:231-242` |
| `programme.enrolment`, `programme.sharing_consent` (lifted and restored) | `B:…120900:60-61` NO FORCE, `:68-69` FORCE again, inside one file; final state FORCE |
| `identity.refresh_session` | `B:…120300:128-129` |
| `care.escalation_policy`, `care.escalation` | `B:…120400:167-170` |
| `ops.device_token`, `ops.notification_preference`, `ops.notification_log` | `B:…120500:145-150` |
| `chronic.profile`, `condition`, `vital_entry`, `medication` | `B:…120600:275-282` |
| `ops.audit_event` | `B:…120900:282-283` |
| `identity.account` | `B:…120900:343-344` |
| `ops.waitlist_enquiry` | `B:…120900:356-357` |

That is 3 + 19 = 22 tables (script constant `EXPECTED_FORCED_TABLES`). `catalogue.*` is non-PHI and has no RLS (`B:…120100:8`); it is excluded.

**The one gap in the static argument.** `NO FORCE` at `B:…120900:60-61` is lifted for the length of one statement. The file is one transaction only if the applier wraps it in one. Backend's own runner did (`B:…120000:11-19`), but the Supabase CLI and the integration are the appliers here, and this is **Unknown** (not documented in 3.2). If a file is applied statement by statement, `programme.enrolment` and `programme.sharing_consent` are unforced for the length of the backfill; on production they would hold no rows (fact 1.4: Backend's tables are new), so the window exposes nothing, but this is stated, not hidden. Checked by the script only at the end state.

Live check (S3 and S8, read-only, owner). Run in the SQL editor; no password or key is needed beyond the owner's session:

```sql
select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p')
   and (n.nspname in ('identity','programme','record','care','chronic','ops')
        or (n.nspname = 'public' and c.relname in ('profiles','quit_plans','program_data')))
 order by 1, 2;
select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('postgres','authenticated','anon');
```

Record `rolbypassrls` for `postgres` here: it is the open R-061(a) item (`runs/2026-10-13-BE-001-b2-review.md:184`) and the reason B1's owner-policy design matters on hosted (section 11).

### 6.7 Backend's own `DROP` statements

Only `DROP POLICY` on Backend tables, in `B:…120900:96` (`sharing_consent_own`), `:121-125` (five recipient policies), `:165` (`care.escalation`). All objects are Backend's own, created in `…120200`/`…120400`; none is a Tether-Health object.

## 7. Rehearsal (acceptance criterion 4)

Script: `scripts/rehearse-migration-history.sh` (shellcheck 0.11.0 clean; `bash -n` OK; **not executed**).

**Result: NOT RUN. Reason: no Docker daemon on this Mac (`runs/2026-10-12-BE-002.md:17`, repeated in the dispatch) and `psql` is not installed. It is now owner check OC-3.**

What `rehearse` does, on a stack it creates itself (project id `ops021-rehearsal`, db port 55322, which it refuses to use if anything already listens there, and never resets or stops anything else):

1. Writes a temporary project with storage enabled, copies Tether-Health's 9 from `origin/develop`, `supabase start` applies them.
2. Seeds synthetic users: three `example.invalid` addresses with fixed UUIDs, profiles, quit plans, program data, avatar objects.
3. Snapshots every protected object (row counts and row hashes of the three tables, avatars bucket row, function definitions and ACLs of the 8 Tether-Health functions, policy text, `auth.users` triggers, column and constraint hashes, table and column ACLs, ledger).
4. Copies Backend's 12 re-versioned (refusing if a new version does not sort after `202610030001` as a string and as a number), `supabase migration up --local`, seeds Backend synthetic rows.
5. Compares every key (row counts unchanged, nothing dropped or rewritten), checks ENABLE and FORCE on all 22 PHI tables, cross-user reads as `authenticated` and as a Backend group role (both with a non-vacuity check), anon denied, no-principal reads return nothing, the deletion functions run and roll back, 21 ledger rows.

Refusals (exit 2): non-loopback `PGHOST`; `DATABASE_URL`, `PGSERVICE`, `PGSERVICEFILE`, `PGHOSTADDR`, `SUPABASE_DB_URL`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID` set; `PGPORT` set to anything but 55322; no `PGPASSWORD`; port 55322 already open. It never runs `supabase link`, `db push` without `--local`, or any hosted command. It contains no password, DSN, key or real address.

**Expected outcome of the first run (Inferred, not observed):** one FAIL, `unchanged: def.set_updated_at()|…`, for the reason in 4.2. Everything else should pass. If more fails, the plan is wrong in that place; do not approve it.

**Owner check OC-3 (exact commands, on a machine with Docker, the supabase CLI and `psql`):**

```sh
cd <path to this worktree or the branch checkout>
export TETHER_HEALTH_REPO=<path to a Tether-Health clone with origin/develop fetched>
export PGPASSWORD=<the password of the local stack's postgres role, see `supabase status` after it starts; never a hosted password>
unset DATABASE_URL PGSERVICE PGSERVICEFILE PGHOSTADDR SUPABASE_DB_URL SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_ID
bash scripts/rehearse-migration-history.sh probe-ordering 2>&1 | tee /tmp/ops021-probe.log
bash scripts/rehearse-migration-history.sh rehearse 2>&1 | tee /tmp/ops021-rehearse.log
```

Paste both logs into the OPS-021 handoff. The local stack's own database password is a documented local default and is not a secret of ours; it is still not written in any file here.

**Assumed, not verified (command syntax):** `supabase start|stop|migration list|migration up|db push --workdir <dir>`, `--local`, `--dry-run`, `--include-all`, `--no-backup`, and that `supabase start` applies the migrations in the project directory on first start. They are from memory of the CLI. If any flag differs, the script fails early and loudly.

**Assumed:** the local `postgres` role has `BYPASSRLS` (the seed inserts rely on it). The script prints it (section 6.6 query) and records it for R-061(a).

## 8. Rollback, per step (acceptance criterion 5)

Principle: Backend's 12 migrations only **create** objects in new schemas, new roles, one extension, and two `public` functions (plus the 4.2 rewrite, removed by P-1), so before any Backend data exists they can be undone without touching Tether-Health's objects. After data exists they cannot be undone by SQL alone.

| Step | Undo | Kind |
|---|---|---|
| S1 repo change | `git revert` | Down by code |
| S2 rehearsal | `supabase stop --no-backup --workdir <tmp>` | Disposable |
| S4 backup | none needed | n/a |
| S5 merge or `deploy` branch | Delete the branch or disable "Deploy to production" **before** S6 | Setting |
| S6 apply, **before any Backend row is written** | Down script (draft, **NOT RUN**, to be rehearsed by the implementing ticket): see below | Down script |
| S6 apply, **after** Backend rows exist or services are connected | Restore from backup or PITR to the S4 point, losing every write after it, including Tether-Health's app writes | Restore |
| S7 unlock a login role | `ALTER ROLE <name> VALID UNTIL '-infinity'`, then change the password | Down script |
| S9 DSN switch | Put the previous DSN back | Setting |
| Backfill (BE-041) | Out of scope; its own rollback | n/a |

**Draft down script for S6 (not executed; to be rehearsed on the local stack as a later phase of the script by the implementing ticket):**

```sql
-- Backend objects only. Nothing here names public.profiles, quit_plans,
-- program_data, storage.*, auth.* or any Tether-Health function.
alter publication supabase_realtime drop table record.observation;
alter publication supabase_realtime drop table programme.sharing_consent;
drop schema identity, catalogue, programme, record, care, chronic, ops cascade;
drop function if exists public.app_account_id();
-- public.set_updated_at(): restore T:202609110001:30-39 verbatim, only if P-1 was not applied.
-- For each tether_* role (groups and *_login): drop owned by <role>; drop role <role>;
delete from supabase_migrations.schema_migrations where version >= '20261015000000';
```

The publication lines apply only where `supabase_realtime` exists (`B:…120700:108-111`). `citext` is left installed (harmless; `B:…120000:23`). The ledger delete is a hand edit of the production ledger and is the one place this plan does so; it is the undo of a failed first apply and is owner-run.

**Point of no return:** the first row written into any Backend table, or the first login role unlocked and connected, whichever is first. After it, S6 is only reversible by restore, and a restore also discards Tether-Health app data written since the backup. PITR availability is Unknown; if it is absent, the backup in S4 is the only restore point.

## 9. Per-service LOGIN roles on hosted Supabase without superuser (acceptance criterion 6)

- `B:…120800:44-101` creates nine NOLOGIN group roles and nine LOGIN roles with `CREATE ROLE … LOGIN VALID UNTIL '-infinity' IN ROLE …`, no password, no superuser attribute, and does **not** run `ALTER ROLE … NOSUPERUSER` (the concern at `runs/2026-10-12-BE-001.md:10`; the file now says why at `:19-27`). It then raises if any `tether_` role is privileged (`:164-177`).
- Whether Supabase's `postgres` can `CREATE ROLE` on the hosted project: **Inferred yes** (on hosted Supabase `postgres` holds `CREATEROLE`; not shown here), **Unknown** for this project. Owner check OC-4: on the hosted SQL editor, read-only: `select rolcreaterole, rolsuper, rolbypassrls from pg_roles where rolname = 'postgres';`.
- The password and the unlock (`ALTER ROLE <name> PASSWORD '…' VALID UNTIL 'infinity'`) are **owner dashboard or SQL-editor steps** (S7, Tier 3). No agent sets, sees or stores a password (`B:…120800:29-34`, `B:db/ROLES.md`).
- How a service connects as `tether_<service>_login` through Supabase's pooler or directly is Unknown (the username format the pooler expects). Owner check OC-5.
- Group-role privileges are granted to the groups, so rotating a login credential touches no grant (`B:…120800:11-17`).

## 10. Owner actions (acceptance criterion 7)

No agent touches the hosted project in this plan. Each item below is the owner's.

| ID | Action | Tier |
|---|---|---|
| O-1 | Approve or amend this plan | 3 |
| O-2 | Decide B1 and R-063 (open; they change `…120900` and `…121100`) | 3 |
| O-3 | Approve BE-001 after th-qa, th-reviewer, th-security | 3 |
| O-4 | Authorise the S1 implementing ticket (adds 9 files, renames 12, edits foundation for P-1, updates tests and docs) | 3 |
| OC-1 | Fetch the three documentation pages and fill 3.2 with URL, date, exact sentence | 2 (read-only) |
| OC-2, OC-3 | Run `probe-ordering` and `rehearse` on a Docker machine, file the output | 2 (local) |
| OC-4, OC-5 | Read-only hosted checks in section 9 | 3 |
| O-5 | Read-only live checks S3, S8 (section 6.6) | 3 |
| O-6 | Backup, and confirm whether PITR exists (S4) | 3 |
| O-7 | Push the S1 branch (Tier 2); create `deploy`; enable "Deploy to production"; trigger the first apply (S5, S6) | 2 for the push, 4 for the rest |
| O-8 | Confirm the integration's Data API settings: that the dashboard's exposed schemas do not add `identity`, `programme`, `record`, `care`, `chronic`, `ops`. `B:supabase/config.toml` `[api] schemas` lists them; whether the integration pushes that file to the hosted project is Unknown | 3 |
| O-9 | Set and unlock the nine login-role passwords (S7); keep them in the owner's secret store only | 3 |
| O-10 | Switch each service's `DATABASE_URL` (S9); rotate the superuser credential after | 4 |
| O-11 | Decide whether adding `record.observation` and `programme.sharing_consent` to the `supabase_realtime` publication (`B:…120700:108-111`) is wanted on the hosted project | 3 |

## 11. Re-check list if B1 or R-063 changes a migration

Any change to a Backend migration changes its sha256 in 2.2. Always re-run section 7 afterwards.

**B1 (`care.lapse_details`; `B:…120900:200-275`, the function, its REVOKEs, and the policies `sharing_consent_lapse_details` and `lapse_event_lapse_details`).** Re-check: section 2.2 (hash), 6.1 (the grep), 6.6 (the FORCE list; the B1 policies are on forced tables, and they are read from `pg_proc` for whichever role ran the migration), 7 (the script's policy and count expectations; the design relies on how the migrator role behaves under FORCE, which differs between local `postgres` and hosted, see `rolbypassrls` in 6.6), 8 (the down script drops the schemas, so it covers any B1 variant, but the function owner and any extra roles or grants must be re-read), 9 (a variant that adds a role or grant), 10 (O-2, O-3).

**R-063 (`recipientId`; `B:…121100:21-65`, the `notify_consent_change` replacement and the `sharing_consent_recipient_id_uuid` CHECK `NOT VALID`).** Re-check: section 2.2 (hash), 6.1, 7 (a CHECK or NOTIFY change is exercised by neither the cross-user nor the count checks; add assertions in the implementing ticket if the contract changes), 8 (the CHECK is dropped with the schema; `VALIDATE CONSTRAINT` is a later step that touches BE-041), 5.1 (`db/test/migrations.test.ts` for both), 10 (O-2). The API contract change itself (`packages/contracts`) is Tier 3 and not part of this plan.

If **either** file is **renamed, split or reordered**: sections 2.2, 4.1, 5, 7 and 8 in full.

## 12. Risks, assumptions, unknowns

- **R-1 (Inferred):** foundation's unqualified `set_updated_at()` rewrites a live function (4.2). Blocks approval of Option A until P-1.
- **R-2 (Unknown):** CLI and integration behaviour on out-of-order versions (section 3). Option A avoids the question; it does not answer it.
- **R-3 (Unknown):** whether each file is applied inside one transaction (6.6, `NO FORCE` window).
- **R-4 (Assumed):** the rename date `20261015`; any later value that is greater than `202610030001` and not earlier than the first apply is equivalent.
- **R-5 (Unknown):** the CI `migrate` job (1.8) is broken, so no automated check applies the chain. The rehearsal script is the only one, and it is not run.
- **R-6 (Unknown):** whether the integration is connected to Backend at all (BASELINE.md:99). Until O-8 and S5 are settled, a merge to Backend `main` may apply the chain (BASELINE.md:101).
- **R-7:** the rehearsal script and the down script have never been executed. Treat both as unproven.
- **Assumed:** the live state in section 1 (rows 1.1, 1.2) has not changed since 2026-10-12.
- The plan makes no statement that the result is "secure", "compliant" or "production ready".
