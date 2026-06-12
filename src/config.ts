// Environment configuration for the standalone indexer. Everything is overridable
// so a third party can point it at their own node + paths and run an identical
// indexer (determinism is the audit — see the roadmap's honest limits).
export const CFG = {
  // Node RPC (the source of truth). 8789 = the node itself. (8790 was the MINER's RPC —
  // the miner is disabled since 2026-06-12; never default to it.)
  rpc: env("CSD_RPC", "http://127.0.0.1:8789"),
  // sqlite file. node:sqlite (built into Node 22) — no native dep, no build step.
  db: env("CSD_INDEX_DB", "./csd-index.db"),
  // Postgres connection string. When set, the indexer uses Postgres INSTEAD of sqlite —
  // the scale path: node:sqlite is synchronous (every query blocks the event loop), so
  // concurrent API readers serialize; a pg pool keeps reads flowing during block writes.
  // e.g. CSD_INDEX_PG=postgres://csd:***@127.0.0.1:5432/csd_index
  pg: env("CSD_INDEX_PG", ""),
  // Postgres schema (namespace) for all tables — lets several indexers share one database.
  pgSchema: env("CSD_INDEX_PG_SCHEMA", "public"),
  // Postgres pool size (readers + the single writer).
  pgPoolSize: num("CSD_INDEX_PG_POOL", 10),
  // HTTP bind for the REST + streaming API (8789 node, 8790 miner, 8791 swarm, 7777 cairn).
  listen: env("CSD_INDEX_LISTEN", "127.0.0.1:8793"),
  // L1 swarm gateway used to resolve content bytes by payload_hash (optional join).
  swarmGateway: env("CSD_SWARM_GATEWAY", "http://127.0.0.1:8791"),
  // First height to index. Genesis is 0; raise it to skip pre-CSD history if desired.
  scanFrom: num("CSD_INDEX_FROM", 0),
  // Blocks deeper than this are treated as final and never unwound (reorg bound).
  finalDepth: num("CSD_CONFIRMATIONS_FINAL", 6),
  // Blocks at/under this depth are "confirmed" for display; the tip stays tentative.
  displayDepth: num("CSD_CONFIRMATIONS_DISPLAY", 3),
  // Blocks per persisted scan chunk.
  batch: num("CSD_INDEX_BATCH", 200),
  // Poll interval (seconds) for the continuous indexer loop.
  pollSecs: num("CSD_INDEX_POLL", 15),
};

export function host(): string { return CFG.listen.split(":")[0] || "127.0.0.1"; }
export function port(): number { return Number(CFG.listen.split(":")[1] || 8793); }

function env(k: string, d: string): string { return process.env[k] ?? d; }
function num(k: string, d: number): number { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; }
