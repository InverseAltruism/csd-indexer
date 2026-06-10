// Miner / holder / supply analytics — read-only aggregates over the relational store.
// Frontier item #2 (cairn docs/ecosystem/06-frontier.md): miners are the chain's only
// existing audience and nobody serves them charts. Everything here is canonical-row math
// (reorged rows are deleted by the indexer, so no orphan filtering is needed on txs/outputs).
import { db } from "./db.js";

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

function tipRow(): { height: number; time: number; chainwork: string } | null {
  return db().prepare("SELECT height, time, chainwork FROM blocks WHERE orphaned=0 ORDER BY height DESC LIMIT 1").get() as never;
}

/** Network hashrate over [from..to] derived from cumulative chainwork — exact, no bits math. */
function windowHashrate(fromHeight: number, toHeight: number): { hashrate: number; seconds: number } | null {
  const a = db().prepare("SELECT time, chainwork FROM blocks WHERE orphaned=0 AND height=?").get(fromHeight) as { time: number; chainwork: string } | undefined;
  const b = db().prepare("SELECT time, chainwork FROM blocks WHERE orphaned=0 AND height=?").get(toHeight) as { time: number; chainwork: string } | undefined;
  if (!a?.chainwork || !b?.chainwork) return null;
  const dw = BigInt(b.chainwork) - BigInt(a.chainwork);
  const dt = Number(b.time) - Number(a.time);
  if (dt <= 0 || dw <= 0n) return null;
  return { hashrate: Number(dw) / dt, seconds: dt };
}

export function miners(window: string): unknown {
  const tip = tipRow();
  if (!tip) return { ok: false, error: "no blocks indexed" };
  const span = WINDOWS[window] ?? 0; // 0 / unknown → all-time
  const from = span ? Math.max(0, tip.height - span) : 0;

  const rows = db().prepare(`
    SELECT signer AS addr, COUNT(*) AS blocks, MAX(height) AS last_height, MAX(time) AS last_time,
           SUM(fee) AS fees_collected
    FROM txs WHERE coinbase=1 AND height > ? AND height <= ?
    GROUP BY signer ORDER BY blocks DESC, addr ASC
  `).all(from, tip.height) as Array<{ addr: string; blocks: number; last_height: number; last_time: number; fees_collected: number }>;

  const total = rows.reduce((s, r) => s + r.blocks, 0);
  const hr = windowHashrate(from === 0 ? (db().prepare("SELECT MIN(height) h FROM blocks WHERE orphaned=0").get() as { h: number }).h : from, tip.height);

  const miners = rows.map((r) => {
    const share = total ? r.blocks / total : 0;
    return {
      addr: r.addr, blocks: r.blocks, share,
      last_height: r.last_height, last_time: r.last_time,
      fees_collected: r.fees_collected ?? 0,
      est_hashrate: hr ? share * hr.hashrate : null,
      est_rel_err: r.blocks > 0 ? 1 / Math.sqrt(r.blocks) : null, // Poisson ±1σ
    };
  });

  const top1 = miners[0]?.share ?? 0;
  const top3 = miners.slice(0, 3).reduce((s, m) => s + m.share, 0);
  const hhi = miners.reduce((s, m) => s + m.share * m.share, 0);

  const agg = db().prepare(`
    SELECT COUNT(*) AS blocks, SUM(tx_count) AS txs, MIN(time) AS t0, MAX(time) AS t1
    FROM blocks WHERE orphaned=0 AND height > ? AND height <= ?
  `).get(from, tip.height) as { blocks: number; txs: number; t0: number; t1: number };
  const fees = db().prepare("SELECT SUM(fee) AS f FROM txs WHERE coinbase=0 AND height > ? AND height <= ?").get(from, tip.height) as { f: number };

  return {
    ok: true, window: span ? window : "all", from_height: from, to_height: tip.height,
    blocks: agg.blocks, total_txs: agg.txs ?? 0, total_fees: fees.f ?? 0,
    avg_interval_secs: agg.blocks > 1 ? (agg.t1 - agg.t0) / (agg.blocks - 1) : null,
    network_hashrate: hr?.hashrate ?? null,
    miner_count: miners.length,
    concentration: { top1, top3, hhi },
    miners,
  };
}

export function richlist(limit = 100): unknown {
  const tip = tipRow();
  if (!tip) return { ok: false, error: "no blocks indexed" };
  const lim = Math.max(1, Math.min(500, limit));
  const rows = db().prepare(`
    SELECT addr, SUM(value) AS balance, COUNT(*) AS utxos
    FROM outputs WHERE spent_txid IS NULL AND addr IS NOT NULL
    GROUP BY addr ORDER BY balance DESC, addr ASC LIMIT ?
  `).all(lim) as Array<{ addr: string; balance: number; utxos: number }>;
  const emitted = emittedSupply();
  return {
    ok: true, height: tip.height, count: rows.length, emitted_supply: emitted.toString(),
    holders: rows.map((r, i) => ({
      rank: i + 1, addr: r.addr, balance: r.balance, utxos: r.utxos,
      pct_of_emitted: emitted > 0n ? Number((BigInt(Math.round(r.balance)) * 1_000_000n) / emitted) / 10_000 : 0,
    })),
  };
}

/** True emission = Σ coinbase outputs − Σ tx fees (coinbase value = subsidy + fees). */
function emittedSupply(): bigint {
  const cb = db().prepare("SELECT SUM(o.value) AS v FROM outputs o JOIN txs t ON o.txid=t.txid WHERE t.coinbase=1").get() as { v: number | null };
  const fees = db().prepare("SELECT SUM(fee) AS f FROM txs WHERE coinbase=0").get() as { f: number | null };
  return BigInt(cb.v ?? 0) - BigInt(fees.f ?? 0);
}

export function supply(): unknown {
  const tip = tipRow();
  if (!tip) return { ok: false, error: "no blocks indexed" };
  const emitted = emittedSupply();
  const max = maxSupply();
  const era = Math.floor(tip.height / HALVING_INTERVAL);
  const nextHalving = (era + 1) * HALVING_INTERVAL;
  const remaining = nextHalving - tip.height;
  return {
    ok: true, height: tip.height,
    emitted_supply: emitted.toString(),
    max_supply: max.toString(),
    pct_emitted: Number((emitted * 1_000_000n) / max) / 10_000,
    block_reward: blockReward(tip.height).toString(),
    halving: {
      era, interval: HALVING_INTERVAL, next_height: nextHalving, blocks_remaining: remaining,
      est_seconds_remaining: remaining * 120,
      next_reward: blockReward(nextHalving).toString(),
    },
  };
}
