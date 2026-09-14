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
db/migrations/          plain SQL, applied in lexical order by one ledger
```

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
