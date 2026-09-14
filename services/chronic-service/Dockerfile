# chronic-service
#
# Build context is the REPOSITORY ROOT:
#
#     docker build -f services/chronic-service/Dockerfile .
#
# which is what makes `@tether/core` resolvable inside the image.

FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY services/chronic-service/package.json services/chronic-service/

# `npm ci` first, because a lockfile is the only thing that makes an image
# reproducible. The fallback is loud on purpose and covers both ways `npm ci`
# refuses: no lockfile at all, and a lockfile written before this workspace
# existed. A silent `npm install` in a release image is how two deploys of the
# same commit end up with different dependency trees.
RUN npm ci --omit=dev --workspace @tether/chronic-service --include-workspace-root \
 || { echo "WARNING: npm ci refused the lockfile - falling back to npm install" >&2; \
      npm install --omit=dev --no-audit --no-fund \
        --workspace @tether/chronic-service --include-workspace-root; }

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core ./packages/core
COPY services/chronic-service ./services/chronic-service

USER node

EXPOSE 8008

CMD ["node", "--experimental-strip-types", "services/chronic-service/src/index.ts"]
