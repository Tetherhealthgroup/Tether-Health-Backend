# syntax=docker/dockerfile:1
#
# enrolment-service :8003
#
# Built with the **repository root** as the context:
#
#     docker build -f services/enrolment-service/Dockerfile -t tether/enrolment .
#
# That is the whole reason `@tether/core` and `@tether/contracts` resolve inside
# the image. The backend this one is modelled on kept a `shared/` directory and
# built each service with the service folder as its context, so `../../shared`
# pointed outside the context and could never be copied. Nothing imported it,
# and it rotted into a 346-line schema describing tables that no longer existed.
#
# Node 24: type stripping is on by default there, and this repo has no emit step
# anywhere — `tsconfig.base.json` sets `noEmit`, and both workspace packages
# export `./src/index.ts` directly. `tsc` is the type checker here, not the
# build.

# ---------------------------------------------------------------------------
# deps — production dependencies only
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app

# The lockfile and every workspace manifest. `npm ci` validates the lockfile
# against the full workspace graph, so a partial copy of the manifests fails
# with a mismatch rather than installing a subset. The sources come with them
# because a workspace manifest without its directory is a broken symlink target.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services

# `npm ci` rather than `npm install`: it installs exactly the lockfile and fails
# if the lockfile and the manifests disagree, which is the difference between a
# reproducible image and one that picked up whatever was published this morning.
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# runtime — non-root, no toolchain, no dev dependencies
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    SERVICE_NAME=enrolment-service \
    PORT=8003

WORKDIR /app

# A dedicated, unprivileged account with a fixed uid. Fixed because a volume
# mounted by a host that assumed uid 1000 and a container that allocated 1001 is
# a permission failure that only appears in the environment that has volumes.
# The `node` image already ships a `node` user; a distinct one is used so that
# nothing is running as the account the base image's tooling owns.
RUN addgroup -S -g 10001 tether \
 && adduser  -S -u 10001 -G tether -H -s /sbin/nologin tether

# Root owns the application; `tether` only reads it. A process that cannot write
# its own code cannot be made to persist anything by a request that reaches it.
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root packages ./packages
COPY --chown=root:root services ./services

USER tether

EXPOSE 8003

# Readiness, not liveness: `/readyz` pings Postgres, so an unreachable database
# takes this container out of rotation instead of leaving it answering 500s.
# Node's own fetch, because the image ships no curl and adding one would put a
# network client in the runtime layer to serve a health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8003)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No init shim and no `npm start`. The process must be PID 1 so that the SIGTERM
# an orchestrator sends reaches `server.ts`'s shutdown handler; npm would eat it
# and the container would be killed mid-drain every deploy.
CMD ["node", "services/enrolment-service/src/index.ts"]
