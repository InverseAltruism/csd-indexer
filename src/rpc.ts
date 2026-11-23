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
import { LWMA_WINDOW, workForBits, type BlockHeader } from "@inversealtruism/csd-codec";
import { type ContenderPlausibleOpts, contenderPlausible as routeContenderPlausible, expectedBitsFromWindow, tipHeaderPowOk } from "@inversealtruism/csd-light";
import { store } from "./db.js";
import { storableText } from "./decode.js";

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
// the indexer's own anchor: its newest stored block (depth 0) from the blocks table, never the live primary, so a
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

// Honest expected bits AT the local tip, from the local LWMA window (the blocks table only).
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

// Fetch a backend's tip header (at its claimed tip height) and apply the ROUTE-1 rules: (a) the self-referential PoW +
// hash-binding verdict (tipHeaderPowOk), then, unless CSD_RPC_ROUTE_PLAUSIBILITY=0, (b) the F6 local-anchored
// plausibility gate (contenderPlausible) and (c) the link proof (contenderLinks). Returns the chainwork the contender
// is ranked with (its claim, or less under the proof), or null when it cannot win this pass. FAIL SOFT: any
// fetch/shape error → null (no throw, no read added to the healthy path; this runs only for a backend that CLAIMS to
// out-work the trust anchor). One deadline of CFG.powVerifyTimeoutMs covers every fetch of one pass's proof.
async function contenderEligible(base: string, claimedHeight: number, claimedTipHash: string | null, claimedWork: bigint, anchor: Probe): Promise<bigint | null> {
  if (!claimedTipHash) return null;
  try {
    const signal = AbortSignal.timeout(CFG.powVerifyTimeoutMs);
    const header = await headerAt(base, claimedHeight, signal);
    if (!header) return null;
    if (!tipHeaderPowOk(header, claimedTipHash)) return null;         // ROUTE-1: self-referential PoW + hash-bind
    if (!CFG.routePlausibility) return claimedWork;
    if (!(await contenderPlausible(claimedHeight, header))) return null; // F6: local-anchored plausibility
    return await contenderLinks(base, claimedHeight, claimedTipHash.toLowerCase(), header, claimedWork, anchor, signal);
  } catch { return null; }
}

type ProofHeader = { prev?: unknown; bits?: unknown };
// A header the backend serves at a height; null when it answers that it has none (404) or no header. Any other
// failure throws: a timeout, a closed connection or another status ends the pass, not the proof.
async function headerAt(base: string, height: number, signal: AbortSignal): Promise<ProofHeader | null> {
  const res = await fetch(base + `/block/height/${height}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/block/height/${height} -> ${res.status}`);
  const j: any = await res.json();
  const b = j.block ?? j;
  return b && b.header && typeof b.header === "object" ? b.header : null;
}

// The height and chainwork a hash holds on the trusted view: the anchor's tip with the anchor's chainwork, else the
// indexer's own blocks table; undefined when neither holds it. A chainwork that is no positive integer is null.
async function known(hash: string, anchor: Probe): Promise<{ height: number; work: bigint | null } | undefined> {
  if (anchor.tipHash != null && hash === anchor.tipHash.toLowerCase()) return { height: anchor.height, work: anchor.chainwork };
  const r = await store().get<{ height: number | bigint; chainwork: string | null }>("SELECT height, chainwork FROM blocks WHERE hash=?", hash);
  return r ? { height: Number(r.height), work: parseWork(r.chainwork) } : undefined;
}
// A chainwork figure, or null when it is none: absent, empty, not an integer, zero or negative, as the regression
// guard reads its own tip (indexer.ts indexedChainwork). No figure bounds nothing, so the claim counts as on 0.3.13.
function parseWork(v: unknown): bigint | null {
  if (v == null) return null;
  try { const w = BigInt(String(v).trim()); return w > 0n ? w : null; } catch { return null; }
}
// A header's work by its bits; bits that are no integer count none.
const headerWork = (h: ProofHeader): bigint => (Number.isSafeInteger(h.bits) ? workForBits(h.bits as number) : 0n);

