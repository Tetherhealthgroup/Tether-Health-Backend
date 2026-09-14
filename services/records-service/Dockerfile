# records-service :8004
#
# Build from the REPOSITORY ROOT, not from this directory:
#
#     docker build -f services/records-service/Dockerfile -t tether/records-service .
#
# That is the one detail ARCHITECTURE.md singles out from the repo this is
# modelled on: its `shared/` directory had a build context of the service
# folder, so `../../shared` could never resolve, nothing imported it, and it
# rotted into a schema describing tables that no longer existed. `@tether/core`
# is only reachable inside an image if the context contains it.

# ---------------------------------------------------------------------------
# deps — the production dependency tree, and nothing else
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo

# Manifests only, so this layer is cached until a dependency actually changes.
# Source edits — which are most edits — never invalidate it.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY services/records-service/package.json ./services/records-service/

# `npm ci` for the lockfile's exact tree. `--ignore-scripts` because nothing
# here needs a postinstall and a lifecycle script is arbitrary code from the
# dependency graph running in the build.
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# runtime — non-root, no toolchain, no lockfile, no tests
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /repo

ENV NODE_ENV=production PORT=8004 SERVICE_NAME=records-service

# TypeScript is executed directly rather than compiled: the repo sets `noEmit`
# and imports carry `.ts` extensions. Node refuses to strip types from anything
# under `node_modules`, which is exactly why `@tether/core` must stay an
# npm-workspace symlink — its realpath is /repo/packages/core, outside
# node_modules, so the resolved file is eligible.
ENV NODE_OPTIONS=--experimental-strip-types

# An unprivileged user, created before the copies so the image never contains a
# layer in which the application files are owned by root and writable by it.
RUN addgroup -S tether && adduser -S -G tether -h /repo tether

COPY --from=deps --chown=tether:tether /repo/node_modules ./node_modules
COPY --chown=tether:tether package.json ./package.json
COPY --chown=tether:tether packages/core ./packages/core
COPY --chown=tether:tether services/records-service ./services/records-service

USER tether
EXPOSE 8004

# Readiness, not liveness: this asks whether the database answers. An
# orchestrator that cannot tell "starting" from "broken" keeps traffic on a
# service that cannot serve it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:8004/readyz || exit 1

# Exec form, so the process is PID 1 and receives SIGTERM directly — `start()`
# in @tether/core drains on it, and a shell wrapper would swallow the signal and
# turn every deploy into a forced kill.
CMD ["node", "services/records-service/src/index.ts"]
