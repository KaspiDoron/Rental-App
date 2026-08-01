# WheelDeal - Next.js 14 standalone image for GCP Cloud Run.
#
# Multi-stage: deps (npm ci, cached by manifests) -> builder (next build with
# output:standalone) -> runner (node:20-slim + only the traced server). slim
# (glibc) over alpine: no libc6-compat/musl edge cases with SWC, and no apk
# step that can fail on a filtered network. The
# container listens on 8080 (Cloud Run's default $PORT) and runs as non-root.
#
# Base images come from mirror.gcr.io (Google's Docker Hub mirror): CI runners
# share egress IPs and Docker Hub's unauthenticated rate limits 403 them - the
# exact "Build image" failure this replaces. The mirror serves the same
# official library images without auth or rate pain.

# ---- deps: install the full workspace node_modules (cache-friendly) ---------
FROM mirror.gcr.io/library/node:20-slim AS deps
WORKDIR /app
# npm workspaces: EVERY workspace manifest must be present or `npm ci` fails
# with a lockfile-sync error. Keep this list in sync with "workspaces" in
# package.json.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/queues/package.json packages/queues/
COPY packages/redis/package.json packages/redis/
COPY packages/shared/package.json packages/shared/
COPY packages/testing/package.json packages/testing/
COPY apps/gateway/package.json apps/gateway/
COPY services/workers/package.json services/workers/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# ---- builder: compile the standalone server ---------------------------------
FROM mirror.gcr.io/library/node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are INLINED into the client bundle at build time, so
# they must arrive as build args (never the service-role key - runtime-only).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal production image ---------------------------------------
FROM mirror.gcr.io/library/node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
# WHAT THIS IMAGE IS, BAKED IN.
#
# The build SHA used to arrive only as a Cloud Run env var set by one step of
# the deploy job. Any other path to production - a console redeploy, a manual
# `gcloud run deploy`, an image promoted from an earlier build - ships the new
# code with the PREVIOUS revision's environment, and the running service can no
# longer say what it is. The owner's self-check read "commit unknown" while
# serving code from a commit it could not name.
#
# An image knows its own identity. Stamped here, it survives every deploy path.
ARG WD_BUILD_SHA=unknown
ARG WD_BUILD_AT=unknown
ENV WD_BUILD_SHA=$WD_BUILD_SHA \
    WD_BUILD_AT=$WD_BUILD_AT
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -m nextjs
# Standalone output = server.js + the traced node_modules subset only.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
