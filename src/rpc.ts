// Thin client for the CSD node RPC — the only thing the indexer trusts (and even
// then, every derived claim it serves is independently recomputable from these
// raw blocks, so the node is a data source, not an authority).
//
// Verified shapes (live node, 2026-06-07):
//   GET /tip               -> { tip, height, chainwork }
//   GET /block/height/:h   -> { ok, hash, height, chainwork, header:{bits,merkle,nonce,prev,time,version}, txs:[...] }
//   GET /tx/:txid          -> { ... } (or { tx: {...} })
//   tx  = { txid, version, locktime, app?, inputs:[{prev_txid,vout,script_sig}], outputs:[{script_pubkey,value}] }
import { CFG } from "./config.js";
import { headerHashBytes, powOk, bitsToTarget, targetToBigInt, POW_LIMIT_BITS, LWMA_WINDOW, type BlockHeader } from "@inversealtruism/csd-codec";
import { expectedBitsFromWindow } from "@inversealtruism/csd-light";
import { store } from "./db.js";

export interface RpcHeader { bits: number; merkle: string; nonce: number; prev: string; time: number; version: number; }
export interface RpcTxIn { prev_txid?: string; prevTxid?: string; vout?: number; script_sig?: string; }
export interface RpcTxOut { script_pubkey?: string; value?: number; }
export interface RpcTx { txid: string; version?: number; locktime?: number; app?: any; inputs?: RpcTxIn[]; outputs?: RpcTxOut[]; }
export interface RpcBlock { hash: string; height: number; chainwork?: string; header: RpcHeader; txs: RpcTx[]; }

// The backend we are currently reading from. selectBackend() (called once per sync cycle) moves it to
// the healthiest source; every getJson in a cycle then uses that one consistent backend.
let ACTIVE = (CFG.rpcBackends && CFG.rpcBackends[0]) || CFG.rpc;
const HYSTERESIS_BLOCKS = 3; // keep ACTIVE unless it falls more than this many blocks behind the best HEIGHT
// Work-escape: height hysteresis ALONE would pin ACTIVE to a same-height but LOWER-CHAINWORK backend (a
// minority fork that keeps pace in height) indefinitely. If ACTIVE stays below the best chainwork for this
// many consecutive cycles, force a switch to the highest-work backend. Configurable for tests.
const WORK_ESCAPE_CYCLES = Number(process.env.CSD_RPC_WORK_ESCAPE || 20);
// ROUTE-1 (IDX-BACKEND-POW-1): a NON-primary backend may only WIN on work/height if its tip header is
// PoW-valid AND hash-bound (mirrors cairn's rpcroute.ts ROUTE-1). Timeout on the one header fetch we do
// when a non-primary CLAIMS to out-work the trusted primary; short so a hung/forged backend fails soft
// fast instead of stalling the probe. Configurable for tests (matches the WORK_ESCAPE idiom).
const POW_VERIFY_TIMEOUT_MS = Number(process.env.CSD_RPC_POW_TIMEOUT || 5000);
// Chain target block spacing (s); used ONLY by the wall-clock-aware route delta cap (M1), never consensus.
const ROUTE_BLOCK_SECS = Math.max(1, Number(process.env.CSD_RPC_BLOCK_SECS || 120));
let behindStreak = 0;
export function activeBackend(): string { return ACTIVE; }

