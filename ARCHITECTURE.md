# Architecture

This backend serves three front-ends that already exist and disagree with each
other in ways the schema has to reconcile rather than paper over:

| Front-end | What it is | Talks to a backend today |
|---|---|---|
| `www.tetherhealthgroup.com` | Astro static site | No. One waitlist form with no endpoint behind it. |
| `Tether-Health` | Flutter — BreatheFree + LookUp, eleven health areas | **Yes, but not this backend.** It calls the NestJS `Tether-Health/api` (`lib/main.dart:80-97`; routes in `api/src/profile/profile.controller.ts:13`) and Supabase directly (`lib/auth/auth_gateway.dart:85`). See "The client today". |
| `chronic-care` | Flutter — five conditions | A FastAPI service exists but the app never calls it (`API_ONLINE` defaults false). |

---

## The shape

One API gateway, host-exposed. Everything else on an internal network only.

```
                      ┌──────────────────────┐
  Flutter / Astro ───► │  api-gateway :8000   │  ◄── the only published port
                      └──────────┬───────────┘
                                 │ JWT verified once at the edge,
                                 │ re-verified by each service
        ┌───────────┬────────────┼────────────┬───────────┬─────────────┐
        ▼           ▼            ▼            ▼           ▼             ▼
    auth :8001  catalogue   enrolment    records    care-team    notification
                  :8002       :8003       :8004       :8005         :8006
        │           │            │            │           │             │
        └───────────┴────────────┴─────┬──────┴───────────┴─────────────┘
                                       ▼
                         PostgreSQL (Supabase-hosted)
                         per-service roles · RLS FORCE
```

`website :8007` (waitlist) and `chronic :8008` (the chronic-care bridge) sit
alongside.

## Why these services and not others

Each one owns a boundary that something in the product actually enforces:

- **auth** — identity only. Issues nothing a service can forge.
- **catalogue** — the design bundle (`areas.json`, `archetypes.json`,
  `safeguards.json`, products, content). Non-PHI, cacheable, public-read.
  Today the Flutter app ships this as a build-time asset, so an area moving from
  `planned` to `in_development` needs an App Store release. Serving it fixes that.
- **enrolment** — joining, pausing, hiding, and **per-program sharing consent**.
  This is where `two_active_max` and `per_program_sharing` are enforced server-side,
  because the website already promises they are: *"Consent versioning, purpose
  limitation and revocation enforced on the server, not merely reflected in the
  interface"* (`security.astro`).
- **records** — answers, lapses, observations, export and deletion. Every row
  hangs off an enrolment, never off an account.
- **care-team** — the clinician surface, and the only place a share is resolved.
  Separate service because it is the only one that reads across a consent boundary,
  and that deserves its own audit trail and its own blast radius.
- **notification** — FCM/APNs via `firebase-admin`, server-side only.
- **website** — the waitlist endpoint, and nothing else.
- **chronic** — chronic-care's entities, kept in their own schema.

## Three rules that shape the schema

### 1 · Health rows hang off an enrolment, never off an account

`shell.json`'s `per_program_sharing` rule:

> Sharing consent is granted per program, never globally. A cessation coach has no
> business seeing behavioural health data. Under 42 CFR Part 2, substance-use data
> must be segregated regardless.

So there is no `account_id` on `answer`, `lapse_event` or `observation`. They carry
`enrolment_id`, and the enrolment carries both the account and the program. Reaching
a person's data therefore requires naming which program you are reaching into, which
is what makes the consent check unavoidable rather than optional.

This is also why the Flutter app was fixed before this repo was written: it keyed
answers by screen id alone, and because `behavioral` and `digital` both resolve to
the `lookup` product, all 34 screen ids collided and two active programs wrote into
one record. The backend must not re-create that. Answers are keyed by
`(enrolment_id, screen_id)`.

### 2 · Deletion completes, and can be proved to have completed

`PRODUCTION_RELEASE_CHECKLIST.md`: *"Implement verified exports and deletion with
auditable completion."* A delete returns only after the rows are gone, and writes an
`audit_event` that says so. Soft-delete columns are deliberately absent from PHI
tables — a `deleted_at` on a health row is the hidden kind of deletion the safeguard
names.

### 3 · A lapse is an event, never a counter

`slip_never_resets` forbids `streak_reset_on_lapse`. `lapse_event` is append-only:
no `UPDATE`, no `DELETE` outside a full account deletion, and no derived counter
column anywhere that a lapse decrements.

## The client today

Every citation in this section is to `Tether-Health` at `origin/develop` `7b9dab6`
(the revision `decisions/OPS-020-endpoint-mapping.md` read), not to this repo.

