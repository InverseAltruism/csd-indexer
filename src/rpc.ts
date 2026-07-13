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
import { headerHashBytes, powOk, type BlockHeader } from "@inversealtruism/csd-codec";

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

// Fetch a backend's tip header (at its claimed tip height) and return the ROUTE-1 PoW verdict, bound to
// the tip hash the backend claimed in /tip. FAIL SOFT: any fetch/shape error → false (the backend simply
// cannot win; no throw, no read added to the healthy path; this runs only for a backend that CLAIMS to
// out-work the trust anchor).
async function tipHeaderPowOkFor(base: string, claimedHeight: number, claimedTipHash: string | null): Promise<boolean> {
  if (!claimedTipHash) return false;
  try {
    const res = await fetch(base + `/block/height/${claimedHeight}`, { signal: AbortSignal.timeout(POW_VERIFY_TIMEOUT_MS) });
    if (!res.ok) return false;
    const j: any = await res.json();
    const b = j.block ?? j;
    if (!b || !b.header) return false;
    return tipHeaderPowOk(b.header, claimedTipHash);
  } catch { return false; }
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(ACTIVE + path);
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
    const verdicts = await Promise.all(contenders.map(async (r) => ({ b: r.b, ok: await tipHeaderPowOkFor(r.b, r.t.height, r.t.tipHash) })));
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

