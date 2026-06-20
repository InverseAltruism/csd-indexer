# csd-indexer — run your own CSD indexer + explorer.
# Multi-arch friendly; node:sqlite means no native build step.
FROM node:22-slim
WORKDIR /app

# install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# app
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# CAIRN-IDX-DOCKER-RPC-1: 8789 = the node's RPC (the source of truth). 8790 was the MINER's RPC,
# disabled since 2026-06-12 — never default to it (matches src/config.ts).
ENV CSD_RPC=http://host.docker.internal:8789 \
    CSD_INDEX_DB=/data/csd-index.db \
    CSD_INDEX_LISTEN=0.0.0.0:8793 \
    CSD_SWARM_GATEWAY=http://host.docker.internal:8791
VOLUME /data
EXPOSE 8793

# continuous indexer + API (REST + SSE + WS) + explorer at /
CMD ["npx","tsx","src/cli.ts","run"]
