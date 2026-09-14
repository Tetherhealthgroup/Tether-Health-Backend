# api-gateway
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#
#     docker build -f services/api-gateway/Dockerfile -t tether/api-gateway .
#
# That is not a convenience. `@tether/core` is a workspace sibling, and the repo
# this backend is modelled on set its build context to the service directory —
# which put `../../shared` outside the context, made it unreachable at build
# time, and is why nothing in that repo ever imported its own shared code. The
# context is the root so that `packages/core` is genuinely present in the image
# and npm can link it as a workspace.

# ---------------------------------------------------------------------------
# deps — resolved once, with dev dependencies left out of the runtime image
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app

# Node 24 strips TypeScript types natively. This matters here because the repo
# has `noEmit` and imports carry `.ts` extensions: there is no build output to
# run, and the source *is* the artefact. Anything older than Node 22.6 cannot
# start this image at all, which is why the base is pinned above the `>=20.11`
# in the root `package.json`.

# Only the manifests, so that a source-only change reuses this layer.
COPY package.json ./
COPY packages/core/package.json ./packages/core/
COPY services/api-gateway/package.json ./services/api-gateway/

# `npm install` rather than `npm ci`: the repo has no committed
# `package-lock.json` yet. Swap this for
# `npm ci --omit=dev --workspace @tether/api-gateway --include-workspace-root`
# the moment one lands — a build that resolves versions at image-build time is
# a build whose output depends on the day it ran.
RUN npm install --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# `node_modules/@tether/core` is a symlink into `packages/core`, and Node
# resolves symlinks before deciding whether a file may have its types stripped —
# without that, a `.ts` file reached through `node_modules` is refused outright.
# So `packages/` must be copied, not just the link.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.base.json ./
COPY --chown=node:node packages/core ./packages/core
COPY --chown=node:node services/api-gateway ./services/api-gateway

# Non-root. The `node` user ships with the image; creating one would only be a
# different uid with the same privileges.
USER node

EXPOSE 8000

# Liveness only — readiness is `/readyz`, and an orchestrator should be the
# thing that distinguishes them. `fetch` is built in, so this costs no curl.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly. `start()` in
# `@tether/core` handles it and drains; a shell wrapper would swallow the signal
# and turn every deploy into a 10-second kill.
CMD ["node", "services/api-gateway/src/index.ts"]
