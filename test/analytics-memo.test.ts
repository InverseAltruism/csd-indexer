// Per-tip memoization proof for the public analytics endpoints (analytics.ts memoByTip): two calls
// at the same canonical tip return the cached object (reference identity = a hit, the full-table scan
// ran once), and a new block (tip change) busts the cache and recomputes. Guards the cheap fix that
// collapses the unauthenticated O(table) scans from once-per-request to once-per-block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("memo");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_memo";

const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { supply, supplyFigures, miners, richlist, memoByTip } = await import("../src/analytics.js");
await resetStoreForTests();
test.after(async () => { await closeDb(); });

const A = "0x" + "aa".repeat(20);
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const SQL_BLOCK = "INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES (?,?,?,?,?,?,?,?,?,?,0)";
const SQL_TX = "INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES (?,?,?,?,?,?,?,?,?,?)";
const SQL_OUT = "INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES (?,?,?,?,?,?,?)";
const REWARD = 5_000_000_000;

async function addBlock(h: number): Promise<void> {
  const s = store();
  await s.run(SQL_BLOCK, h, id(1000 + h), id(999 + h), id(2000 + h), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, 1, String(h * 1000));
  const cb = id(10_000 + h);
  await s.run(SQL_TX, cb, h, 0, "Coinbase", A, 0, 1_700_000_000 + h * 120, 1, 1, 1);
  await s.run(SQL_OUT, cb, 0, A, REWARD, h, null, null);
}

for (let h = 1; h <= 3; h++) await addBlock(h);
// holders for the rich list beyond the miner: distinct balances, and a tie that addr ASC orders
for (const [i, value] of [700, 500, 500, 300, 100].entries()) {
  await store().run(SQL_OUT, id(20_000 + i), 0, "0x" + String(i + 1).repeat(40), value, 1, null, null);
}

// GROUP BY addr scans of the unspent outputs (the rich list's query), counted at the store
let scans = 0;
const st = store() as unknown as { all: (...a: unknown[]) => Promise<unknown> };
const all = st.all.bind(store());
st.all = (...a: unknown[]) => { if (/GROUP BY addr/.test(String(a[0]))) scans++; return all(...a); };

test("same tip → cached object (hit); new block → recompute (bust)", async () => {
  const r1 = await supply();
  const r2 = await supply();
  assert.equal(r1, r2, "two supply() calls at the same tip return the cached object (===)");
  const f1 = await supplyFigures();
  assert.equal(f1, await supplyFigures(), "supply figures (the plain-text routes' source) cached at the same tip");

  const m1 = await miners("all");
  assert.equal(m1, await miners("all"), "miners cached at the same tip");
  // canonicalized keys: an unknown window dedups to one entry (the cache cannot be grown by varying ?window)
  assert.equal(m1, await miners("bogus"), "unknown window collapses to 'all' → same cached object");

  await addBlock(4); // tip advances → the cache must bust
  const r3 = await supply();
  assert.notEqual(r3, r1, "after a new block supply() recomputes a fresh object");
  assert.equal((r3 as { height: number }).height, 4, "fresh result reflects the new tip height");
  assert.equal((await supplyFigures())?.height, 4, "supply figures recomputed at the new tip");
  assert.ok(
    BigInt((r3 as { emitted_supply: string }).emitted_supply) > BigInt((r1 as { emitted_supply: string }).emitted_supply),
    "emitted supply grew with the new block (recomputed, not stale)",
  );
});

// The rich list at every ?limit a caller can send costs one scan per tip, and each answer is what the query with that
// LIMIT returns (rank, balance, utxos and share of emitted supply, in balance DESC, addr ASC order).
test("richlist: every limit from 1 to 500 at one tip runs one GROUP BY scan; each answer equals its own LIMIT query", async () => {
  await addBlock(5);
  scans = 0;
  const byLimit = new Map<number, any>();
  for (let n = 1; n <= 500; n++) byLimit.set(n, await richlist(n));
  for (const odd of [0, -3, 600, 700, 50.9, Number.NaN]) await richlist(odd);
  assert.equal(scans, 1, "one scan per tip, whatever the limits asked");
  const emitted = BigInt((await supply() as { emitted_supply: string }).emitted_supply);
  for (const n of [1, 2, 3, 4, 6, 7, 50, 500]) {
    const rows = await all(`SELECT addr, SUM(value) AS balance, COUNT(*) AS utxos FROM outputs WHERE spent_txid IS NULL AND addr IS NOT NULL
      GROUP BY addr ORDER BY balance DESC, addr ASC LIMIT ?`, n) as { addr: string; balance: number | bigint; utxos: number | bigint }[];
    const r = byLimit.get(n);
    assert.equal(r.count, rows.length, `count at limit ${n}`);
    assert.deepEqual(r.holders, rows.map((x, i) => ({ rank: i + 1, addr: x.addr, balance: Number(x.balance), utxos: Number(x.utxos),
      pct_of_emitted: Number((BigInt(x.balance) * 1_000_000n) / emitted) / 10_000 })), `holders at limit ${n}`);
  }
  assert.deepEqual((await richlist(50.9) as any).holders, byLimit.get(50).holders, "a fractional limit floors");
  assert.equal((await richlist(600) as any).count, 6, "a limit past 500 clamps to the whole list here");
  assert.equal(scans, 1);
  await addBlock(6);
  await richlist(8);
  assert.equal(scans, 2, "a new tip scans again");
});

test("memoByTip: concurrent reads at one tip share one computation", async () => {
  let calls = 0;
  const slow = memoByTip(async (x: number) => { calls++; await new Promise((r) => setTimeout(r, 30)); return { x }; });
  const got = await Promise.all(Array.from({ length: 20 }, () => slow(1)));
  assert.equal(calls, 1, "20 concurrent reads at one tip run the computation once");
  assert.ok(got.every((g) => g === got[0]), "and all get its result");
});

test("memoByTip: a failed computation is not kept; the next read at the same tip computes again", async () => {
  let calls = 0;
  const flaky = memoByTip(async () => { calls++; if (calls === 1) throw new Error("store down"); return "ok"; });
  await assert.rejects(flaky(), /store down/);
  assert.equal(await flaky(), "ok", "the rejection was dropped");
  assert.equal(await flaky(), "ok");
  assert.equal(calls, 2, "and the success is kept");
});
