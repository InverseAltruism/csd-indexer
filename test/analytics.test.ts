// Offline analytics proof: synthetic blocks/txs/outputs in a throwaway DB, then assert
// the miner-leaderboard math (shares, chainwork-derived hashrate, Poisson error, HHI),
// the rich list (spent exclusion, ordering, pct-of-emitted), the supply/halving schedule, the burn at the
// zero address and the plain-text supply routes.
//
// Backend-agnostic: sqlite by default; CSD_INDEX_PG runs the identical suite on Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("analytics");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_analytics";

const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { miners, richlist, supply, blockReward, maxSupply, csdDecimal } = await import("../src/analytics.js");
const { buildApp } = await import("../src/server.js");
await resetStoreForTests();
const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const getText = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
};
test.after(async () => { srv.close(); await closeDb(); });

// Read before any block exists: the supply routes must refuse, never answer a number.
const EMPTY = {
  total: await getText("/analytics/supply/total"),
  circulating: await getText("/analytics/supply/circulating"),
};

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const ZERO = "0x" + "00".repeat(20);
const BURN = 123_456_789; // 1.23456789 CSD sent to the zero address
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");

// ── synthetic chain: 10 blocks, miners A(6) B(3) C(1), 120s spacing, linear chainwork ──
// chainwork grows 1000/block → over 9 intervals (1080s): Δwork 9000 → hashrate 9000/1080 = 8.333…
const s = store();
const SQL_BLOCK = "INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES (?,?,?,?,?,?,?,?,?,?,0)";
const SQL_TX = "INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES (?,?,?,?,?,?,?,?,?,?)";
const SQL_OUT = "INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES (?,?,?,?,?,?,?)";

const REWARD = 5_000_000_000;
const minerOf = (h: number) => (h <= 6 ? A : h <= 9 ? B : C);
let txn = 0;
for (let h = 1; h <= 10; h++) {
  const m = minerOf(h);
  const fees = h === 5 ? 25_000_000 : 0; // block 5 carries a propose paying fees to its miner
  await s.run(SQL_BLOCK, h, id(1000 + h), id(999 + h), id(2000 + h), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, fees ? 2 : 1, String(h * 1000));
  const cbid = id(++txn);
  await s.run(SQL_TX, cbid, h, 0, "Coinbase", m, 0, 1_700_000_000 + h * 120, 1, 1, 1);
  await s.run(SQL_OUT, cbid, 0, m, REWARD + fees, h, null, null);
  if (fees) {
    const pid = id(++txn);
    await s.run(SQL_TX, pid, h, 1, "Propose", A, fees, 1_700_000_000 + h * 120, 1, 1, 0);
    await s.run(SQL_OUT, pid, 0, A, 100, h, null, null); // change
  }
}
// A spends one of its coinbases away to C (tests rich-list spent exclusion)
const spendId = id(++txn);
await s.run(SQL_TX, spendId, 10, 1, "Transfer", A, 0, 1_700_000_000 + 1200, 1, 1, 0);
await s.run("UPDATE outputs SET spent_txid=?, spent_height=10 WHERE txid=? AND vout=0", spendId, id(1)); // block-1 coinbase spent
await s.run(SQL_OUT, spendId, 0, C, REWARD, 10, null, null);
// C burns part of what it received: BURN to the zero address, the rest back to C
const burnId = id(++txn);
await s.run(SQL_TX, burnId, 10, 2, "Transfer", C, 0, 1_700_000_000 + 1200, 1, 2, 0);
await s.run("UPDATE outputs SET spent_txid=?, spent_height=10 WHERE txid=? AND vout=0", burnId, spendId);
await s.run(SQL_OUT, burnId, 0, ZERO, BURN, 10, null, null);
await s.run(SQL_OUT, burnId, 1, C, REWARD - BURN, 10, null, null);