// PoW verdict on a backend's tip header, ported byte-for-byte from cairn's rpcroute.ts `tipHeaderPowOk`
// (the ecosystem's single ROUTE-1 rule; reuses the SDK codec, no hand-rolled PoW math). Returns false on
// ANY shape/verification error (FAIL SAFE): a header that does not decode, does not hash to the claimed
// tip hash, or whose hash exceeds the target for its own `bits` is NOT a valid winner. Hash-binding
// (computed header hash === claimed tipHash) stops a backend pairing a real, easy-PoW header with a LIE
// about which block is its tip.
export function tipHeaderPowOk(header: unknown, claimedTipHash: string | null): boolean {
  try {
    const h = header as Partial<BlockHeader> | null | undefined;
    if (!h || typeof h !== "object") return false;
    if (typeof h.bits !== "number" || !Number.isFinite(h.bits)) return false;
    if (typeof h.prev !== "string" || typeof h.merkle !== "string") return false;
    const bh: BlockHeader = { version: Number(h.version ?? 0), prev: h.prev, merkle: h.merkle, time: (h.time as number) ?? 0, bits: h.bits, nonce: Number(h.nonce ?? 0) };
    const hashBytes = headerHashBytes(bh);
    // A non-hex/missing claimedTipHash is a HARD FAIL, not a skipped binding: a backend with no
    // well-formed tip hash has no business winning a work-based route.
    if (typeof claimedTipHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(claimedTipHash)) return false;
    const computed = "0x" + Buffer.from(hashBytes).toString("hex");
    if (computed.toLowerCase() !== claimedTipHash.toLowerCase()) return false;
    return powOk(hashBytes, bh.bits);
  } catch {
    return false;
  }
}

// F6 (ROUTE-1 route-capture) plausibility gate. `tipHeaderPowOk` above only checks a header against its
// OWN declared bits (powOk is floored at POW_LIMIT), so a REAL min-difficulty header (bits at/near
// POW_LIMIT, trivial to grind) hashes valid and hash-binds — passing ROUTE-1 while the backend claims
// arbitrary chainwork/height in /tip. That lets a co-located miner/standby (or a compromised
// CSD_RPC_BACKENDS entry) capture the whole projection feed. This gate rejects such a contender by
// anchoring on the indexer's OWN local finality-gated headers (the blocks table) — NEVER the live primary,
// so a genuinely-ahead honest secondary still wins when the primary is stale/wedged (that is the whole
// point of ROUTE-1; anchoring on the primary would pin routing on a dead primary = the availability
// regression the design forbids). Two anchored bounds:
//   (1) DELTA CAP: reject a claimed height more than CFG.maxAheadBlocks beyond the local tip.
//   (2) LWMA PLAUSIBILITY: reject a declared tip target EASIER than expected_local_target * maxEaseFactor,
//       where expected_local_target = csd-light expectedBitsFromWindow over the local LWMA window.
// FAIL-SAFE and availability-aware: a store READ/parse THROW or an unparseable contender bits -> false
// (the contender cannot win); a legitimately EMPTY/too-shallow local index (cold start / mid-backfill, no
// anchor to check against) -> the gate is INACTIVE (true) so it never breaks the legitimate failover path
// before the index is established. Runs ONLY for a backend that CLAIMS to beat the anchor (never on the
// healthy path), so it adds no read to a normal cycle. Kill switch CSD_RPC_ROUTE_PLAUSIBILITY=0 (read
// per-call) mirrors CSD_INDEX_WORK_GUARD: an operator escape if an extreme honest retarget ever mis-fires.
async function contenderPlausible(claimedHeight: number, header: unknown): Promise<boolean> {
  if (process.env.CSD_RPC_ROUTE_PLAUSIBILITY === "0") return true; // operator escape valve (default on)
  // Read our local finality-gated tip. A store THROW is a genuine read error -> fail closed (false).
  let localTip: { height: number | bigint | null; bits: number | bigint | null; time: number | bigint | null } | undefined;
  try {
    localTip = await store().get<{ height: number | bigint | null; bits: number | bigint | null; time: number | bigint | null }>(
      "SELECT height, bits, time FROM blocks WHERE orphaned=0 ORDER BY height DESC LIMIT 1");
  } catch { return false; }
  // No local anchor yet (fresh index / mid-backfill): nothing to plausibility-check against, so the gate is
  // inactive rather than block a legitimate failover before the index exists.
  if (!localTip || localTip.height == null) return true;
  const lh = Number(localTip.height);
  if (!Number.isFinite(lh) || lh < CFG.scanFrom) return true;
  // DELTA CAP (wall-clock-aware; M1 fix, Plan 70 R2 final red-team). The local anchor is fed by the
  // primary-following scanner, so during a reachable-but-FROZEN primary wedge it stops advancing while the
  // honest chain (and a genuinely-ahead honest secondary) keep going. A FIXED maxAhead cap would then reject
  // the honest secondary after ~maxAhead blocks of wedge = the incident-#10 stale-failover regression ROUTE-1
  // exists to prevent. So GROW the cap by how STALE the local tip is in wall-clock terms: an honest secondary
  // can legitimately be ~(now - localTip.time)/blockSecs blocks past a frozen anchor. A forger still cannot
  // claim more height than wall-clock allows, and the LWMA-ease test below stays the real min-diff forgery
  // defense (a RELATIVE difficulty check, robust to a stale anchor). Runtime route decision, so Date.now() is fine.
  const claimed = Number(claimedHeight);
  if (!Number.isFinite(claimed)) return false;                 // shape error -> fail closed
  const nowSecs = Math.floor(Date.now() / 1000);
  const ltTime = Number(localTip.time);
  const staleBlocks = Number.isFinite(ltTime) ? Math.max(0, Math.floor((nowSecs - ltTime) / ROUTE_BLOCK_SECS)) : 0;
  if (claimed > lh + CFG.maxAheadBlocks + staleBlocks) return false;  // implausibly far beyond the staleness-adjusted tip
  // LWMA PLAUSIBILITY. Parse the contender's declared tip target from its bits.
  const h = header as Partial<BlockHeader> | null | undefined;
  const cbits = Number(h?.bits);
  if (!Number.isFinite(cbits)) return false;                   // shape error -> fail closed
  let contenderTarget: bigint;
  try { contenderTarget = targetToBigInt(bitsToTarget(cbits)); } catch { return false; }
  if (contenderTarget <= 0n) return false;                     // invalid compact bits -> fail closed
  const expected = await expectedLocalTarget(lh);
  // Could not derive a local LWMA anchor (window too short / our own data anomalous): the DELTA CAP already
  // applied above; skip the LWMA test rather than punish the contender for a LOCAL gap (availability-safe,
  // and the local window is our own data, not attacker-influenced).
  if (expected == null) return true;
  let threshold = expected * BigInt(Math.max(1, Math.floor(CFG.maxEaseFactor)));
  const powLimitTarget = targetToBigInt(bitsToTarget(POW_LIMIT_BITS));
  if (threshold > powLimitTarget) threshold = powLimitTarget;  // graceful min-difficulty degrade
  // Reject only when the contender's tip is EASIER (larger target) than honest expected * ease. A contender
  // at the correct (or harder) local-LWMA difficulty passes; a POW_LIMIT forgery is orders of magnitude
  // easier and is rejected (unless the local chain itself is at min difficulty, handled by the cap above).
  return contenderTarget <= threshold;
}

