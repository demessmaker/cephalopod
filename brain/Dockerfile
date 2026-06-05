# Cephalopod brain — self-host image (build context: ./brain).
# Multi-stage: compile native deps (better-sqlite3) in a builder, ship a lean runtime.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
# build tools are only needed if a prebuilt better-sqlite3 binary isn't available
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    CEPH_DB=/data/brain.db \
    CEPH_PORT=7700 \
    CEPH_HTTP_PORT=7701
COPY --from=builder /app/node_modules ./node_modules
COPY . ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 7700 7701
# WS relay :7700, HTTP API :7701; data persists in the /data volume
CMD ["npm", "start"]