- **It has runtime dependencies beyond Flutter, including an HTTP client.**
  `pubspec.yaml:9-19` declares `flutter`, `flutter_secure_storage`, `flutter_tts`,
  `http`, `image_picker`, `supabase_flutter` and `url_launcher`. There is no
  `test/no_third_party_sdks_test.dart` on that revision, so nothing asserts a
  one-dependency limit.
- **It already makes HTTP calls, to a different backend.** The four API clients
  use `package:http` (`lib/profile/profile_api_client.dart:2`,
  `lib/programs/program_data_api_client.dart:3`,
  `lib/quit_plan/quit_plan_api_client.dart:3`,
  `lib/account/account_data_api_client.dart:4`), take their host from
  `API_BASE_URL` (`lib/config/app_config.dart:10`, `lib/main.dart:80-97`) and send
  the Supabase access token as a bearer token (for example
  `lib/profile/profile_api_client.dart:42`). Their paths are `/v1/profile`,
  `/v1/program-data/...`, `/v1/quit-plan` and `/v1/account/...`
  (`lib/profile/profile_api_client.dart:41`,
  `lib/programs/program_data_api_client.dart:42`,
  `lib/quit_plan/quit_plan_api_client.dart:47,54`,
  `lib/account/account_data_api_client.dart:101,112`), which are the NestJS routes
  in `api/src/*/*.controller.ts` (`@Controller("v1/profile")` and the like, e.g.
  `api/src/profile/profile.controller.ts:13`). No client file contains
  `/api/v1`, this gateway's prefix (`git grep "api/v1" -- lib` returns nothing).
- **It talks to Supabase directly for sign-in and avatars.** Sign-in, sign-up and
  password reset use `supabase_flutter` (`lib/auth/auth_gateway.dart:85,101,132`);
  avatar upload and removal go to the `avatars` storage bucket
  (`lib/profile/avatar_storage.dart:26-35`).
- **Firebase is still server-side only.** `firebase-admin` is declared only by
  `notification-service` (`services/notification-service/package.json:17`), which
  says the app receives pushes through the operating system and never links a
  Firebase SDK (`services/notification-service/src/push.ts:16-17`). The app's
  `pubspec.yaml:9-19` lists no Firebase package.

## What is inherited from AmericanGroupLLC-Backend

Adopted: the gateway-only exposure topology, the port scheme, multi-stage non-root
Alpine images, fail-fast env validation, graceful shutdown with a forced-exit timer,
deny-by-default CORS, the pino logger with secret redaction, RFC 7807 problem
details, and the Go auth service's discipline of refresh-token rotation with
family-wide reuse detection.

Deliberately **not** adopted, each for a reason observed in that repo:

| Not copied | Why |
|---|---|
| Middleware duplicated per service | Ten copies there had already drifted (`1mb` vs `512kb` body limits). Here it is one workspace package. |
| A `shared/` directory nothing imports | Its Docker build context was the service directory, so `../../shared` could never resolve. Here the build context is the repo root. |
| `jwt.verify(token, SECRET, {algorithms:['ES256','HS256']})` | Algorithm confusion: the same string offered as both an HMAC secret and an ECDSA key. Here: one pinned algorithm, JWKS, and `iss`/`aud` asserted. |
| The service-role key in request paths | It bypasses RLS, which makes RLS decorative. Here: per-service roles and user-scoped connections. |
| One shared `public` schema for every service | Zero isolation between domains. Here: a schema per bounded context. |
| RLS behind `ALTER TABLE IF EXISTS` | It no-ops and reports success. Here: RLS is `FORCE`, and a migration test fails if a PHI table lacks a policy. |
| Migrations auto-applied to production on push | No gate, no rollback, three competing ledgers. Here: one ledger, and the deploy step requires an approval. |
| Hand-written validation | ~50 bespoke 400 messages there. Here: zod, with OpenAPI generated from the same schemas. |

## Open questions this repo does not decide

Two things are represented as data rather than resolved, because they are strategy
decisions and guessing would bake one in:

1. **Ten areas or eleven.** The website publishes ten; `areas.json` ships eleven and
   links to `/programs/digital/`, which 404s. `areas.json` says of itself: *"It may
   belong as a service line under Mental & behavioral health instead — that is a
   strategy decision, not a data one."* The `area` table therefore carries
   `published_on_site` separately from `status`, so the discrepancy is visible and
   fixable without a migration.
2. **Whether chronic-care and Tether-Health are one product.** They share a legal
   entity, an Apple team and a smoking-cessation programme, and share no entities at
   all. Their tables live in separate schemas here. Merging later is a migration;
   un-merging is not, so separate is the reversible default.
