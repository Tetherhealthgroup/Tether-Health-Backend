# Production runbook: Tether-Health-Backend (DRAFT)

> **DRAFT. NOT APPROVED. DO NOT EXECUTE.**
>
> - Writing this draft is **Tier 2a** (agent, worktree only, nothing pushed).
> - **Approving or using it is Tier 3, and the owner does it.**
> - **Executing any step in it is Tier 4. Only the owner does that, under their own login.**
>
> No agent may run a step below. The only external contact made to write this was one read-only fetch of Render's public pricing page (§6), which the dispatch permitted. No agent has signed in to, queried or changed Render, Supabase or GitHub, and no agent has seen a secret value. Every value shown is a placeholder in `<angle brackets>`. Ticket: OPS-022 (office repo `backlog/OPS-022.md`). Risks: R-032 (superuser DSN / RLS bypass) and R-070 (office-guard and `supabase/` reads).

Evidence labels used throughout: **Verified** (evidence exists), **Observed** (seen in code or output), **Inferred** (reasoned, not proven), **Assumed** (missing information), **Unknown**. File references are to this repository at `origin/main` (`0533885`) unless another commit is named.

---

## 0. Status of each section

| § | Topic | State |
|---|---|---|
| 1 | Env var table, all 10 services | Written. It exposes **four render.yaml defects that stop services booting** (§1.4). Those block applying the Blueprint. |
| 2 | Live JWKS and `SUPABASE_JWT_ALGORITHM` | Owner steps written. Algorithm: owner evidence says ES256, **not re-checked by an agent** |
| 3 | Tether signing key pair | Steps written. **Custody is an open owner decision** (§10, D-3) |
| 4 | Supabase service-role key | **Options only. The decision is open** (BE-047, OPS-034 DEC-KEY). Owner fields blank. |
| 5 | Per-service `DATABASE_URL` roles | Cited from BE-001 at `79685b2`. **Pending BE-001 review** |
| 6 | Cost | **Unknown**: the public pricing page could not be read (§6) |
| 7 | Keeping production unchanged: `autoDeploy` and the Supabase GitHub integration | Written. Settings are owner decisions D-5 and D-6 |
| 8 | Rollback and teardown | Written |
| 9 | Migrations | Linked to OPS-021, not restated |
| 10 | Owner decision checklist | Written, fields blank |
| 11 | Follow-up defects found | Listed, none fixed here (doc-only ticket) |

---

## 1. Environment variables, every service in `render.yaml`

### 1.1 How configuration is read (Observed)

- Every service validates its environment once at boot through `loadConfig` (`packages/core/src/config.ts:91-108`). It throws on any missing or malformed value and lists every problem, so **a service with a missing required variable does not start** (`config.ts:98-104`).
- `baseSchema` (`config.ts:23-80`) applies to all ten services. Each service merges its own extra schema on top:

| Service (`render.yaml` name) | Loads config at | Extra schema |
|---|---|---|
| `tether-api-gateway` (web, public) | `services/api-gateway/src/index.ts:23` | `services/api-gateway/src/config.ts:15-47` |
| `tether-auth` (pserv) | `services/auth-service/src/index.ts:30` | `services/auth-service/src/config.ts:34-113` |
| `tether-catalogue` (pserv) | `services/catalogue-service/src/index.ts:29` | none |
| `tether-enrolment` (pserv) | `services/enrolment-service/src/index.ts:30` | none |
| `tether-records` (pserv) | `services/records-service/src/index.ts:23` | none |
| `tether-care-team` (pserv) | `services/care-team-service/src/index.ts:30` | none |
| `tether-notification` (pserv) | `services/notification-service/src/index.ts:59` | `index.ts:60-81` |
| `tether-website` (pserv) | `services/website-service/src/index.ts:39` | `index.ts:40-69` |
| `tether-chronic` (pserv) | `services/chronic-service/src/index.ts:81` | `index.ts:82-93` |
| `tether-realtime` (pserv) | `services/realtime-service/src/index.ts:43` | `index.ts:44-49` |

- Keys in `render.yaml` that no schema names are silently ignored. Zod object parsing drops unknown keys, so they cause no error (Inferred from `z.object` default behaviour, not executed).

**Source column key:** *literal* is a fixed value in `render.yaml`. *shared group* is `envVarGroups: tether-shared` (`render.yaml:249-270`). *auth group* is `tether-auth-secrets` (`render.yaml:272-281`). *sync:false* means the owner sets the value in the host dashboard and it never lives in git (`render.yaml:247-248`). *code default* means the variable is not in `render.yaml` and the default in code applies. **NOT SET** means it is required by code and absent from `render.yaml` (a defect, §1.4).

### 1.2 Base variables (every service)

