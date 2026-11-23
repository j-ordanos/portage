# Portage: one small Node service + a SQLite file. Builds as-is in Dokploy (build type: Dockerfile).
# Mount a volume at /data. No environment variables are required.

# --- build: everything, to compile the server and the web app ---
# The full (non-slim) image has python3, make and g++: if a prebuilt binary for better-sqlite3 or argon2 cannot be
# downloaded, they compile from source instead of failing.
FROM node:22-bookworm AS build
WORKDIR /app
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json biome.json ./
COPY apps ./apps
COPY packages ./packages
RUN corepack enable && pnpm install --frozen-lockfile && pnpm -r build

# --- prod-deps: only what the server needs at runtime (no TypeScript, Vite, React, Biome...) ---
FROM node:22-bookworm AS prod-deps
WORKDIR /app
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY packages/core/package.json packages/core/package.json
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@migrator/server..."

# --- runtime: slim, non-root ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
