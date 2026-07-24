# syntax=docker/dockerfile:1
# WheelDeal - Next.js 14 standalone image for GCP Cloud Run.
#
# Multi-stage: deps (npm ci, cached by manifests) -> builder (next build with
# output:standalone) -> runner (Alpine + only the traced server, ~150MB). The
# container listens on 8080 (Cloud Run's default $PORT) and runs as non-root.

# ---- deps: install the full workspace node_modules (cache-friendly) ---------
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
# npm workspaces: every workspace manifest must be present for `npm ci`.
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
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are INLINED into the client bundle at build time, so the
# anon key must be provided as a build arg (never the service-role key - that
# one is runtime-only).
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal production image ---------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
RUN addgroup -S nodejs -g 1001 && adduser -S nextjs -u 1001
# Standalone output = server.js + the traced node_modules subset only.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