// A part of a backend's chain that its link proof proved: the headers from topHeight (hash topHash) down to
// bottomHeight (whose prev is bottomPrev), each hash-bound, meeting its own bits and linked to the one above; `work`
// is their summed work, and anchorTip the anchor's tip every prev in the part was compared with (null when the part
// was joined past an anchor tip that moved inside it). A backend keeps at most two parts: what its last walk proved
// from its tip down, with every older part it reaches by hash merged in, and the highest older part under where that
// walk stopped. So the memory is bounded by the backends list whatever a backend serves; a pass costs at most its
// deadline; a proof of n headers ends after about n times the read time divided by the deadline; a failed read keeps
// what was proved; and a proved contender the selection does not choose yet is not walked again
// (test/rpc-route-honest.test.ts).
//
// A walk joins a part when it reaches the part's top height with the part's top hash: the part is then the walk's own
// chain (a hash binds its ancestors), so its headers are not read again, and nothing it skips may hide a link. A block
// the index stores inside the part means the stored block at bottomHeight - 1 is the part's bottomPrev (the stored
// chain is linked: findReorgAncestor writes a block only on its stored parent), which the walk meets next. The
// anchor's tip inside the part was compared only when it is the part's anchorTip; when it moved inside since, the walk
// joins if the stored tip is fewer heights under the part than the anchor is under its top (a stored ancestor then
// links it sooner), else walks the part again to meet the anchor; a joined walk that is refused walks again without
// the kept parts. A tip on another branch has another hash at the part's top height and does not join.
type Proved = { topHash: string; topHeight: number; bottomHeight: number; bottomPrev: string; work: bigint; anchorTip: string | null };
const proofs = new Map<string, Proved[]>();
/** TEST ONLY: forget every backend's kept proof and every left backend, so a case starts from none. */
export function resetProofsForTests(): void { proofs.clear(); left.clear(); }

// A contender's claim (its tip at claimedHeight) is backed only by headers above a block the trusted view already
// holds: from the tip down, each header PoW-valid and hashing to the prev of the one above, served at consecutive
// heights, until a prev is the anchor's tip or a stored block, at the height it holds there. At least one header is
// new, so a replayed header (the anchor's tip or a stored block claimed at another height) proves nothing; a tip the
// index stores at the claimed height, with the chainwork stored for it, claims nothing the index does not hold and
// stays eligible. The chainwork returned is the claim, at most the linked block's plus each proved header's work. A
// store read throw fails closed, as in contenderPlausible (test/rpc-route-link.test.ts, test/rpc-route-honest.test.ts).
async function contenderLinks(base: string, claimedHeight: number, tipHash: string, tipHeader: ProofHeader,
  claimedWork: bigint, anchor: Probe, signal: AbortSignal): Promise<bigint | null> {
  try {
    const held = await known(tipHash, anchor);
    if (held) return held.height === claimedHeight && held.work === claimedWork ? claimedWork : null;
    const saved = proofs.get(base) ?? [];
    proofs.delete(base);
    let r = await linkWalk(base, claimedHeight, tipHash, tipHeader, anchor, signal, saved);
    if (r.end === "refused" && r.skipped) r = await linkWalk(base, claimedHeight, tipHash, tipHeader, anchor, signal, []);
    if (r.end === "refused") return null;
    proofs.set(base, r.kept);
    if (r.end === "short") { await logShortProof(base, claimedHeight, r.kept[0]!.bottomHeight, anchor); return null; }
    if (r.work == null) return claimedWork;                             // no figure to bound the claim by
    return claimedWork < r.work ? claimedWork : r.work;
  } catch { return null; }
}

type WalkEnd = { end: "linked"; work: bigint | null; kept: Proved[] } | { end: "short"; kept: Proved[] } | { end: "refused"; skipped: boolean };
// One walk of contenderLinks from the tip down, joining the kept parts it reaches (see Proved).
async function linkWalk(base: string, claimedHeight: number, tipHash: string, tipHeader: ProofHeader, anchor: Probe,
  signal: AbortSignal, saved: Proved[]): Promise<WalkEnd> {
  const anchorTip = anchor.tipHash?.toLowerCase() ?? null;
  let pending = saved;
  // The headers from the tip down to height h are proved; `header` and `hash` are the one at h, `work` their sum.
  let header = tipHeader, h = claimedHeight, hash = tipHash, work = headerWork(tipHeader), skipped = false;
  const own = (prev: string): Proved => ({ topHash: tipHash, topHeight: claimedHeight, bottomHeight: h, bottomPrev: prev, work, anchorTip: skipped ? null : anchorTip });
  for (;;) {
    const part = pending.find((p) => p.topHeight === h);
    if (part && part.topHash === hash && (await joins(part, anchor, anchorTip))) {
      if (moved(part, anchor, anchorTip)) skipped = true;
      pending = pending.filter((p) => p.topHeight < part.bottomHeight);   // a one-header part's top is its bottom
      work += part.work - headerWork(header); h = part.bottomHeight; header = { prev: part.bottomPrev };
      continue;
    }
    if (h <= CFG.scanFrom) return { end: "refused", skipped };
    const prev = typeof header.prev === "string" ? header.prev.toLowerCase() : "";
    const at = await known(prev, anchor);
    if (at) {
      if (at.height !== h - 1) return { end: "refused", skipped };
      return { end: "linked", work: at.work == null ? null : at.work + work, kept: [own(prev)] };
    }
    let below: ProofHeader | null;
    try { below = await headerAt(base, h - 1, signal); } catch {
      // The deadline or a failed read ends this pass's walk; what is proved stays for the next pass.
      return { end: "short", kept: keepParts(own(prev), pending) };
    }
    if (!below || !tipHeaderPowOk(below, prev)) return { end: "refused", skipped };
    header = below; hash = prev; h--; work += headerWork(below);
  }
}