test("miners: shares, concentration, chainwork hashrate, Poisson error", async () => {
  const r = await miners("all") as any;
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

test("miners: window slicing (last N blocks only)", async () => {
  // window "1d" = 720 blocks > chain length → effectively all; use a tiny custom check via heights:
  const all = await miners("all") as any;
  const day = await miners("1d") as any; // from = max(0, 10-720) = 0 → same as all here
  assert.equal(day.blocks, all.blocks);
});

test("richlist: spent outputs excluded, ordering + pct correct", async () => {
  const r = await richlist(10) as any;
  assert.equal(r.ok, true);
  // emitted = Σ coinbase values − Σ fees = 10*REWARD + 25M − 25M = 500 CSD
  assert.equal(r.emitted_supply, String(10 * REWARD));
  const byAddr = Object.fromEntries(r.holders.map((h: any) => [h.addr, h]));
  // A: 6 coinbases (one spent) − … = 5*REWARD + fee-carrying block extra: block5 coinbase = REWARD+25M, +100 change
  assert.equal(byAddr[A].balance, 5 * REWARD + 25_000_000 + 100);
  // C: 1 coinbase + received spend, less what it burned
  assert.equal(byAddr[C].balance, 2 * REWARD - BURN);
  assert.equal(byAddr[B].balance, 3 * REWARD);
  assert.equal(r.holders[0].addr, A); // ordering by balance desc
  assert.ok(Math.abs(byAddr[B].pct_of_emitted - 30) < 0.01); // 3/10 of emission
});

test("supply: schedule math + halving countdown", async () => {
  const sup = await supply() as any;
  assert.equal(sup.ok, true);
  assert.equal(sup.emitted_supply, String(10 * REWARD));
  assert.equal(sup.block_reward, String(REWARD));
  assert.equal(sup.halving.next_height, 1_051_200);
  assert.equal(sup.halving.blocks_remaining, 1_051_200 - 10);
  assert.equal(sup.halving.next_reward, String(REWARD / 2));
  // closed-form max supply: Σ era<64 of (50e8 >> era) * 1,051,200
  assert.equal(sup.max_supply, maxSupply().toString());
  assert.ok(BigInt(sup.max_supply) > 105_000_000n * 100_000_000n && BigInt(sup.max_supply) < 105_200_000n * 100_000_000n);
});

test("supply: the existing fields keep their names and values beside the burn fields", async () => {
  const sup = await supply() as any;
  assert.deepEqual(Object.keys(sup), [
    "ok", "height", "emitted_supply", "burned_supply", "total_supply", "circulating_supply",
    "max_supply", "pct_emitted", "block_reward", "halving",
  ]);
  assert.equal(sup.height, 10);
  assert.equal(sup.pct_emitted, Number((BigInt(10 * REWARD) * 1_000_000n) / maxSupply()) / 10_000);
  assert.deepEqual(sup.halving, {
    era: 0, interval: 1_051_200, next_height: 1_051_200, blocks_remaining: 1_051_190,
    est_seconds_remaining: 1_051_190 * 120, next_reward: String(REWARD / 2),
  });
});

test("supply: total is emitted less the zero address's balance; circulating equals total", async () => {
  const sup = await supply() as any;
  assert.equal(sup.emitted_supply, String(10 * REWARD), "a burn does not change emission");
  assert.equal(sup.burned_supply, String(BURN));
  assert.equal(sup.total_supply, String(10 * REWARD - BURN));
  assert.equal(sup.circulating_supply, sup.total_supply);
});

test("csdDecimal: exact whole-CSD text from base units", () => {
  assert.equal(csdDecimal(0n), "0");
  assert.equal(csdDecimal(1n), "0.00000001");
  assert.equal(csdDecimal(100_000_000n), "1");
  assert.equal(csdDecimal(655_315_000_000_000n), "6553150");
  assert.equal(csdDecimal(655_314_949_800_771n), "6553149.49800771");
  assert.equal(csdDecimal(150_000_000n), "1.5");
  assert.equal(csdDecimal(100_000_010n), "1.0000001");
  // past 2^53 base units the text stays exact
  assert.equal(csdDecimal(10_519_999_999_999_999n), "105199999.99999999");
  assert.throws(() => csdDecimal(-1n), RangeError);
});

test("supply routes: only the number in whole CSD, as text/plain", async () => {
  for (const path of ["/analytics/supply/total", "/analytics/supply/circulating"]) {
    const r = await getText(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.type, "text/plain; charset=utf-8", path);
    assert.equal(r.body, "498.76543211", path); // (10 x 50 CSD) - 1.23456789 CSD
  }
  const json = await fetch(`${base}/analytics/supply`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(((await json.json()) as any).total_supply, String(10 * REWARD - BURN));
});

test("supply routes: an empty index answers 503 without a number", () => {
  for (const r of [EMPTY.total, EMPTY.circulating]) {
    assert.equal(r.status, 503);
    assert.doesNotMatch(r.body, /\d/);
  }
});

test("blockReward halves per era and hits zero after 64", () => {
  assert.equal(blockReward(0), 5_000_000_000n);
  assert.equal(blockReward(1_051_199), 5_000_000_000n);
  assert.equal(blockReward(1_051_200), 2_500_000_000n);
  assert.equal(blockReward(64 * 1_051_200), 0n);
});
