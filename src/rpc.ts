// Thin client for the CSD node RPC; the only thing the indexer trusts (and even
// then, every derived claim it serves is independently recomputable from these
// raw blocks, so the node is a data source, not an authority).
//
// Verified shapes (live node, 2026-06-07):
//   GET /tip               -> { tip, height, chainwork }
//   GET /block/height/:h   -> { ok, hash, height, chainwork, header:{bits,merkle,nonce,prev,time,version}, txs:[...] }
//   GET /tx/:txid          -> { ... } (or { tx: {...} })
//   tx  = { txid, version, locktime, app?, inputs:[{prev_txid,vout,script_sig}], outputs:[{script_pubkey,value}] }
import { CFG } from "./config.js";
import { LWMA_WINDOW, type BlockHeader } from "@inversealtruism/csd-codec";
import { type ContenderPlausibleOpts, contenderPlausible as routeContenderPlausible, expectedBitsFromWindow, tipHeaderPowOk } from "@inversealtruism/csd-light";
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
// many consecutive cycles (CFG.workEscapeCycles), force a switch to the highest-work backend.
// ROUTE-1 (IDX-BACKEND-POW-1): a NON-primary backend may only WIN on work/height if its tip header is
// PoW-valid AND hash-bound (csd-light `tipHeaderPowOk`). The one header fetch we do when a
// non-primary CLAIMS to out-work the trusted primary is bounded by CFG.powVerifyTimeoutMs, short so a
// hung/forged backend fails soft fast instead of stalling the probe.
let behindStreak = 0;
export function activeBackend(): string { return ACTIVE; }

// The ROUTE-1 PoW + hash-binding rule is csd-light's. Exported here so the rule this module applies is the one
// test/rpc-pow-route.test.ts pins.
export { tipHeaderPowOk };

// F6 (ROUTE-1 route-capture) plausibility gate. `tipHeaderPowOk` only checks a header against its OWN
// declared bits (powOk is floored at POW_LIMIT), so a REAL min-difficulty header hashes valid and hash-binds
// while the backend claims arbitrary chainwork/height in /tip; that would let a co-located miner/standby (or
// a compromised CSD_RPC_BACKENDS entry) capture the whole projection feed. csd-light's `contenderPlausible`
// decides (delta cap grown by the local tip's wall-clock age, then the LWMA ease test); this adapter supplies
// the indexer's own anchor: its local finality-gated tip from the blocks table, never the live primary, so a
// genuinely-ahead honest secondary still wins when the primary is stale. A store READ throw fails closed
// (false); no local tip yet (cold start / mid-backfill) passes, so failover works before the index exists.
// The kill switch CSD_RPC_ROUTE_PLAUSIBILITY=0 (CFG.routePlausibility) returns before the store read.
// Runs only for a backend that CLAIMS to beat the trust anchor, so it adds no read to a normal cycle.
type LocalTip = { height: number | bigint | null; bits: number | bigint | null; time: number | bigint | null };
async function contenderPlausible(claimedHeight: number, header: unknown): Promise<boolean> {
  if (!CFG.routePlausibility) return true;
  let localTip: LocalTip | undefined;
  try {
    localTip = await store().get<LocalTip>("SELECT height, bits, time FROM blocks ORDER BY height DESC LIMIT 1");
  } catch { return false; }
  if (!localTip || localTip.height == null) return true;
  const localHeight = Number(localTip.height);
  const opts: ContenderPlausibleOpts = {
    enabled: true,
    claimedHeight,
    contenderBits: Number((header as Partial<BlockHeader> | null | undefined)?.bits),
    localHeight,
    anchorFloor: CFG.scanFrom,
    // Number(null) is 0: a tip row without a time counts its staleness from the epoch.
    localTime: Number(localTip.time),
    nowSecs: Math.floor(Date.now() / 1000),
    blockSecs: CFG.routeBlockSecs,
    expectedLocalBits: null,
    maxAhead: CFG.maxAheadBlocks,
    maxEase: CFG.maxEaseFactor,
  };
  // A null expectedLocalBits skips only the LWMA test, so a contender refused here is refused either way, and
  // the local window is read only once the delta cap and the contender's bits pass (or, as an empty range,
  // when the local tip is below the anchor floor).
  if (!routeContenderPlausible(opts)) return false;
  if (!Number.isFinite(localHeight)) return true; // no usable anchor: passed above, and there is no window to read
  return routeContenderPlausible({ ...opts, expectedLocalBits: await expectedLocalBits(localHeight) });
}

