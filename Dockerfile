# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────────────
# Debian 12 (bookworm) + OpenSSL 3 so the Prisma engine target
# (debian-openssl-3.0.x) matches the distroless runtime below.
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

# `prisma generate` runs on postinstall and must parse a schema that references
# env("DATABASE_URL"); a value only has to be PRESENT (generate never connects).
# The real Neon URL is injected at container runtime, never baked in.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

# Install deps against the lockfile first for layer caching. prisma.config.ts +
# the schema are needed because postinstall (`prisma generate`) reads them.
COPY package.json pnpm-lock.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# Build the app, then drop dev dependencies in place. The generated Prisma client
# and its query engine live inside @prisma/client (a prod dep), so they survive.
COPY . .
RUN pnpm build && pnpm prune --prod

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Distroless: no shell, no package manager — smaller surface. nonroot user.
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER nonroot
EXPOSE 3000

# Distroless nodejs images use `node` as the entrypoint; CMD supplies the script.
CMD ["dist/server.js"]