| Name | Consuming file:line | Source in `render.yaml` | Secret | Placeholder example |
|---|---|---|---|---|
| `NODE_ENV` | `packages/core/src/config.ts:24` | literal `production` per service (`render.yaml:55,93,112,130,148,166,184,206,224,242`) | no | `production` |
| `SERVICE_NAME` | `config.ts:25` | literal per service (`render.yaml:51-52,89-90,108-109,126-127,144-145,162-163,180-181,202-203,220-221,238-239`) | no | `auth-service` |
| `PORT` | `config.ts:26` | literal 8000–8009 per service (`render.yaml:53-54,91-92,110-111,128-129,146-147,164-165,182-183,204-205,222-223,240-241`) | no | `8001` |
| `LOG_LEVEL` | `config.ts:27-29` | shared group literal `info` (`render.yaml:267-268`) | no | `info` |
| `PUBLIC_API_URL` | `config.ts:32` | shared group, sync:false (`render.yaml:261-262`) | no | `https://<public-api-host>` |
| `ALLOWED_ORIGINS` | `config.ts:41` | shared group, sync:false (`render.yaml:265-266`). Empty denies all (`config.ts:34-40`) | no | `https://<app-origin-1>,https://<app-origin-2>` |
| `JWT_ISSUER` | `config.ts:44`. Also the **signer's** `iss` (`services/auth-service/src/index.ts:59`) | shared group, sync:false (`render.yaml:253-254`) | no | `https://<tether-issuer-host>` |
| `JWT_AUDIENCE` | `config.ts:53`. Also the signer's `aud` (`auth-service/src/index.ts:60`) | shared group, sync:false (`render.yaml:255-256`) | no | `<tether-audience>` |
| `JWT_JWKS_URL` | `config.ts:56`. Verifiers in the gateway (`api-gateway/src/index.ts:44`) and in auth itself (`auth-service/src/index.ts:86-91`) | shared group, sync:false (`render.yaml:257-258`) | no | `http://<tether-auth-internal-host>:8001/.well-known/jwks.json` (route: `auth-service/src/routes.ts:86`) |
| `JWT_ALGORITHM` | `config.ts:65`. Also the **signing** algorithm of Tether tokens (`auth-service/src/index.ts:58`) | shared group literal `RS256` (`render.yaml:259-260`) | no | `RS256` |
| `DATABASE_URL` | `config.ts:68`. Optional for the gateway only (`api-gateway/src/config.ts:46`) | **origin/main:** one shared value for every service, sync:false (`render.yaml:251-252`). **BE-001 (pending):** one per service (§5) | **yes** | `postgres://tether_<service>_login.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=require` |
| `DB_STATEMENT_TIMEOUT_MS` | `config.ts:71` | code default `5000` | no | `5000` |
| `DB_POOL_MAX` | `config.ts:73` | code default `10` | no | `10` |
| `BODY_LIMIT` | `config.ts:76` | shared group literal `512kb` (`render.yaml:269-270`) | no | `512kb` |
| `RATE_LIMIT_WINDOW_MS` | `config.ts:78` | code default `60000` | no | `60000` |
| `RATE_LIMIT_MAX` | `config.ts:79` | code default `100` | no | `100` |

**Two different "JWT" settings.** `JWT_*` describe **Tether's own** access tokens. auth-service mints them and every service verifies them. `SUPABASE_*` (§1.3) describe the **upstream** Supabase token, which only auth-service accepts (`auth-service/src/config.ts:3-15`). `JWT_ALGORITHM` (Tether, `RS256` in `render.yaml`) and `SUPABASE_JWT_ALGORITHM` (Supabase, §2) are independent. The Tether key pair (§3) must match `JWT_ALGORITHM`, not the Supabase one (Observed: `auth-service/src/index.ts:53-63` passes `config.JWT_ALGORITHM` to the signer).

### 1.3 Service-specific variables