// I9 (Q-03): one-shot visibility flag for the catch below. A guard that fail-softs to INERT in silence is
// the same class as I1 and GAP-08: the operator has no way to learn that an arm of ROUTE-1 stopped
// checking. One line per process is the whole fix; the poll loop runs every ~15s, so anything per-call
// would be a journal flood, and the flag must never gate behavior.
let warnedLocalTargetThrow = false;

// Honest expected bits AT the local tip, from the local LWMA window (finality-gated blocks table only).
// Returns null when it cannot be derived (fewer than 2 local headers, or a compute anomaly); csd-light then
// skips the LWMA test and the delta cap still applies. Never touches the network or the live primary.
async function expectedLocalBits(localHeight: number): Promise<number | null> {
  try {
    const floor = Math.max(CFG.scanFrom, localHeight - LWMA_WINDOW);
    const rows = await store().all<{ time: number | bigint; bits: number | bigint }>(
      "SELECT time, bits FROM blocks WHERE height < ? AND height >= ? ORDER BY height ASC",
      localHeight, floor);
    if (rows.length < 2) return null;
    // window[last] must be the parent (localHeight-1); expectedBitsFromWindow computes the expected bits for
    // the block AT localHeight given its preceding chronological window.
    const window: BlockHeader[] = rows.map((r) => ({ version: 0, prev: "", merkle: "", time: Number(r.time), bits: Number(r.bits), nonce: 0 }));
    return expectedBitsFromWindow(window, localHeight);
  } catch (e) {
    // I9 (Q-03): the fail-soft STAYS (a null makes the LWMA test inactive while the ROUTE-1 PoW arm and the
    // delta cap remain armed, so this never opens a route). The line only makes the disarming visible.
    if (!warnedLocalTargetThrow) {
      warnedLocalTargetThrow = true;
      console.warn(`[rpc] F6 plausibility: local LWMA anchor threw (${e instanceof Error ? e.message : String(e)}) at localHeight=${localHeight}; the LWMA arm of ROUTE-1 is INERT until this is fixed (the PoW + delta-cap arms stay armed). Logged once per process.`);
    }
    return null;
  }
}

// Fetch a backend's tip header (at its claimed tip height), then apply BOTH ROUTE-1 rules with a SINGLE
// header fetch: (a) the self-referential PoW + hash-binding verdict (tipHeaderPowOk) and (b) the F6
// local-anchored plausibility gate (contenderPlausible). FAIL SOFT: any fetch/shape error → false (the
// backend simply cannot win; no throw, no read added to the healthy path; this runs only for a backend
// that CLAIMS to out-work the trust anchor).
async function contenderEligible(base: string, claimedHeight: number, claimedTipHash: string | null): Promise<boolean> {
  if (!claimedTipHash) return false;
  try {
    const res = await fetch(base + `/block/height/${claimedHeight}`, { signal: AbortSignal.timeout(CFG.powVerifyTimeoutMs) });
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
 * LWMA ease factor), never the live primary; so a min-diff forgery is excluded while a genuinely-ahead
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
  const workEscape = behindStreak >= CFG.workEscapeCycles;                // ACTIVE out-worked too long -> force a switch
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
    // Bind the response to the REQUESTED height: the node answers 200 with a mismatched/null
    // height for a height beyond tip, and a mismatched payload must never be written as a
    // canonical row (it would resurrect spent outputs as live UTXOs). Reject-more; the honest path
    // (every sampled height echoes the request) is unchanged. `typeof` first: Number(null)===0
    // would otherwise let a null height pass for h=0.
    if (typeof b.height !== "number" || !Number.isSafeInteger(b.height) || b.height !== h) return null;
    return b as RpcBlock;
  } catch { return null; }
}

