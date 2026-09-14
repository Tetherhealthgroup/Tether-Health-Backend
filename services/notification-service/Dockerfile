# notification-service
#
# Build context is the REPOSITORY ROOT:
#
#     docker build -f services/notification-service/Dockerfile .
#
# which is what makes `@tether/core` resolvable inside the image. See
# ARCHITECTURE.md on the `shared/` directory that could never resolve because
# its build context was the service folder.

FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY services/notification-service/package.json services/notification-service/

# `firebase-admin` is an optionalDependency and is installed here deliberately:
# the *credentials* are what may be absent at runtime, not the package. If the
# registry cannot serve it the install still succeeds, and `push.ts` refuses to
# start in production rather than running with push silently off.
# `npm ci` first, because a lockfile is the only thing that makes an image
# reproducible. The fallback is loud on purpose and covers both ways `npm ci`
# refuses: no lockfile at all, and a lockfile written before this workspace
# existed. A silent `npm install` in a release image is how two deploys of the
# same commit end up with different dependency trees.
RUN npm ci --omit=dev --workspace @tether/notification-service --include-workspace-root \
 || { echo "WARNING: npm ci refused the lockfile - falling back to npm install" >&2; \
      npm install --omit=dev --no-audit --no-fund \
        --workspace @tether/notification-service --include-workspace-root; }

# ---------------------------------------------------------------------------

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core ./packages/core
COPY services/notification-service ./services/notification-service

# No service-account file is copied in, ever. `FIREBASE_SERVICE_ACCOUNT_JSON`
# arrives as an environment variable at run time, and `.gitignore` excludes
# `secrets/`, `*.p8` and `*.pem` so that a stray key cannot reach a build
# context in the first place. A credential baked into a layer is in the registry
# for as long as the tag exists, and rotating it does not remove it.

USER node

EXPOSE 8006

CMD ["node", "--experimental-strip-types", "services/notification-service/src/index.ts"]
