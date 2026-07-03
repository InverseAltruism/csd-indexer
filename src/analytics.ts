// Miner / holder / supply analytics — read-only aggregates over the relational store.
// Frontier item #2 (cairn docs/ecosystem/06-frontier.md): miners are the chain's only
// existing audience and nobody serves them charts. Everything here is canonical-row math
// (reorged rows are deleted by the indexer, so no orphan filtering is needed on txs/outputs).
//
// Integer columns arrive from the store as number-when-exact / bigint-past-2^53 (db.ts) —
// big() normalizes to BigInt for math, amt() serializes (a stray BigInt would crash
// JSON.stringify; total emission crosses 2^53 in a few years and must never 500 these endpoints).
import { store } from "./db.js";
import { amt, tipRow as tipRowCanonical } from "./queries.js";

// nominal blocks per window at the 120s target (heights, not wall-time — deterministic)
const WINDOWS: Record<string, number> = { "1d": 720, "7d": 5040, "30d": 21600 };

// Canonicalize the public args BEFORE they reach the memo cache key (below), so an attacker varying
// ?window / ?limit cannot defeat the per-tip dedup or grow the cache one entry per distinct value:
// every unknown window collapses to "all" (minersImpl already treats unknown as all-time), and limit
// clamps to the same [1,500] range richlistImpl uses. Bounds the cache to 4 window keys + the limit set.
const normWindow = (w: string): string => (w in WINDOWS ? w : "all");
const normLimit = (limit: number): number => Math.max(1, Math.min(500, Math.floor(Number(limit)) || 100));

// Emission schedule: SINGLE-SOURCED from csd-codec since 0.1.15 (Plan 57 B8c; the local
// hand-encoded table this file carried is retired). blockReward/maxSupply keep their exported
// bigint signatures via the codec's exact-bigint helpers; test/analytics-lockstep.test.ts pins
// the ADOPTED values at known heights so a bad codec bump still fails loud in THIS repo.
import { blockRewardBase, maxSupplyBase, HALVING_INTERVAL } from "@inversealtruism/csd-codec";
export const blockReward = blockRewardBase;
export const maxSupply = maxSupplyBase;

// store values are number|bigint|null — normalize for BigInt math. amt() (serialization) is the
// ONE copy in queries.ts since B8c (was defined verbatim-adjacent in both files).
function big(v: number | bigint | null | undefined): bigint { return v == null ? 0n : BigInt(v); }

// Canonical tip-row reader lives in queries.ts since B8c (was one of three near-identical
// SELECT-the-tip queries in this repo); this module derives its two shapes from it.
async function tipRow(): Promise<{ height: number; time: number; chainwork: string } | null> {
  return await tipRowCanonical();
}

// ── per-tip memoization ──────────────────────────────────────────────────────
// supply / richlist / miners are O(table) full scans (SUM/GROUP BY over outputs+txs) that are
// reachable unauthenticated via the cairn proxy and run on the SAME single event loop that writes
// blocks — so a request flood would otherwise stall ingestion at scale. Their result changes ONLY
// when the canonical tip changes (a new block or a reorg), so cache keyed on the tip identity
// (height + hash → a same-height reorg also busts it). Args are canonicalized by the exported
// wrappers (normWindow/normLimit) BEFORE keying, so the dedup holds even under garbage-varied params
// and the cache stays bounded to the small fixed arg set. Returns the cached object by reference
// (callers only serialize it, never mutate). No tip yet (empty chain) → never caches; cache holds only
// current-tip entries (cleared on tip change). The tipKey()-then-impl-tipRow() gap is a benign TOCTOU:
// a result computed at T+1 could be stored under key T, but it is evicted on the next call (which sees
// T+1 and clears) and only ever served on an exact reorg back to (T,hash); these are non-consensus,
// self-healing display analytics, so it is left unguarded rather than paying a second tip query.
async function tipKey(): Promise<string | null> {
  const r = await tipRowCanonical();
  return r ? `${r.height}:${r.hash}` : null;
}
// Exported so server.ts can give /health's counts() the same once-per-block treatment: /health is
// the failover-LB poll target, so its four COUNT(*) full scans were the most-hit unmemoized cost.
export function memoByTip<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): (...args: A) => Promise<unknown> {
  let curKey: string | null = null;
  const cache = new Map<string, unknown>();
  return async (...args: A): Promise<unknown> => {
    const key = await tipKey();
    if (key === null) return fn(...args);                 // no tip indexed → compute, don't cache
    if (key !== curKey) { cache.clear(); curKey = key; }  // tip moved → drop stale-tip entries
    const mk = JSON.stringify(args);
    if (cache.has(mk)) return cache.get(mk);
    const value = await fn(...args);
    cache.set(mk, value);
    return value;
  };
}

