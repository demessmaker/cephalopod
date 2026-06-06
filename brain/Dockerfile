# Cephalopod brain — self-host image.
#
# Build context is the REPO ROOT: the brain re-exports @cephalopod/core from the
# sibling core/ package (brain/src/core/* -> ../../../core/src/*), so both packages
# must be in the image. Build from the repo root, e.g.:
#   docker build -f brain/Dockerfile -t cephalopod-brain .
# (docker-compose already sets context: . + dockerfile: brain/Dockerfile.)
#
# Multi-stage: compile native deps (better-sqlite3) in a builder, then ship a lean,
# non-root runtime. node_modules is hoisted at /app so core/ and brain/ (siblings)
# both resolve their dependencies via the normal upward node_modules lookup.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
# build tools are only needed if a prebuilt better-sqlite3 binary isn't available
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# brain's deps are a superset of core's runtime deps (incl. tsx, which runs the
# server); install once, hoisted at /app. --omit=dev drops typescript/vitest/@types.
COPY brain/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    CEPH_DB=/data/brain.db \
    CEPH_PORT=7700 \
    CEPH_HTTP_PORT=7701
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node core ./core
COPY --chown=node:node brain ./brain
RUN mkdir -p /data && chown node:node /data
# drop root: run as the unprivileged `node` user (uid 1000) shipped in the base image
USER node
VOLUME ["/data"]
EXPOSE 7700 7701
# liveness for `docker run`/k8s (compose declares its own too)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:7701/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# WS relay :7700, HTTP API :7701; data persists in the /data volume. tsx runs the
# TypeScript entry directly (no build step); core/ resolves via the relative shims.
CMD ["/app/node_modules/.bin/tsx", "brain/src/server.ts"]
