# Cephalopod brain — self-host image (build context: ./brain).
# Multi-stage: compile native deps (better-sqlite3) in a builder, ship a lean
# runtime that runs as a non-root user.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
# build tools are only needed if a prebuilt better-sqlite3 binary isn't available
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
# runtime deps only (incl. tsx, which `npm start` uses) — no typescript/vitest/@types
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    CEPH_DB=/data/brain.db \
    CEPH_PORT=7700 \
    CEPH_HTTP_PORT=7701
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . ./
RUN mkdir -p /data && chown node:node /data
# drop root: run as the unprivileged `node` user (uid 1000) shipped in the base image
USER node
VOLUME ["/data"]
EXPOSE 7700 7701
# liveness for `docker run`/k8s (compose declares its own too)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:7701/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# WS relay :7700, HTTP API :7701; data persists in the /data volume
CMD ["npm", "start"]
