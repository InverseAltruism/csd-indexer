// Environment configuration for the standalone indexer. Everything is overridable
// so a third party can point it at their own node + paths and run an identical
// indexer (determinism is the audit — see the roadmap's honest limits).
import { readFileSync } from "node:fs";

export const CFG = {
  // Node RPC (the source of truth). 8789 = the node itself. (8790 was the MINER's RPC —
  // the miner is disabled since 2026-06-12; never default to it.)
  rpc: env("CSD_RPC", "http://127.0.0.1:8789"),
  // RPC failover backends: read the healthiest (reachable, highest cumulative chainwork) of these each
  // sync cycle, so a node that falls behind (db-loss resync / lag) does not stall the projection — it
  // reads the on-host miner (:8790) or standby (:8795) instead. Primary is rpcBackends[0]. Override with
  // a comma list in CSD_RPC_BACKENDS. max-chainwork selection with stickiness (no auto-failback) is in
  // rpc.ts, and it composes with the reorg chainwork guard: this picks the most-caught-up source, the
  // guard HOLDS only when EVERY source is behind our indexed tip.
  rpcBackends: backendList(),
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
  // NOTE (audit dead-key): currently UNCONSULTED — the API derives finality from `finalDepth`
  // and per-event tentative/confirmed status. Kept (not removed) to preserve the env surface for
  // a future display tier; reading the env var here is harmless. Do not assume it gates anything.
  displayDepth: num("CSD_CONFIRMATIONS_DISPLAY", 3),
  // Blocks per persisted scan chunk.
  // NOTE (audit dead-key): currently UNCONSULTED — the indexer loop walks block-by-block, so this
  // knob does not change behavior. Kept to preserve the env surface; do not assume it tunes batching.
  batch: num("CSD_INDEX_BATCH", 200),
  // Poll interval (seconds) for the continuous indexer loop.
  pollSecs: num("CSD_INDEX_POLL", 15),
  // Wall-clock seconds since the tip block's timestamp before /health reports stale=true.
  // A healthy chain rarely goes this long without a block (target spacing is 120s); a stale
  // flag tells a load balancer / failover client NOT to route value actions here. The raw
  // seconds_since_tip is always exposed so a consumer can apply its own threshold.
  staleSecs: num("CSD_STALE_SECS", 600),
  // Never hard-unwind the index below this height. It is the highest SHIPPED SPV checkpoint across the
  // wallet (namespv 29960, swapguard 38142) + bridge (31076); 38142 is the max. No honest reorg crosses
  // a buried checkpoint, so a "reorg" that would unwind below it is a node tip-regression (db-loss /
  // resync), not consensus moving. The primary defense is the chainwork regression guard in the sync
  // loop; this floor is the backstop. Override if a deeper checkpoint ever ships.
  checkpointFloor: num("CSD_INDEX_CHECKPOINT_FLOOR", checkpointDefault()),
  // Kill switch for the chainwork regression guard. Default on. If the guard ever wrongly HOLDs (e.g. a
  // backend served an inflated chainwork that poisoned our stored tip work), set CSD_INDEX_WORK_GUARD=0
  // to let the indexer advance again without a code change, then fix the source.
  workGuard: (process.env.CSD_INDEX_WORK_GUARD ?? "1") !== "0",
};

export function host(): string { return CFG.listen.split(":")[0] || "127.0.0.1"; }
export function port(): number { return Number(CFG.listen.split(":")[1] || 8793); }

// Single source for the SPV checkpoint floor, shared with the watchdog (cairn/deploy/spv-checkpoint) so a
// new checkpoint updates ONE file. The CSD_INDEX_CHECKPOINT_FLOOR env still overrides; the file is the
// default; 38142 is the hard fallback if the file is absent (e.g. a third-party deploy).
function checkpointDefault(): number {
  try { const v = Number(readFileSync("/opt/cairn_substrate/cairn/deploy/spv-checkpoint", "utf8").trim()); return Number.isFinite(v) && v > 0 ? v : 38142; } catch { return 38142; }
}
function env(k: string, d: string): string { return process.env[k] ?? d; }
function num(k: string, d: number): number { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; }
// Failover backend list: explicit CSD_RPC_BACKENDS (comma list) wins; else the primary CSD_RPC plus the
// on-host miner + standby RPCs (deduped). Primary stays first so it is preferred on a chainwork tie.
function backendList(): string[] {
  const raw = process.env.CSD_RPC_BACKENDS;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  const prim = env("CSD_RPC", "http://127.0.0.1:8789");
  // Only auto-append OUR on-host miner + standby when running against OUR default node. A custom CSD_RPC
  // (a third party, or a test mock) gets NO implicit extra backends — otherwise it would silently poll
  // 127.0.0.1:8790/8795, which is both wrong for third parties and lethal in tests (they would read the
  // live chain instead of their mock). Set CSD_RPC_BACKENDS explicitly to opt a custom setup into failover.
  if (prim !== "http://127.0.0.1:8789") return [prim];
  return [prim, "http://127.0.0.1:8790", "http://127.0.0.1:8795"];
}
