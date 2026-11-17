# csd-indexer: run your own CSD indexer + explorer.
# Multi-arch friendly; node:sqlite means no native build step.
FROM node:26-slim
WORKDIR /app

# install deps first (better layer caching); only the committed lockfile, so a failed install fails the build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# app
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# CAIRN-IDX-DOCKER-RPC-1: 8789 = the node's RPC (the source of truth). 8790 is the miner's RPC:
# never default to it (matches src/config.ts).
ENV CSD_RPC=http://host.docker.internal:8789 \
    CSD_INDEX_DB=/data/csd-index.db \
    CSD_INDEX_LISTEN=0.0.0.0:8793
VOLUME /data
EXPOSE 8793

# continuous indexer + API (REST + SSE + WS) + explorer at /
CMD ["npx","tsx","src/cli.ts","run"]