// The parts a short walk keeps: its own, merged with each older part that continues it (the part's top is the height
// under its bottom, with its bottomPrev as hash), and the highest older part under that.
function keepParts(own: Proved, pending: readonly Proved[]): Proved[] {
  let top = own;
  for (const p of [...pending].filter((x) => x.topHeight < own.bottomHeight).sort((x, y) => y.topHeight - x.topHeight)) {
    if (p.topHeight !== top.bottomHeight - 1 || p.topHash !== top.bottomPrev) return [top, p];
    top = { ...top, bottomHeight: p.bottomHeight, bottomPrev: p.bottomPrev, work: top.work + p.work, anchorTip: top.anchorTip === p.anchorTip ? top.anchorTip : null };
  }
  return [top];
}

// The anchor's tip moved inside a kept part since the part was compared with it.
const moved = (part: Proved, anchor: Probe, anchorTip: string | null): boolean =>
  part.anchorTip !== anchorTip && anchor.height >= part.bottomHeight && anchor.height < part.topHeight;

// Whether a walk at a kept part's top joins it: always, unless the anchor's tip moved inside the part and is nearer
// the part's top than the stored tip is under the part's bottom.
async function joins(part: Proved, anchor: Probe, anchorTip: string | null): Promise<boolean> {
  if (!moved(part, anchor, anchorTip)) return true;
  const top = await store().get<{ h: number | bigint | null }>("SELECT MAX(height) AS h FROM blocks");
  const stored = top?.h == null ? CFG.scanFrom - 1 : Number(top.h);
  return part.bottomHeight - 1 - stored < part.topHeight - anchor.height;
}

async function logShortProof(base: string, claimedHeight: number, h: number, anchor: Probe): Promise<void> {
  const top = await store().get<{ h: number | bigint | null }>("SELECT MAX(height) AS h FROM blocks");
  const nearest = Math.max(anchor.height, top?.h == null ? -1 : Number(top.h));
  console.warn(`[rpc] link proof for ${base} (tip ${claimedHeight}): ${claimedHeight - h + 1} headers proved, down to ${h}, ` +
    `at least ${Math.max(0, h - 1 - nearest)} to go; it goes on at the next pass`);
}

const primaryBackend = (): string => (CFG.rpcBackends && CFG.rpcBackends[0]) || CFG.rpc;
// Backends that served a block whose header failed admitBlock, each with the /tip hash it answered then. One is left
// out of the selection while it answers that tip; the primary is never left (its blocks are not checked).
const left = new Map<string, string | null>();
const lastTip = new Map<string, string | null>();
/** Whether the active backend is one admitBlock left: syncOnce then reads nothing from it this pass. */
export function activeLeft(): boolean { return left.has(ACTIVE); }

/** Whether syncOnce may write a block the active backend serves, with the chainwork it may store. The primary's
 *  blocks are written as served. A non-primary backend's block must carry a header that hashes to the block's hash
 *  and meets its own bits (tipHeaderPowOk) and whose bits are plausible against the stored chain (contenderPlausible:
 *  not easier than 16 times the target the stored LWMA window gives the newest stored block), the checks a
 *  contender's tip header passes; its chainwork is then at most its stored parent's plus that header's work, as the
 *  selection ranks that backend's claim. A block that fails is not written and its backend is left
 *  (test/rpc-route-honest.test.ts). */
