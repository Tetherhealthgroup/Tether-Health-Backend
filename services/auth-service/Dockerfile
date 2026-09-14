# auth-service
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#
#     docker build -f services/auth-service/Dockerfile -t tether/auth-service .
#
# `@tether/core` is a workspace sibling, so it has to be inside the context for
# npm to link it. The repo this backend is modelled on built each service from
# its own directory, which put its `shared/` folder out of reach and is why
# nothing there ever imported it.

# ---------------------------------------------------------------------------
# deps
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app

# Node 24 strips TypeScript types natively. The repo is `noEmit` and its imports
# carry `.ts` extensions, so there is no build output to run — the source is the
# artefact, and anything older than Node 22.6 cannot start this image.
COPY package.json ./
COPY packages/core/package.json ./packages/core/
COPY services/auth-service/package.json ./services/auth-service/

# `npm install` rather than `npm ci`: no `package-lock.json` is committed yet.
# Swap for `npm ci --omit=dev --workspace @tether/auth-service
# --include-workspace-root` the moment one lands.
RUN npm install --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# `node_modules/@tether/core` is a symlink into `packages/core`. Node resolves
# symlinks before deciding whether a file may have its types stripped, so the
# real directory must be present — a `.ts` file reached through `node_modules`
# is refused outright.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.base.json ./
COPY --chown=node:node packages/core ./packages/core
COPY --chown=node:node services/auth-service ./services/auth-service

# Non-root. This process holds the access-token signing key in memory; running
# it as root would mean any code-execution bug in it also owns the filesystem
# the key's PEM is mounted onto.
USER node

# Internal only. This port is never published to the host — the gateway is the
# only service with a host mapping, and it reaches this one over the internal
# network.
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so the process is PID 1 and gets SIGTERM directly; `start()` in
# `@tether/core` drains the listener and then closes the pool.
CMD ["node", "services/auth-service/src/index.ts"]