// Honest expected target AT the local tip, from the local LWMA window (finality-gated blocks table only).
// Returns null when it cannot be derived (fewer than 2 local headers, or a compute anomaly) so the caller
// treats the LWMA test as inactive rather than throwing. Never touches the network or the live primary.
async function expectedLocalTarget(localHeight: number): Promise<bigint | null> {
  try {
    const floor = Math.max(CFG.scanFrom, localHeight - LWMA_WINDOW);
    const rows = await store().all<{ time: number | bigint; bits: number | bigint }>(
      "SELECT time, bits FROM blocks WHERE orphaned=0 AND height < ? AND height >= ? ORDER BY height ASC",
      localHeight, floor);
    if (rows.length < 2) return null;
    // window[last] must be the parent (localHeight-1); expectedBitsFromWindow computes the expected bits for
    // the block AT localHeight given its preceding chronological window.
    const window: BlockHeader[] = rows.map((r) => ({ version: 0, prev: "", merkle: "", time: Number(r.time), bits: Number(r.bits), nonce: 0 }));
    const eb = expectedBitsFromWindow(window, localHeight);
    const t = targetToBigInt(bitsToTarget(eb));
    return t > 0n ? t : null;
  } catch { return null; }
}

// Fetch a backend's tip header (at its claimed tip height), then apply BOTH ROUTE-1 rules with a SINGLE
// header fetch: (a) the self-referential PoW + hash-binding verdict (tipHeaderPowOk) and (b) the F6
// local-anchored plausibility gate (contenderPlausible). FAIL SOFT: any fetch/shape error → false (the
// backend simply cannot win; no throw, no read added to the healthy path; this runs only for a backend
// that CLAIMS to out-work the trust anchor).
async function contenderEligible(base: string, claimedHeight: number, claimedTipHash: string | null): Promise<boolean> {
  if (!claimedTipHash) return false;
  try {
    const res = await fetch(base + `/block/height/${claimedHeight}`, { signal: AbortSignal.timeout(POW_VERIFY_TIMEOUT_MS) });
    if (!res.ok) return false;
    const j: any = await res.json();
    const b = j.block ?? j;
    if (!b || !b.header) return false;
    if (!tipHeaderPowOk(b.header, claimedTipHash)) return false;      // ROUTE-1: self-referential PoW + hash-bind
    return await contenderPlausible(claimedHeight, b.header);          // F6: local-anchored plausibility
  } catch { return false; }
}