export async function admitBlock(b: RpcBlock): Promise<boolean> {
  if (ACTIVE === primaryBackend()) return true;
  if (!tipHeaderPowOk(b.header, b.hash) || !(await contenderPlausible(b.height, b.header))) {
    left.set(ACTIVE, lastTip.get(ACTIVE) ?? null);
    return false;
  }
  const reported = parseWork(b.chainwork);
  if (reported == null) return true;
  const parent = await store().get<{ chainwork: string | null }>("SELECT chainwork FROM blocks WHERE height=? AND hash=?", b.height - 1, b.header.prev);
  const base = parseWork(parent?.chainwork);
  if (base == null) return true;
  const bound = base + headerWork(b.header);
  if (reported > bound) b.chainwork = String(bound);
  return true;
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

// A /tip answer's height, or null when it is not a non-negative safe integer. Selection and the sync pass read nothing
// from such an answer: a NaN height compares false everywhere, so it voided the selection's hysteresis and gave the
// tip window no height to converge at (test/rpc-tip-height.test.ts).
function tipHeight(j: any): number | null {
  const h = j?.height;
  return typeof h === "number" && Number.isSafeInteger(h) && h >= 0 ? h : null;
}

async function tipOf(base: string): Promise<{ height: number; chainwork: bigint; tipHash: string | null } | null> {
  try {
    const res = await fetch(base + "/tip", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const height = tipHeight(j);
    if (height == null) return null;
    const tipHash = typeof j.tip === "string" && j.tip ? String(j.tip) : null;
    return { height, chainwork: BigInt(String(j.chainwork ?? "0")), tipHash };
  } catch { return null; }
}

/**
 * Choose which backend to read THIS cycle: the reachable one with the most cumulative chainwork, with
 * HYSTERESIS so it does not flap. Keep ACTIVE while it is reachable, eligible and within HYSTERESIS_BLOCKS of the best
 * height and not out-worked for CFG.workEscapeCycles cycles, so same-chain backends racing block propagation do not
 * flap and a primary that returns does not take the feed back until ACTIVE falls behind it (a secondary at the tip
 * the index stores stays eligible: test/rpc-route-honest.test.ts). Only when ACTIVE falls meaningfully behind
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
 * runs `contenderPlausible`, which anchors on the indexer's OWN stored headers (delta cap +
 * LWMA ease factor), never the live primary; so a min-diff forgery is excluded while a genuinely-ahead
 * honest secondary at the correct local difficulty is still selected when the primary is stale.
 */
type Probe = { height: number; chainwork: bigint; tipHash: string | null };
export async function selectBackend(): Promise<{ active: string; switched: boolean; height: number }> {
  const backends = CFG.rpcBackends && CFG.rpcBackends.length ? CFG.rpcBackends : [CFG.rpc];
  const probed = await Promise.all(backends.map(async (b) => ({ b, t: await tipOf(b) })));
  for (const { b, t } of probed) {
    if (t) lastTip.set(b, t.tipHash);
    if (t && left.has(b) && left.get(b) !== t.tipHash) left.delete(b);   // a new tip: the backend is read again
  }
  const reachable = probed.filter((x): x is { b: string; t: Probe } => x.t != null && !left.has(x.b));
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
    const work = new Map(await Promise.all(contenders.map(async (r) => [r.b, await contenderEligible(r.b, r.t.height, r.t.tipHash, r.t.chainwork, authority.t)] as const)));
    eligible = reachable.flatMap((r) => {
      if (!work.has(r.b)) return [r];
      const w = work.get(r.b);
      return w == null ? [] : [{ b: r.b, t: { ...r.t, chainwork: w } }];
    });
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
  const height = tipHeight(j);
  if (height == null) throw new Error(`rpc /tip -> height ${JSON.stringify(j?.height)} is not a non-negative integer`);
  return { height, tip: String(j.tip ?? ""), chainwork: String(j.chainwork ?? "0") };
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
    // A Propose's domain and uri are author-written text: from here on writeBlock and the event bus see their stored
    // form. Another author-written field the indexer starts to read goes through storableText here too.
    for (const t of b.txs) {
      const app = t?.app;
      if (app && typeof app.domain === "string") app.domain = storableText(app.domain);
      if (app && typeof app.uri === "string") app.uri = storableText(app.uri);
    }
    return b as RpcBlock;
  } catch { return null; }
}

