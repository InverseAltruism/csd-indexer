// Per-tip memoization proof for the public analytics endpoints (analytics.ts memoByTip): two calls
// at the same canonical tip return the cached object (reference identity = a hit, the full-table scan
// ran once), and a new block (tip change) busts the cache and recomputes. Guards the cheap fix that
// collapses the unauthenticated O(table) scans from once-per-request to once-per-block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB = `/tmp/csd-idx-memo-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_memo";

const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { supply, miners, richlist } = await import("../src/analytics.js");
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
  await s.run(SQL_BLOCK, h, id(1000 + h), id(999 + h), id(2000 + h), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, String(h * 1000));
  const cb = id(10_000 + h);
  await s.run(SQL_TX, cb, h, 0, "Coinbase", A, 0, 1_700_000_000 + h * 120, 1, 1, 1);
  await s.run(SQL_OUT, cb, 0, A, REWARD, h, null, null);
}

for (let h = 1; h <= 3; h++) await addBlock(h);

test("same tip → cached object (hit); new block → recompute (bust)", async () => {
  const r1 = await supply();
  const r2 = await supply();
  assert.equal(r1, r2, "two supply() calls at the same tip return the cached object (===)");

  const m1 = await miners("all");
  assert.equal(m1, await miners("all"), "miners cached at the same tip");
  const l1 = await richlist(50);
  assert.equal(l1, await richlist(50), "richlist cached at the same tip (keyed by args)");

  // canonicalized keys: garbage-varied params dedup to one entry (the cache cannot be flooded/grown
  // by varying ?limit / ?window — the whole point of normWindow/normLimit ahead of the memo).
  assert.equal(await richlist(600), await richlist(700), "limits >500 both clamp to 500 → one cached object");
  assert.equal(l1, await richlist(50.9), "fractional limit floors to the same key as 50");
  assert.equal(m1, await miners("bogus"), "unknown window collapses to 'all' → same cached object");

  await addBlock(4); // tip advances → the cache must bust
  const r3 = await supply();
  assert.notEqual(r3, r1, "after a new block supply() recomputes a fresh object");
  assert.equal((r3 as { height: number }).height, 4, "fresh result reflects the new tip height");
  assert.ok(
    BigInt((r3 as { emitted_supply: string }).emitted_supply) > BigInt((r1 as { emitted_supply: string }).emitted_supply),
    "emitted supply grew with the new block (recomputed, not stale)",
  );
});