// L9: bound every serial-poll read with a generous AbortSignal timeout. The sync loop reads /tip then
// /block/height/:h serially; a backend that answers /tip fast but STALLS /block would otherwise wedge the
// whole loop indefinitely (no forward progress, no failover). The signal aborts a hung response AND a
// stalled body read, so getJson throws (caught by the callers: blockByHeight -> null, reachable -> false,
// tip -> propagates to the poll loop's retry) instead of hanging. Generous by default (CFG.rpcTimeoutMs,
// >= 10s) so it never fires on a slow-but-honest response = zero healthy-path regression.
async function getJson(path: string): Promise<any> {
  const res = await fetch(ACTIVE + path, { signal: AbortSignal.timeout(CFG.rpcTimeoutMs) });
  if (!res.ok) throw new Error(`rpc ${path} -> ${res.status}`);
  return res.json();
}

async function tipOf(base: string): Promise<{ height: number; chainwork: bigint; tipHash: string | null } | null> {
  try {
    const res = await fetch(base + "/tip", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const tipHash = typeof j.tip === "string" && j.tip ? String(j.tip) : null;
    return { height: Number(j.height ?? 0), chainwork: BigInt(String(j.chainwork ?? "0")), tipHash };
  } catch { return null; }
}

/**
 * Choose which backend to read THIS cycle: the reachable one with the most cumulative chainwork, with
 * HYSTERESIS so it does not flap and does NOT auto-fail-back. Keep ACTIVE while it is reachable and within
 * HYSTERESIS_BLOCKS of the best height (so same-chain backends racing block propagation do not flap, and
 * once we move off the primary we stay until a human restarts). Only when ACTIVE falls meaningfully behind
 * (or is gone) do we switch to the highest-chainwork backend, preferring the primary among ties. A node
 * that falls behind (resync / lag) has less work, so selection moves to the miner/standby and the
 * projection keeps advancing on fresh data. If NOTHING is reachable, keep ACTIVE (reads then fail and the
 * caller retries next poll).
 *
 * ROUTE-1 (IDX-BACKEND-POW-1): a backend may only WIN the selection on work/height if its tip header is
 * PoW-valid AND hash-bound; otherwise a forged-chainwork backend (the on-host miner :8790 / standby :8795,
 * or a compromised CSD_RPC_BACKENDS entry) would capture the feed and poison the regression guard. The gate
 * anchors on a TRUSTED view: the primary (backends[0]) when it is reachable (the authority, never gated),
 * else, during a primary outage, the LOWEST-chainwork reachable backend (the most conservative floor). Any
 * OTHER backend that CLAIMS to out-work/out-height that anchor must prove PoW on its tip header, or it is
 * demoted: it drops out of the work/height math and cannot be chosen (fail soft; never hard-fails a read).
 * We only verify a backend that actually claims to beat the anchor, so the healthy path (alt backends at or
 * behind the primary) pays no header fetch and adds no read latency. NOTE the anchor differs from cairn's
 * 2-backend rule, which left primary-down as ungated liveness failover: with 3+ backends a forged loopback
 * must not out-claim the honest standby with zero PoW while the primary is down, so that path is gated too.
 *
 * F6 (route-capture): the ROUTE-1 PoW check alone is insufficient because a REAL min-difficulty header
 * (bits at/near POW_LIMIT, trivial to grind) passes powOk against its OWN bits, so a contender can pair a
 * cheap valid header with a huge forged /tip chainwork/height and win. `contenderEligible` therefore also
 * runs `contenderPlausible`, which anchors on the indexer's OWN local finality-gated headers (delta cap +
 * LWMA ease factor), never the live primary — so a min-diff forgery is excluded while a genuinely-ahead
 * honest secondary at the correct local difficulty is still selected when the primary is stale.
 */
type Probe = { height: number; chainwork: bigint; tipHash: string | null };
export async function selectBackend(): Promise<{ active: string; switched: boolean; height: number }> {
  const backends = CFG.rpcBackends && CFG.rpcBackends.length ? CFG.rpcBackends : [CFG.rpc];
  const probed = await Promise.all(backends.map(async (b) => ({ b, t: await tipOf(b) })));
  const reachable = probed.filter((x): x is { b: string; t: Probe } => x.t != null);
  const prev = ACTIVE;
  if (reachable.length === 0) return { active: ACTIVE, switched: false, height: 0 };
  const primary = backends[0];
  // ROUTE-1 eligibility. Trust anchor: the primary if reachable (trusted authority, never gated), else the
  // LOWEST-chainwork reachable backend (conservative floor for the primary-down case). Any backend that
  // CLAIMS to out-work/out-height the anchor must prove PoW on its tip header, or it is excluded from the
  // selection math (cannot win). The anchor is never a contender, so `eligible` stays non-empty; this only
  // rejects MORE, and only when a backend actually claims to beat the anchor (zero cost on the healthy path).
  let eligible = reachable;
  const primaryEntry = reachable.find((r) => r.b === primary);
  const authority = primaryEntry ?? reachable.reduce((a, b) => (b.t.chainwork < a.t.chainwork ? b : a));
  const contenders = reachable.filter((r) => r !== authority && r.b !== primary && (r.t.height > authority.t.height || r.t.chainwork > authority.t.chainwork));
  if (contenders.length) {
    const verdicts = await Promise.all(contenders.map(async (r) => ({ b: r.b, ok: await contenderEligible(r.b, r.t.height, r.t.tipHash) })));
    const rejected = new Set(verdicts.filter((v) => !v.ok).map((v) => v.b));
    if (rejected.size) eligible = reachable.filter((r) => !rejected.has(r.b));
  }
  let maxWork = eligible[0]!.t.chainwork;
  for (const r of eligible) if (r.t.chainwork > maxWork) maxWork = r.t.chainwork;
  const best = eligible.filter((r) => r.t.chainwork === maxWork);
  const bestHeight = Math.max(...eligible.map((r) => r.t.height));
  const activeEntry = eligible.find((r) => r.b === ACTIVE);
  behindStreak = (activeEntry && activeEntry.t.chainwork < maxWork) ? behindStreak + 1 : 0;
  const workEscape = behindStreak >= WORK_ESCAPE_CYCLES;                // ACTIVE out-worked too long -> force a switch
  const chosen = (activeEntry && activeEntry.t.height >= bestHeight - HYSTERESIS_BLOCKS && !workEscape)
    ? ACTIVE                                                          // sticky: close in HEIGHT and not persistently out-worked
    : (best.find((r) => r.b === primary)?.b ?? best[0]!.b);          // switch to highest-work, primary-preferred
  if (chosen !== ACTIVE) behindStreak = 0;
  ACTIVE = chosen;
  return { active: chosen, switched: chosen !== prev, height: reachable.find((r) => r.b === chosen)!.t.height };
}

export async function tip(): Promise<{ height: number; tip: string; chainwork: string }> {
  const j = await getJson("/tip");
  return { height: Number(j.height ?? 0), tip: String(j.tip ?? ""), chainwork: String(j.chainwork ?? "0") };
}

export async function reachable(): Promise<boolean> {
  try { await getJson("/tip"); return true; } catch { return false; }
}

export async function blockByHeight(h: number): Promise<RpcBlock | null> {
  try {
    const j = await getJson(`/block/height/${h}`);
    const b = j.block ?? j;
    if (!b || !b.header || !Array.isArray(b.txs)) return null;
    return b as RpcBlock;
  } catch { return null; }
}

