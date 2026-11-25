# ---------- Build ----------
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY env.ts ./env.ts
COPY drizzle ./drizzle

RUN npm run build


# ---------- Updater ----------
# Executes the docker operations of the admin area (src/modules/updater). The only image with the docker cli, the
# api image stays without it. Built with --target updater; it comes before "production", so that one stays the default.
FROM node:24-alpine AS updater

LABEL org.opencontainers.image.source="https://github.com/cpietsch82/todo-api"

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

# the image always starts as production, so the safety checks of env.ts (no EXPOSE_ERROR_DETAILS, strong secrets)
# cannot be switched off by a missing APP_STAGE in .env.api; without it env.ts would fall back to "dev"
ENV NODE_ENV=production
ENV APP_STAGE=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Runs as root, because the docker socket of the host belongs to root. The container has no ports.
CMD ["node", "dist/src/modules/updater/index.js"]


# ---------- Production ----------
FROM node:24-alpine AS production

# links the image on GHCR with the repository, so it inherits the access rights of the repository
LABEL org.opencontainers.image.source="https://github.com/cpietsch82/todo-api"

WORKDIR /app

# the image always starts as production, so the safety checks of env.ts (no EXPOSE_ERROR_DETAILS, strong secrets)
# cannot be switched off by a missing APP_STAGE in .env.api; without it env.ts would fall back to "dev"
ENV NODE_ENV=production
ENV APP_STAGE=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# directory for the optional log file (LOG_FILE), mount a volume here to keep the logs outside of the container
RUN mkdir -p /app/logs && chown node:node /app/logs

# the app does not need root rights, the files stay owned by root and are therefore read-only for the app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["./entrypoint.sh"]