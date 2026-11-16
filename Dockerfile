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


# ---------- Production ----------
FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# the app does not need root rights, the files stay owned by root and are therefore read-only for the app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["./entrypoint.sh"]