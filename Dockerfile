# syntax=docker/dockerfile:1
# Gateway image: multi-stage, production dependencies only, runs as the unprivileged `node` user.
# package-lock.json is used when present (reproducible `npm ci`); generate and commit it with `npm install` once.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# The dashboard manifest must exist because the root package.json declares it as a workspace (its deps are not installed here).
COPY apps/dashboard/package.json apps/dashboard/package.json
# --workspaces=false: install ONLY the gateway's dependencies, not the dashboard's.
RUN if [ -f package-lock.json ]; then npm ci --workspaces=false; else npm install --workspaces=false; fi
COPY tsconfig.json ./
COPY apps/gateway apps/gateway
COPY packages packages
COPY scripts scripts
RUN npm run build && npm prune --omit=dev --workspaces=false

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node config ./config
USER node
EXPOSE 8080
# Liveness only (/health ignores dependencies and providers by design).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/apps/gateway/src/index.js"]
