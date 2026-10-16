# syntax=docker/dockerfile:1.7
# Morrow: one image runs the server, worker and scheduler (choose with MORROW_ROLES
# or the command, e.g. `node apps/cli/dist/bin.js worker`).

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------- dependencies
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# Toolchain for native modules (better-sqlite3) on platforms without prebuilt binaries.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/email/package.json packages/email/
COPY packages/ai/package.json packages/ai/
COPY packages/engine/package.json packages/engine/
COPY packages/sdk/package.json packages/sdk/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN npm run build

# ---------------------------------------------------------------- production dependencies
FROM deps AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    MORROW_ENV=production \
    PORT=4400 \
    DATABASE_URL=sqlite:/app/data/morrow.db
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/cli/package.json ./apps/cli/package.json
COPY --from=build /app/apps/cli/dist ./apps/cli/dist
COPY --from=build /app/apps/cli/bin ./apps/cli/bin
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /app/data && chown -R node:node /app/data \
 && ln -s /app/apps/cli/bin/morrow.mjs /usr/local/bin/morrow
USER node
VOLUME ["/app/data"]
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4400)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run automatically on start.
CMD ["node", "apps/cli/dist/bin.js", "start"]