/** Network hashrate over [from..to] derived from cumulative chainwork — exact, no bits math. */
async function windowHashrate(fromHeight: number, toHeight: number): Promise<{ hashrate: number; seconds: number } | null> {
  const a = await store().get<{ time: number; chainwork: string }>("SELECT time, chainwork FROM blocks WHERE orphaned=0 AND height=?", fromHeight);
  const b = await store().get<{ time: number; chainwork: string }>("SELECT time, chainwork FROM blocks WHERE orphaned=0 AND height=?", toHeight);
  if (!a?.chainwork || !b?.chainwork) return null;
  const dw = BigInt(b.chainwork) - BigInt(a.chainwork);
  const dt = Number(b.time) - Number(a.time);
  if (dt <= 0 || dw <= 0n) return null;
  return { hashrate: Number(dw) / dt, seconds: dt };
}

async function minersImpl(window: string): Promise<unknown> {
  const tip = await tipRow();
  if (!tip) return { ok: false, error: "no blocks indexed" };
  const span = WINDOWS[window] ?? 0; // 0 / unknown → all-time
  const from = span ? Math.max(0, Number(tip.height) - span) : 0;

  const rows = await store().all<{ addr: string; blocks: number | bigint; last_height: number | bigint; last_time: number | bigint; fees_collected: number | bigint | null }>(`
    SELECT signer AS addr, COUNT(*) AS blocks, MAX(height) AS last_height, MAX(time) AS last_time,
           SUM(fee) AS fees_collected
    FROM txs WHERE coinbase=1 AND height > ? AND height <= ?
    GROUP BY signer ORDER BY blocks DESC, addr ASC
  `, from, tip.height);

  const total = rows.reduce((s, r) => s + Number(r.blocks), 0);
  const minH = from === 0
    ? Number((await store().get<{ h: number }>("SELECT MIN(height) h FROM blocks WHERE orphaned=0"))?.h ?? 0)
    : from;
  const hr = await windowHashrate(minH, Number(tip.height));

  const minersOut = rows.map((r) => {
    const blocks = Number(r.blocks);
    const share = total ? blocks / total : 0;
    return {
      addr: r.addr, blocks, share,
      last_height: Number(r.last_height), last_time: Number(r.last_time),
      fees_collected: amt(r.fees_collected),
      est_hashrate: hr ? share * hr.hashrate : null,
      est_rel_err: blocks > 0 ? 1 / Math.sqrt(blocks) : null, // Poisson ±1σ
    };
  });

  const top1 = minersOut[0]?.share ?? 0;
  const top3 = minersOut.slice(0, 3).reduce((s, m) => s + m.share, 0);
  const hhi = minersOut.reduce((s, m) => s + m.share * m.share, 0);

  const agg = await store().get<{ blocks: number | bigint; txs: number | bigint | null; t0: number | bigint | null; t1: number | bigint | null }>(`
    SELECT COUNT(*) AS blocks, SUM(tx_count) AS txs, MIN(time) AS t0, MAX(time) AS t1
    FROM blocks WHERE orphaned=0 AND height > ? AND height <= ?
  `, from, tip.height);
  const fees = await store().get<{ f: number | bigint | null }>("SELECT SUM(fee) AS f FROM txs WHERE coinbase=0 AND height > ? AND height <= ?", from, tip.height);
  const nBlocks = Number(agg?.blocks ?? 0);

  return {
    ok: true, window: span ? window : "all", from_height: from, to_height: Number(tip.height),
    blocks: nBlocks, total_txs: amt(agg?.txs), total_fees: amt(fees?.f),
    avg_interval_secs: nBlocks > 1 ? (Number(agg?.t1) - Number(agg?.t0)) / (nBlocks - 1) : null,
    network_hashrate: hr?.hashrate ?? null,
    miner_count: minersOut.length,
    concentration: { top1, top3, hhi },
    miners: minersOut,
  };
}

