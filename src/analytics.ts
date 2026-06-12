// Miner / holder / supply analytics — read-only aggregates over the relational store.
// Frontier item #2 (cairn docs/ecosystem/06-frontier.md): miners are the chain's only
// existing audience and nobody serves them charts. Everything here is canonical-row math
// (reorged rows are deleted by the indexer, so no orphan filtering is needed on txs/outputs).
//
// Integer columns arrive from the store as number-when-exact / bigint-past-2^53 (db.ts) —
// big() normalizes to BigInt for math, amt() serializes (a stray BigInt would crash
// JSON.stringify; total emission crosses 2^53 in a few years and must never 500 these endpoints).
import { store } from "./db.js";

// nominal blocks per window at the 120s target (heights, not wall-time — deterministic)
const WINDOWS: Record<string, number> = { "1d": 720, "7d": 5040, "30d": 21600 };

const COIN = 100_000_000n;
const INITIAL_REWARD = 50n * COIN;
const HALVING_INTERVAL = 1_051_200;
const MAX_HALVINGS = 64;

export function blockReward(height: number): bigint {
  const era = Math.floor(height / HALVING_INTERVAL);
  if (era >= MAX_HALVINGS) return 0n;
  return INITIAL_REWARD >> BigInt(era);
}

export function maxSupply(): bigint {
  let s = 0n;
  for (let era = 0; era < MAX_HALVINGS; era++) s += (INITIAL_REWARD >> BigInt(era)) * BigInt(HALVING_INTERVAL);
  return s;
}

// store values are number|bigint|null — normalize for BigInt math / Number display.
function big(v: number | bigint | null | undefined): bigint { return v == null ? 0n : BigInt(v); }
// A BigInt amount → JS number when safe, else a decimal string (never lossy; never NaN in JSON).
function amt(v: number | bigint | null | undefined): number | string {
  const b = big(v);
  return b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(b) : b.toString();
}

async function tipRow(): Promise<{ height: number; time: number; chainwork: string } | null> {
  return (await store().get("SELECT height, time, chainwork FROM blocks WHERE orphaned=0 ORDER BY height DESC LIMIT 1")) as never ?? null;
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

export async function miners(window: string): Promise<unknown> {
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

export async function richlist(limit = 100): Promise<unknown> {
  const tip = await tipRow();
  if (!tip) return { ok: false, error: "no blocks indexed" };
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 100));
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

export async function supply(): Promise<unknown> {
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