| Service | Name | Consuming file:line | Source in `render.yaml` | Secret | Placeholder example |
|---|---|---|---|---|---|
| api-gateway | `AUTH_SERVICE_URL`, `CATALOGUE_SERVICE_URL`, `ENROLMENT_SERVICE_URL`, `RECORDS_SERVICE_URL`, `CARE_TEAM_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `WEBSITE_SERVICE_URL`, `CHRONIC_SERVICE_URL`, `REALTIME_SERVICE_URL` | `services/api-gateway/src/config.ts:16-24` (each `z.string().url()`, `:13`) | `fromService … property: connectionString` (`render.yaml:59-76`). **See FU-3** | no | `http://<service-internal-host>:<port>` |
| api-gateway | `PROXY_TIMEOUT_MS` | `api-gateway/src/config.ts:34` | code default `15000` | no | `15000` |
| api-gateway | `DATABASE_URL` | `api-gateway/src/config.ts:46` (optional; the gateway opens no pool) | inherited from the shared group (`render.yaml:57`) | yes if set | **leave unset** (§5) |
| auth | `SUPABASE_JWKS_URL` | `services/auth-service/src/config.ts:39` | auth group, sync:false (`render.yaml:274-275`) | no | `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json` (path: **Assumed**; take the exact URL from the owner's JWKS step, §2) |
| auth | `SUPABASE_ISSUER` | `auth-service/src/config.ts:40` | auth group, sync:false (`render.yaml:276-277`) | no | `https://<project-ref>.supabase.co/auth/v1` (**Assumed**; confirm against a token's `iss`, §2) |
| auth | `SUPABASE_AUDIENCE` | `auth-service/src/config.ts:49` | code default `authenticated` | no | `authenticated` |
| auth | `SUPABASE_JWT_ALGORITHM` | `auth-service/src/config.ts:60` | code default `ES256`, **not in `render.yaml`** | no | `ES256` (§2) |
| auth | `ACCESS_TOKEN_PRIVATE_KEY` | `auth-service/src/config.ts:67` (PEM, `:26-32`) | **NOT SET. FU-1** | **yes** | `-----BEGIN PRIVATE KEY-----\n<redacted>\n-----END PRIVATE KEY-----` |
| auth | `ACCESS_TOKEN_PUBLIC_KEY` | `auth-service/src/config.ts:77` | **NOT SET. FU-1** | no (public half) | `-----BEGIN PUBLIC KEY-----\n<redacted>\n-----END PUBLIC KEY-----` |
| auth | `ACCESS_TOKEN_KID` | `auth-service/src/config.ts:86` (optional; defaults to the RFC 7638 thumbprint) | code default | no | leave unset |
| auth | `ACCESS_TOKEN_TTL_SECONDS` | `auth-service/src/config.ts:97-102` (max 3600) | code default `900` | no | `900` |
| auth | `REFRESH_TOKEN_TTL_DAYS` | `auth-service/src/config.ts:112` | code default `30` | no | `30` |
| auth | `JWT_PRIVATE_KEY_PEM` | **consumed by nothing** (`git grep` shows `render.yaml:278` only) | auth group, sync:false (`render.yaml:278-279`) | would be yes | **do not set. FU-1** |
| auth | `INTERNAL_SERVICE_TOKEN` | **consumed by nothing** (`git grep` shows `render.yaml:280` only) | auth group, sync:false (`render.yaml:280-281`) | would be yes | **do not set. FU-2** |
| notification | `FIREBASE_SERVICE_ACCOUNT_JSON` | `services/notification-service/src/index.ts:69` (optional; absent means push is disabled) | sync:false (`render.yaml:189-190`) | **yes** | `<firebase-service-account-json>` |
| notification | `FIREBASE_PROJECT_ID` | `notification-service/src/index.ts:70` (optional) | not in `render.yaml` | no | `<firebase-project-id>` |
| notification | `INTERNAL_API_TOKEN` | `notification-service/src/index.ts:80` (**required**, min 32 chars, no default) | **NOT SET. FU-2** | **yes** | `<random-hex-64-chars>` |
| website | `WAITLIST_DEDUPE_WINDOW_MS` | `services/website-service/src/index.ts:49` | code default `900000` | no | `900000` |
| website | `WAITLIST_RATE_LIMIT_MAX` | `website-service/src/index.ts:57` | code default `5` | no | `5` |
| website | `WAITLIST_RATE_LIMIT_WINDOW_MS` | `website-service/src/index.ts:58-62` | code default `3600000` | no | `3600000` |
| website | `WAITLIST_PURGE_BATCH` | `website-service/src/index.ts:65` | code default `1000` | no | `1000` |
| website | `ADMIN_ROLE` | `website-service/src/index.ts:68` | code default `admin` | no | `admin` |
| chronic | `CHRONIC_VITALS_PAGE_MAX` | `services/chronic-service/src/index.ts:91` | code default `500` | no | `500` |
| chronic | `CHRONIC_VITALS_PAGE_DEFAULT` | `chronic-service/src/index.ts:92` | code default `200` | no | `200` |
| realtime | `SSE_HEARTBEAT_SECONDS` | `services/realtime-service/src/index.ts:46` | code default `25` | no | `25` |
| realtime | `SSE_MAX_SUBSCRIBERS` | `realtime-service/src/index.ts:48` | code default `2000` | no | `2000` |
| catalogue, enrolment, records, care-team | base only (§1.2) | | | | |

Not a Render service, listed for completeness: the seed tool `db/seeds/catalogue.ts` reads `DATABASE_URL` (`:31`) and `CATALOGUE_SOURCE_DIR` (`:43`). It is operator-run and is not part of this runbook.

Under BE-001 (pending, not at origin/main): `TETHER_ALLOW_PRIVILEGED_DB_ROLE` is a local-development escape that is ignored when `NODE_ENV=production` (`git show 79685b2:db/ROLES.md`, lines 142-146). **Never set it on a hosted service.**

### 1.4 Boot-blocking mismatches between `render.yaml` and the code (Observed)

If the Blueprint at origin/main is applied as written:

1. **auth-service does not start.** `ACCESS_TOKEN_PRIVATE_KEY` and `ACCESS_TOKEN_PUBLIC_KEY` are required (`auth-service/src/config.ts:67,77`). `render.yaml` provides neither. It provides `JWT_PRIVATE_KEY_PEM`, which no code reads (`render.yaml:278`). (FU-1)
2. **notification-service does not start.** `INTERNAL_API_TOKEN` is required (`notification-service/src/index.ts:80`) and is absent. `render.yaml` has `INTERNAL_SERVICE_TOKEN` in the auth group instead, and no code reads it (`render.yaml:280`). (FU-2)
3. **The gateway's nine upstream URLs** use `property: connectionString` on `pserv` targets (`render.yaml:59-76`). The locally installed Render plugin reference lists only `host` and `hostport` for `pserv`/`web`. `hostport` also has no `http://` scheme, while the gateway expects a URL (`api-gateway/src/config.ts:13`). Whether Render accepts this is **Unknown** (not checked against Render; Inferred from the local plugin reference). (FU-3)
4. **One shared `DATABASE_URL`** (`render.yaml:251-252`) contradicts the per-service roles (`config.ts:67` "Per service, with that service's own role"; §5). At origin/main nothing in `packages/` or `services/` refuses a superuser or BYPASSRLS role at boot (`git grep rolbypassrls` finds nothing; Observed). BE-001 adds that guard (pending). (R-032)

### 1.5 Health checks (Observed)

- `render.yaml` sets `healthCheckPath: /healthz` on all ten services (`render.yaml:48,86,105,123,141,159,177,199,217,235`).
- `/healthz` is liveness only. It always answers `{status: 'up'}` and touches no dependency (`packages/core/src/http.ts:225-227`).
- `/readyz` returns 503 when the service's readiness check fails (`http.ts:229-239`).
- At origin/main, a healthy `/healthz` therefore says nothing about the database or the role. BE-001 makes a privileged role stop the process before it listens (ROLES.md:108-140, pending).
- After each deploy, the owner checks `/readyz` on each service from inside the private network (ROLES.md:235-236).

**Gate G-1:** do not apply the Blueprint until FU-1 to FU-4 are fixed on a reviewed branch, or until the owner records a decision to work around them by hand.

---

## 2. Supabase JWKS and `SUPABASE_JWT_ALGORITHM` (owner-only)

**Agents never query the live JWKS** (OPS-022 acceptance criterion). The only evidence on record is owner evidence:

> BASELINE.md:127 (office repo, 2026-10-13) records an owner-run check stating that the project's JWKS "signs with ES256".

That is **owner evidence. No agent re-checked it** for this runbook. OPS-022.md:19 still calls the algorithm Unknown (OPS-020 Q2), and OPS-034 §4 records the disagreement. The owner's reading below resolves it.

Owner steps (Tier 4, owner's own machine and login):

1. Open the project's JWKS document. It is the URL that will become `SUPABASE_JWKS_URL`. The usual path is `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json` (**Assumed**; confirm in the Supabase dashboard's JWT signing keys page). It is a public document, but fetch it yourself. Do not paste it into an agent chat.
2. In the `keys` array, note each key's `alg` and `kid`. Do **not** record or share `x`, `y`, `n` or `e`. They are public, but nothing here needs them.
3. If there is exactly one current signing key and its `alg` is `ES256`, set `SUPABASE_JWT_ALGORITHM=ES256` on `tether-auth`. If it is `RS256`, set `RS256`. The code accepts exactly one of the two (`auth-service/src/config.ts:51-60`).
4. If the JWKS lists **keys with different `alg` values** (for example during a Supabase key rotation), stop. The service accepts one algorithm at a time by design (`config.ts:52-58`). Wait until the rotation completes, or record a decision.
5. Sign in to a test account and decode the access token **locally**. Read `iss` and `aud`. Set `SUPABASE_ISSUER` to the exact `iss`. Keep `SUPABASE_AUDIENCE` at its default unless `aud` differs. Use a synthetic test account, never a patient's.
6. Record in the office run log: the date, the `alg` and `kid` values, and who checked. Record no token and no key material.

`render.yaml` does not declare `SUPABASE_JWT_ALGORITHM`, so the code default `ES256` applies unless the owner sets it (follow-up FU-5: declare it explicitly).

---

## 3. Tether access-token signing key pair

**What the code expects (Observed):**
- `ACCESS_TOKEN_PRIVATE_KEY`: a PEM block imported as **PKCS#8** (`importPKCS8`, `auth-service/src/tokens.ts:122`).
- `ACCESS_TOKEN_PUBLIC_KEY`: a PEM block imported as **SPKI** (`importSPKI`, `tokens.ts:123`).
- The algorithm is `JWT_ALGORITHM` (`auth-service/src/index.ts:58`): `RS256` per `render.yaml:259-260`, so an RSA key pair. If the owner changes `JWT_ALGORITHM` to `ES256`, the pair must be P-256 instead, and every verifier changes with it, because the value lives in the shared group.
- Literal `\n` in a single-line value is accepted and unescaped (`auth-service/src/config.ts:17-32`).
- The private key "never leaves this service" (`config.ts:66`). Only `tether-auth` gets it.
- The published JWKS holds **one key only** (`tokens.ts:128-139`).

### 3.1 Generate (owner, Tier 4, on a trusted machine, never in CI or an agent session)

The commands are **Inferred** to produce the expected formats. They have not been executed by an agent.

```sh
# Work in an empty directory that is not inside any git checkout.
umask 077
# RS256 (matches render.yaml JWT_ALGORITHM today). PKCS#8 output.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out access_token_private.pem
# ES256 alternative, only if JWT_ALGORITHM is changed to ES256:
#   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out access_token_private.pem
# SPKI public half
openssl pkey -in access_token_private.pem -pubout -out access_token_public.pem
```

### 3.2 Store

1. Put the private key in the location chosen at **D-3** (§10). Options (the owner chooses; none is chosen here):
   - (a) host secret env var on `tether-auth` only, plus an offline backup in the owner's password or secret manager;
   - (b) a KMS, which the code anticipates but does not implement (`config.ts:72-75`): that needs code work first.
2. Set `ACCESS_TOKEN_PRIVATE_KEY` and `ACCESS_TOKEN_PUBLIC_KEY` **on `tether-auth` only**, in the host dashboard. Never put them in `render.yaml`, in git, in a shared env group, in a chat or in a run log.
3. Delete the working files after storing them (`rm -P` on macOS, or your secure-delete equivalent). Confirm `git status` in every checkout shows no `.pem`.
4. Leave `ACCESS_TOKEN_KID` unset, so it defaults to the thumbprint (`config.ts:79-86`).
5. After deploy, check `tether-auth`'s boot log line `signing key loaded` with a `kid` (`auth-service/src/index.ts:65`), then `GET /.well-known/jwks.json` from inside the private network, and confirm the `kid` matches.

### 3.3 Rotate

1. Generate a new pair (§3.1). Update both variables on `tether-auth` together and redeploy it.
2. **Expected effect (Inferred from `tokens.ts:128-139` and `packages/core/src/auth.ts:51-57`).** The JWKS publishes only the new key. Verifiers re-fetch on an unknown `kid`. Access tokens signed with the old key fail verification and clients must refresh. With the default TTL this is a window of up to 15 minutes (`config.ts:97-102`). Refresh tokens are server-side sessions, not signed by this key (Inferred; not traced in full).
3. For an **emergency rotation** (a suspected leak) the same steps apply, and the short window is the point.
4. Record the date, the new `kid` and the operator in the office run log.
5. Graceful overlap (publishing old and new keys together) is not supported today (FU-6).

---

## 4. Supabase service-role key: options (decision OPEN)

**This section does not choose.** Under OPS-034 (`decisions/OPS-034-backend-owner-decisions.md`, §4 "DEC-KEY"), who may hold the key is an open question for th-security under BE-047 (`backlog/BE-047.md:22,34`). BE-047.md:10 records that the owner provisions it here (Tier 3).

Facts that frame the options (all Observed in the cited files):
- BE-047 needs the key for `auth.admin.deleteUser` and for purging avatars (`BE-047.md:18`).
- `ARCHITECTURE.md:132` rejects "the service-role key in request paths" because it bypasses RLS.
- BE-001's `db/ROLES.md` (at `79685b2`, lines 333-336) says no service in this repository may be handed `service_role`.
- BE-047's acceptance criterion: "Service-role key read from env only, never logged, used by one code path; startup fails if absent in production config" (`BE-047.md:30`).
- BASELINE.md:127: the secret key "belongs only in server env (Render/Supabase secrets), set by the owner". No agent stores it.
- **No service reads such a key at origin/main** (Observed: no `SUPABASE_SERVICE_ROLE_KEY` or similar in §1). Nothing needs to be set today.

| Option | Source | Holder | Scope | Notes |
|---|---|---|---|---|
| A | BE-045.md:20 ("service-role key held only by auth-service") | `tether-auth` only, as a sync:false env var | one code path (BE-047.md:30) | Conflicts with `ARCHITECTURE.md:132` and `ROLES.md:333-336` unless th-security records a scoped exception |
| B | BE-045.md:20 ("a narrowly granted SECURITY DEFINER path") | no service. A database function does the privileged step | the function only | Needs migration work. `auth.users` deletion through SQL is not assessed here (Unknown) |
| Other | none in the sources | | | Owner or th-security to add |

**Owner fields (leave blank until th-security's BE-047 decision is recorded):**

- Option chosen: `________`
- Holder (service name, or "none"): `________`
- Env var name: `________`
- Scope (which operations): `________`
- Where the master copy lives: `________`
- Rotation interval and trigger: `________`
- th-security decision reference: `________`
- Approved by / date: `________`

Rotation outline, whichever option is chosen. Inferred from BASELINE.md:127 (the project uses Supabase's new secret API keys); not checked against Supabase documentation. Create a new secret key in the Supabase dashboard, set it on the holder, redeploy, confirm the deletion path works with a synthetic account, then revoke the old key. Never paste the key into an agent session.

---

## 5. Per-service `DATABASE_URL` roles (PENDING BE-001 REVIEW)

Source: `git show 79685b2:db/ROLES.md` (branch `office/BE-001-rls-roles`, read only). **BE-001 is not reviewed or merged**, so this section is provisional. At origin/main, `render.yaml` still has one shared `DATABASE_URL` (§1.4 item 4).

| Service | Login role (ROLES.md:21-22, 41-74) | Pooler (ROLES.md:212-217) |
|---|---|---|
| api-gateway | **none**: no data, no role (ROLES.md:25). Leave `DATABASE_URL` unset | n/a |
| auth | `tether_auth_login` | transaction pooler, port 6543 |
| catalogue | `tether_catalogue_login` | transaction pooler |
| enrolment | `tether_enrolment_login` | transaction pooler |
| records | `tether_records_login` | transaction pooler |
| care-team | `tether_care_team_login` | transaction pooler |
| notification | `tether_notification_login` | transaction pooler |
| website | `tether_website_login` | transaction pooler |
| chronic | `tether_chronic_login` | transaction pooler |
| realtime | `tether_realtime_login` | **direct connection or session pooler**: `LISTEN` does not survive transaction pooling |

DSN shape (ROLES.md:208-212), placeholders only:
`postgres://tether_<service>_login.<project-ref>:<password>@<host>:<port>/postgres?sslmode=require`

Rules from ROLES.md, cited, not restated in full:
- Roles are created locked; the owner sets each password with `\password` and unlocks (lines 180-204).
- **Code and DSN move together.** Never point origin/main code at the new roles, or BE-001 code at the superuser DSN (lines 227-239).
- After cutover, **rotate the superuser password**: it sat in a shared env group (lines 237-239).
- Role rotation (lines 241-252).
- **Never paste the superuser or `postgres` DSN into any service** (R-032).

Under BE-001, `render.yaml` moves `DATABASE_URL` onto each service (ROLES.md:221-225). That change is BE-001's and is not made here.

---

## 6. Cost estimate for `plan: starter` (UNKNOWN)

- `render.yaml` declares 10 services, all `plan: starter`, `region: oregon` (`render.yaml:38-244`): one `web` and nine `pserv`. Private services are not available on the free tier (`render.yaml:25`).
- **Pricing source:** `https://render.com/pricing`, fetched read-only on **2026-10-14**. The fetched page contained headings ("Workspace Plans", "Compute") but **no prices, CPU or RAM figures**. The content is apparently loaded dynamically. No other page was fetched.
- **Estimate: Unknown.** This runbook gives no monthly figure. Arithmetic for the owner once the per-instance price is read from the live page: **10 × (Starter instance monthly price) + workspace plan fee (if any) + bandwidth/build overage (if any)**. Label the result an estimate, with its URL and date.
- **The owner decides (D-2).** Whether the Render account exists is Unknown (OPS-022.md:18).

---

## 7. Keeping production unchanged until OPS-023 and TH-104 say go

Two independent paths could change production on a merge.

### 7.1 Render `autoDeploy: true`

- Every service has `autoDeploy: true` (`render.yaml:49,87,106,124,142,160,178,200,218,236`). No `branch:` is set, so services track the branch chosen when the Blueprint is connected, presumably the default branch `main` (**Inferred**).
- `render.yaml:9-14`: Render was already connected to this repository by hand before the Blueprint existed (Observed comment). Whether any service is live is **Unknown**. The owner checks in the dashboard, read-only.
- Applying a Blueprint makes it the source of truth for the fields it names (`render.yaml:9-14`). A dashboard toggle can therefore be overwritten on the next sync (**Inferred**).
- The local Render plugin reference marks `autoDeploy` as deprecated in favour of `autoDeployTrigger: commit | checksPass | off` (Inferred; not checked against Render's live docs) (FU-7).

**Safe settings until go (owner chooses at D-5):**

| Option | Effect | Change needed |
|---|---|---|
| 5a. Do not apply the Blueprint, and suspend or leave uncreated any hand-made services | nothing deploys | none in git |
| 5b. `autoDeployTrigger: off` on every service, deploy manually after go | merges do not deploy | `render.yaml` change on a reviewed branch (not made here) |
| 5c. Set `branch: deploy` (or another branch nobody pushes) | only a push to that branch deploys | `render.yaml` change, plus discipline on that branch |

Until D-5 is decided: **do not merge to Backend `main`** while any Render service may be tracking it.

### 7.2 Supabase GitHub integration

- BASELINE.md:101: if the integration is connected to Backend `main`, the next merge could apply Backend's migrations to production, including the RLS-bypass design (R-032).
- BASELINE.md:108 (owner decision 2026-10-12): the integration's production branch is to be **`deploy`**, **which does not exist yet**. It must not be created, and "Deploy to production" must not be enabled, until BE-001 is reviewed and the migration-history plan says how Backend's migrations go onto the live database.
- Which repository the integration is connected to is Unknown (BASELINE.md:99).

**Settings until OPS-023 and TH-104 say go (D-6):**
1. Do not create the `deploy` branch.
2. Keep "Deploy to production" disabled in the integration settings. The owner confirms this read-only in the dashboard and records the date.
3. Do not merge migration-bearing commits to Backend `main` while the integration might track `main`.
4. Undoing the first-apply steps (S5, S6) is covered in the OPS-021 plan, §8: delete the branch or disable "Deploy to production" **before** S6.

**Go criteria:** OPS-023 records the owner's schema go, TH-104 records the client cutover go, G-1 is cleared, and D-1 to D-6 are filled in.

---

## 8. Rollback and teardown (owner, Tier 4)

### 8.1 Application rollback (Render)

1. Roll the affected service back to its previous successful deploy from the dashboard (**Inferred** capability, not checked).
2. If the bad change is in a shared env group (for example `JWT_ALGORITHM` or `JWT_ISSUER`), revert the group value. **Every service** reads it, so redeploy or restart all ten.
3. A signing-key mistake: put back the previous key pair on `tether-auth` (from the D-3 custody location) and redeploy `tether-auth`. Clients re-authenticate (§3.3).
4. **Code and DSN move together** (§5). Rolling code back across the BE-001 boundary also means rolling back each `DATABASE_URL`.
5. Mobile clients keep using NestJS until TH-104 flips them, so a Backend rollback before TH-104 has no user effect (Inferred from office `backlog/TH-104.md:24,26`: the default stays `nest`, and the target is a build-time flag).

### 8.2 Database rollback

Not restated here. See §9 (OPS-021 plan §8, per step) and OPS-023 (office repo) for the production schema move and its point of no return.

Emergency lock of one service's login role, from ROLES.md:27-29 (BE-001, pending):
`ALTER ROLE tether_<service>_login VALID UNTIL '-infinity';`

### 8.3 Teardown (stop spend, remove access)

1. Disable auto-deploy, or suspend all ten services.
2. Delete the services and the two env groups (`tether-shared`, `tether-auth-secrets`).
3. Rotate everything that was set there, treating it as exposed: each login role's password (ROLES.md:241-252), the Tether signing key (§3.3), `INTERNAL_API_TOKEN`, the Firebase service account (revoke the key in the Firebase console), and the service-role key if one was issued (§4).
4. Remove any GitHub ↔ Render connection for this repository if hosting is abandoned.
5. Leave the Supabase project and integration untouched unless OPS-023 says otherwise.
6. Confirm in the billing view that nothing is still charging, and record the date. Billing behaviour is Unknown (§6).

---

## 9. Migrations

**Not covered here.** `render.yaml` deliberately does not run migrations (`render.yaml:29-34`). The plan for getting Backend's migrations onto a database that already holds Tether-Health's 9 is OPS-021's:

- `docs/MIGRATION_HISTORY_PLAN.md` at commit **`f62b5a3`** on branch `office/OPS-021-migration-history` (unmerged; DEC-PLAN in OPS-034 §3 is open). Read it with `git show f62b5a3:docs/MIGRATION_HISTORY_PLAN.md`. Its §5 is the target sequence, §8 is rollback per step, §9 covers per-service roles on hosted Supabase, and §10 lists owner actions.
- Production execution is OPS-023's (office repo `backlog/OPS-023.md`).

---

## 10. Owner decision checklist

Each item is Tier 3 to decide. Acting on any of them is Tier 4. Leave a field blank until it is decided.

| # | Decision | Inputs in this doc | Decision | By / date |
|---|---|---|---|---|
| D-1 | **Hosting**: Render (as `render.yaml` assumes) or another host. Does the Render account exist? | §1.4, §6, OPS-034 DEC-HOST | | |
| D-2 | **Plan and cost**: `starter` × 10, and the monthly estimate with its source and date | §6 (Unknown today) | | |
| D-3 | **Signing-key custody**: where `ACCESS_TOKEN_PRIVATE_KEY` lives, who can read it, the backup location, rotation interval | §3 | | |
| D-4 | **Service-role key scope**: option, holder, scope, rotation (after th-security's BE-047 decision) | §4 | | |
| D-5 | **`autoDeploy` setting**: 5a / 5b / 5c | §7.1 | | |
| D-6 | **Integration branch**: keep `deploy` uncreated and "Deploy to production" off until go; confirm the connected repo | §7.2 | | |
| D-7 | `SUPABASE_JWT_ALGORITHM` value after the owner's JWKS read | §2 | | |
| D-8 | `JWT_ALGORITHM` for Tether tokens: keep `RS256` or change to `ES256` (key type follows) | §1.2, §3 | | |
| D-9 | `ALLOWED_ORIGINS` and `PUBLIC_API_URL` exact values | §1.2 | | |
| D-10 | Fix route for FU-1 to FU-4 (gate G-1) | §1.4, §11 | | |

---

## 11. Follow-up defects found (none fixed here: doc-only ticket)

| ID | Defect | Evidence | Effect |
|---|---|---|---|
| FU-1 | `render.yaml` names `JWT_PRIVATE_KEY_PEM`; the code needs `ACCESS_TOKEN_PRIVATE_KEY` and `ACCESS_TOKEN_PUBLIC_KEY` | `render.yaml:278-279`; `auth-service/src/config.ts:67,77` | auth-service fails at boot (Inferred from `loadConfig` throwing, `packages/core/src/config.ts:98-104`) |
| FU-2 | `render.yaml` names `INTERNAL_SERVICE_TOKEN` (read by nothing) in the auth group; notification-service needs `INTERNAL_API_TOKEN` (min 32) | `render.yaml:280-281`; `notification-service/src/index.ts:80` | notification-service fails at boot (Inferred, as above) |
| FU-3 | Gateway upstream URLs use `fromService … property: connectionString` on `pserv`; `pserv` exposes `host`/`hostport`, and the gateway needs a scheme | `render.yaml:59-76`; `api-gateway/src/config.ts:13-24`; local Render plugin reference (not live docs) | Blueprint may be rejected, or the gateway fails validation (Unknown) |
| FU-4 | One shared `DATABASE_URL` for all services, including the gateway; no privileged-role guard at origin/main | `render.yaml:57,251-252`; `config.ts:67`; BE-001 `ROLES.md:221-225` | R-032. BE-001 addresses it (pending review) |
| FU-5 | `SUPABASE_JWT_ALGORITHM` is not declared in `render.yaml`; it relies on the code default | `auth-service/src/config.ts:60` | Silent default if the project's algorithm changes |
| FU-6 | JWKS publishes one key, so rotation has no overlap | `auth-service/src/tokens.ts:128-139` | Up to one TTL of failed verifications per rotation (Inferred) |
| FU-7 | `autoDeploy` is deprecated per the local Render plugin reference (`autoDeployTrigger`) | `render.yaml:49` et al.; local plugin reference | Behaviour on newer Blueprint validation is Unknown |
| FU-8 | Local compose: auth-service gets no `SUPABASE_*` or `ACCESS_TOKEN_*`; realtime-service gets no `DATABASE_URL`; `REDIS_URL` is set but read by nothing | `docker-compose.yml:242-252,418-428`; `git grep REDIS_URL` over `services` and `packages` finds nothing | `docker compose up` cannot boot those two services as written (Inferred) |
| FU-9 | `npm run check` fails at origin/main: 388 ESLint errors (pre-existing) | `npm run check` at `0533885` (and identically at this doc's commit) ends `✖ 388 problems (388 errors, 0 warnings)`; reproduced by th-qa | Repo checks are not green at base. BE-002 territory |
