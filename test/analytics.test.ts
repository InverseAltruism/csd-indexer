// Offline analytics proof — synthetic blocks/txs/outputs in a throwaway DB, then assert
// the miner-leaderboard math (shares, chainwork-derived hashrate, Poisson error, HHI),
// the rich list (spent exclusion, ordering, pct-of-emitted), and the supply/halving schedule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB = `/tmp/csd-idx-analytics-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;

const { db } = await import("../src/db.js");
const { miners, richlist, supply, blockReward, maxSupply } = await import("../src/analytics.js");

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");

// ── synthetic chain: 10 blocks, miners A(6) B(3) C(1), 120s spacing, linear chainwork ──
// chainwork grows 1000/block → over 9 intervals (1080s): Δwork 9000 → hashrate 9000/1080 = 8.333…
const d = db();
const insBlock = d.prepare("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES (?,?,?,?,?,?,?,?,?,?,0)");
const insTx = d.prepare("INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES (?,?,?,?,?,?,?,?,?,?)");
const insOut = d.prepare("INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES (?,?,?,?,?,?,?)");

const REWARD = 5_000_000_000;
const minerOf = (h: number) => (h <= 6 ? A : h <= 9 ? B : C);
let txn = 0;
for (let h = 1; h <= 10; h++) {
  const m = minerOf(h);
  const fees = h === 5 ? 25_000_000 : 0; // block 5 carries a propose paying fees to its miner
  insBlock.run(h, id(1000 + h), id(999 + h), id(2000 + h), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, fees ? 2 : 1, String(h * 1000));
  const cbid = id(++txn);
  insTx.run(cbid, h, 0, "Coinbase", m, 0, 1_700_000_000 + h * 120, 1, 1, 1);
  insOut.run(cbid, 0, m, REWARD + fees, h, null, null);
  if (fees) {
    const pid = id(++txn);
    insTx.run(pid, h, 1, "Propose", A, fees, 1_700_000_000 + h * 120, 1, 1, 0);
    insOut.run(pid, 0, A, 100, h, null, null); // change
  }
}
// A spends one of its coinbases away to C (tests rich-list spent exclusion)
const spendId = id(++txn);
insTx.run(spendId, 10, 1, "Transfer", A, 0, 1_700_000_000 + 1200, 1, 1, 0);
d.prepare("UPDATE outputs SET spent_txid=?, spent_height=10 WHERE txid=? AND vout=0").run(spendId, id(1)); // block-1 coinbase spent
insOut.run(spendId, 0, C, REWARD, 10, null, null);

test("miners: shares, concentration, chainwork hashrate, Poisson error", () => {
  const r = miners("all") as any;
  assert.equal(r.ok, true);
  assert.equal(r.blocks, 10);
  assert.equal(r.miner_count, 3);
  const a = r.miners[0];
  assert.equal(a.addr, A); assert.equal(a.blocks, 6); assert.ok(Math.abs(a.share - 0.6) < 1e-9);
  assert.ok(Math.abs(a.est_rel_err - 1 / Math.sqrt(6)) < 1e-9);
  assert.ok(Math.abs(r.concentration.top1 - 0.6) < 1e-9);
  assert.ok(Math.abs(r.concentration.top3 - 1.0) < 1e-9);
  assert.ok(Math.abs(r.concentration.hhi - (0.36 + 0.09 + 0.01)) < 1e-9);
  // Δchainwork 1000→10000 over 9×120s = 9000/1080
  assert.ok(Math.abs(r.network_hashrate - 9000 / 1080) < 1e-6);
  assert.ok(Math.abs(a.est_hashrate - 0.6 * (9000 / 1080)) < 1e-6);
  assert.equal(r.total_fees, 25_000_000);
  assert.ok(Math.abs(r.avg_interval_secs - 120) < 1e-9);
});

test("miners: window slicing (last N blocks only)", () => {
  // window "1d" = 720 blocks > chain length → effectively all; use a tiny custom check via heights:
  const all = miners("all") as any;
  const day = miners("1d") as any; // from = max(0, 10-720) = 0 → same as all here
  assert.equal(day.blocks, all.blocks);
});

test("richlist: spent outputs excluded, ordering + pct correct", () => {
  const r = richlist(10) as any;
  assert.equal(r.ok, true);
  // emitted = Σ coinbase values − Σ fees = 10*REWARD + 25M − 25M = 500 CSD
  assert.equal(r.emitted_supply, String(10 * REWARD));
  const byAddr = Object.fromEntries(r.holders.map((h: any) => [h.addr, h]));
  // A: 6 coinbases (one spent) − … = 5*REWARD + fee-carrying block extra: block5 coinbase = REWARD+25M, +100 change
  assert.equal(byAddr[A].balance, 5 * REWARD + 25_000_000 + 100);
  // C: 1 coinbase + received spend
  assert.equal(byAddr[C].balance, 2 * REWARD);
  assert.equal(byAddr[B].balance, 3 * REWARD);
  assert.equal(r.holders[0].addr, A); // ordering by balance desc
  assert.ok(Math.abs(byAddr[B].pct_of_emitted - 30) < 0.01); // 3/10 of emission
});

test("supply: schedule math + halving countdown", () => {
  const s = supply() as any;
  assert.equal(s.ok, true);
  assert.equal(s.emitted_supply, String(10 * REWARD));
  assert.equal(s.block_reward, String(REWARD));
  assert.equal(s.halving.next_height, 1_051_200);
  assert.equal(s.halving.blocks_remaining, 1_051_200 - 10);
  assert.equal(s.halving.next_reward, String(REWARD / 2));
  // closed-form max supply: Σ era<64 of (50e8 >> era) * 1,051,200
  assert.equal(s.max_supply, maxSupply().toString());
  assert.ok(BigInt(s.max_supply) > 105_000_000n * 100_000_000n && BigInt(s.max_supply) < 105_200_000n * 100_000_000n);
});

test("blockReward halves per era and hits zero after 64", () => {
  assert.equal(blockReward(0), 5_000_000_000n);
  assert.equal(blockReward(1_051_199), 5_000_000_000n);
  assert.equal(blockReward(1_051_200), 2_500_000_000n);
  assert.equal(blockReward(64 * 1_051_200), 0n);
});
