# syntax=docker/dockerfile:1.7

# ─── dependencies ────────────────────────────────────────────────────────────
# Install only the workspaces the production image needs. The mobile app is
# deliberately excluded; it does not need to be in the server image.
FROM node:22-bookworm-slim AS deps
# Prisma detects the OpenSSL version to pick its engine; slim lacks openssl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
RUN npm ci --ignore-scripts \
      --workspace @stridash/server \
      --workspace @stridash/types \
      --workspace @stridash/web

# ─── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/types ./packages/types
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN npm run prisma:generate -w @stridash/server \
 && npm run build -w @stridash/web

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# The Prisma CLI/engine and outbound HTTPS need these at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Source + generated Prisma client + the built dashboard. The server serves
# both /api/* and the Vite build so one container is a complete deployment.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server ./apps/server
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/types ./packages/types
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
