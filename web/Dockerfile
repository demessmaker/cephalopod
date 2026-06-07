# Cephalopod explorer — static web app + /v1 reverse-proxy to the brain.
# Build from this directory (context: ./web), e.g.:
#   docker build -t cephalopod-web ./web
# (docker-compose sets context: ./web.)
#
# The server is pure Node stdlib (serve.mjs) — no dependencies to install. Yjs and
# y-protocols load in the BROWSER from a CDN import map, so node_modules isn't needed
# at runtime.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    BRAIN_URL=http://brain:7701
COPY --chown=node:node src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# proxies /v1 -> $BRAIN_URL; serves the explorer on :8080
CMD ["node", "src/serve.mjs"]
