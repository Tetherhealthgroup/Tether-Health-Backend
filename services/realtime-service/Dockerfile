# realtime-service
#
# The build context is the REPOSITORY ROOT, not this directory:
#
#     docker build -f services/realtime-service/Dockerfile .
#
# That is the whole reason `@tether/core` is importable from inside the image.
# The repo this is modelled on had a `shared/` directory and a build context of
# the service folder, so `../../shared` was outside the context and could never
# resolve — nothing imported it, and it rotted. docker-compose.yml sets
# `context: .` for every service for the same reason.

# 22.6 is the first release with `--experimental-strip-types`, and the services
# run their `.ts` sources directly rather than emitting JavaScript (every
# tsconfig in the repo is `noEmit`). 24 is the current LTS line and has type
# stripping on by default.
FROM node:24-alpine AS deps

WORKDIR /app

# Manifests only, so a source change does not invalidate the install layer.
# Just the two workspaces this image needs: copying `services/` wholesale would
# pull eight other services' sources into a layer for no reason.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY services/realtime-service/package.json services/realtime-service/

# `npm ci` first, because a lockfile is the only thing that makes an image
# reproducible. The fallback is loud on purpose and covers both ways `npm ci`
# refuses: no lockfile at all, and a lockfile written before this workspace
# existed. A silent `npm install` in a release image is how two deploys of the
# same commit end up with different dependency trees.
RUN npm ci --omit=dev --workspace @tether/realtime-service --include-workspace-root \
 || { echo "WARNING: npm ci refused the lockfile - falling back to npm install" >&2; \
      npm install --omit=dev --no-audit --no-fund \
        --workspace @tether/realtime-service --include-workspace-root; }

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime

# Set in the image rather than left to the environment. A service that reaches
# production with NODE_ENV unset gets development defaults — pretty-printed
# logs the collector cannot parse, among other things — and finding that out
# from a dashboard is worse than finding it out here.
ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core ./packages/core
COPY services/realtime-service ./services/realtime-service

# The migration runner ships here too. It is a few kilobytes of SQL and one
# script, and it gives docker-compose's opt-in `migrate` profile an image that
# already contains the workspace and `pg`. Nothing in this image runs it on
# start: migrations are never applied implicitly, by a container or by a deploy.
COPY db ./db

# node:alpine already provides an unprivileged `node` user. Running as root
# inside a container is one escape away from root on the host, and there is
# nothing this process does that needs it.
USER node

EXPOSE 8007

CMD ["node", "--experimental-strip-types", "services/realtime-service/src/index.ts"]