async function richlistImpl(limit = 100): Promise<unknown> {
  const tip = await tipRow();
  if (!tip) return { ok: false, error: "no blocks indexed" };
  const lim = normLimit(limit);
  const rows = await store().all<{ addr: string; balance: number | bigint; utxos: number | bigint }>(`
    SELECT addr, SUM(value) AS balance, COUNT(*) AS utxos
    FROM outputs WHERE spent_txid IS NULL AND addr IS NOT NULL
    GROUP BY addr ORDER BY balance DESC, addr ASC LIMIT ?
  `, lim);
  const emitted = await emittedSupply();
  return {
    ok: true, height: Number(tip.height), count: rows.length, emitted_supply: emitted.toString(),
    holders: rows.map((r, i) => ({
      rank: i + 1, addr: r.addr, balance: amt(r.balance), utxos: Number(r.utxos),
      pct_of_emitted: emitted > 0n ? Number((big(r.balance) * 1_000_000n) / emitted) / 10_000 : 0,
    })),
  };
}

async function sumBig(sql: string): Promise<bigint> {
  return big((await store().get<{ v: number | bigint | null }>(sql))?.v);
}

/** True emission = Σ coinbase outputs − Σ tx fees (coinbase value = subsidy + fees). */
async function emittedSupply(): Promise<bigint> {
  const cb = await sumBig("SELECT SUM(o.value) AS v FROM outputs o JOIN txs t ON o.txid=t.txid WHERE t.coinbase=1");
  const fees = await sumBig("SELECT SUM(fee) AS v FROM txs WHERE coinbase=0");
  return cb - fees;
}

async function supplyImpl(): Promise<unknown> {
  const tip = await tipRow();
  if (!tip) return { ok: false, error: "no blocks indexed" };
  const emitted = await emittedSupply();
  const max = maxSupply();
  const h = Number(tip.height);
  const era = Math.floor(h / HALVING_INTERVAL);
  const nextHalving = (era + 1) * HALVING_INTERVAL;
  const remaining = nextHalving - h;
  return {
    ok: true, height: h,
    emitted_supply: emitted.toString(),
    max_supply: max.toString(),
    pct_emitted: Number((emitted * 1_000_000n) / max) / 10_000,
    block_reward: blockReward(h).toString(),
    halving: {
      era, interval: HALVING_INTERVAL, next_height: nextHalving, blocks_remaining: remaining,
      est_seconds_remaining: remaining * 120,
      next_reward: blockReward(nextHalving).toString(),
    },
  };
}

// Public endpoints (server.ts) — args canonicalized (normWindow/normLimit) THEN memoized per canonical
// tip, so the cache key is bounded and the dedup fires for repeated AND garbage-varied params. The
// *Impl functions above are the uncached source of truth (and what the offline analytics test exercises
// through these exports). supply() is argless.
const minersMemo = memoByTip(minersImpl);
const richlistMemo = memoByTip(richlistImpl);
export const miners = (window: string): Promise<unknown> => minersMemo(normWindow(window));
export const richlist = (limit = 100): Promise<unknown> => richlistMemo(normLimit(limit));
export const supply = memoByTip(supplyImpl);
