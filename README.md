# Tether Health — Backend

Node.js + PostgreSQL backend for the Tether Health platform: the two patient
apps, the clinician surface, and the website.

**Status: scaffold.** The foundation, the schema and the service topology are
real. Individual service handlers are being filled in. Nothing is deployed.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the shape and, more usefully, for
what was deliberately *not* copied from `AmericanGroupLLC-Backend` and why.

## Quick start

```bash
cp .env.example .env     # fill in the blanks
npm install
docker compose up --build
curl localhost:8000/healthz
```

## Layout

```
packages/core/          middleware, logging, errors, config, db, auth — one copy
packages/contracts/     zod schemas; OpenAPI is generated from them
services/               one directory per service, gateway on :8000
supabase/migrations/    plain SQL, applied by the Supabase CLI
db/test/                the guards the CLI does not provide
render.yaml             deployment: one public service, eight private
```

## Deploying

Render hosts the API. `render.yaml` defines the gateway as the only public
service and the other eight as private ones with no public URL — the same
topology as the local compose stack, because each service verifies its own JWT
but nothing except the network stands between an internal service and the
internet.

Render was connected to this repository by hand before that file existed.
**Applying a Blueprint takes ownership of the services it names**, so check the
dashboard before the first apply.

Nothing in the Blueprint applies migrations. That is deliberate: auto-deploy
plus auto-migrate means an unreviewed schema change reaching production on a
merge.

## Migrations

`supabase/migrations/`, applied with `npm run db:migrate` (`supabase db push`).
They live there rather than under `db/` so the Supabase GitHub integration can
see them and give each pull request a preview branch with its own database.

The CLI does not check three things a previous custom runner did, each of which
had already caught a real defect here:

- **no migration may open or close its own transaction** — all seven files were
  originally written with `BEGIN`/`COMMIT`, which ends the transaction holding
  the ledger insert and leaves a migration applied but unrecorded
- **no two migrations may share a version**
- **RLS enabled *and* forced, with a policy attached, on every PHI table**

Those are now `db/test/migrations.test.ts`, gated in CI. A guard enforced by a
test that runs on every push is not weaker than one enforced by a runner — but
it is enforced somewhere else, and that has to stay true.

## The rules this backend enforces

Not conventions — they are in the schema, and a service cannot opt out:

- **Health data hangs off an enrolment, never an account.** Reaching a person's
  record requires naming which programme you are reaching into, which is what
  makes the consent check unavoidable. `per_program_sharing`, 42 CFR Part 2.
- **At most two active programmes**, enforced by a deferred constraint trigger
  as well as by the API, because two concurrent joins each see one.
- **A lapse is an event, not a counter.** Append-only, and no column anywhere
  derives a streak that a lapse could reset.
- **Deletion is real.** No soft-delete on PHI; the audit row outlives the data
  and is not a foreign key to it.
- **RLS is enabled and FORCED** on every PHI table, and each service connects as
  its own least-privileged role.
