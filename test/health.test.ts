// /health surface test (Phase B): the endpoint was the one unmemoized full-scan route (counts()
// = four COUNT(*) per hit while being the failover-LB poll target) and carried no version tell.
// Pins: (1) field shape incl. the additive version/backend fields, (2) counts() behind memoByTip
// runs once per tip and re-runs on a new block, (3) freshness fields stay live (not memoized).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB = `/tmp/csd-idx-health-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_health";

const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { memoByTip } = await import("../src/analytics.js");
const { counts } = await import("../src/queries.js");
const { buildApp } = await import("../src/server.js");
await resetStoreForTests();

const A = "0x" + "aa".repeat(20);
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const SQL_BLOCK = "INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES (?,?,?,?,?,?,?,?,?,?,0)";
const SQL_TX = "INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES (?,?,?,?,?,?,?,?,?,?)";

async function addBlock(h: number): Promise<void> {
  const s = store();
  await s.run(SQL_BLOCK, h, id(1000 + h), id(999 + h), id(2000 + h), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, 1, String(h * 1000));
  await s.run(SQL_TX, id(10_000 + h), h, 0, "Coinbase", A, 0, 1_700_000_000 + h * 120, 1, 1, 1);
}

await addBlock(0);
await addBlock(1);

const app = buildApp();
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const port = (srv.address() as { port: number }).port;
const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json() as Promise<Record<string, unknown>>;

test.after(async () => { srv.close(); await closeDb(); });

test("health: field shape incl. additive version/backend", async () => {
  const j = await health();
  assert.equal(j.ok, true);
  assert.match(String(j.version), /^\d+\.\d+\.\d+/);        // package version, not "unknown"
  assert.ok(j.backend === "sqlite" || j.backend === "postgres");
  assert.equal(j.tip_height, 1);
  assert.equal(j.blocks, 2);                                 // counts() spread is preserved
  assert.equal(j.txs, 2);
  assert.equal(typeof j.seconds_since_tip, "number");
  assert.equal(typeof j.stale, "boolean");
});

test("health counts: memoByTip runs the scans once per tip, re-runs on a new block", async () => {
  let calls = 0;
  const counted = memoByTip(async () => { calls++; return counts(); });
  const a = await counted();
  const b = await counted();
  assert.equal(calls, 1, "second same-tip call must hit the memo");
  assert.equal(a, b, "reference identity = cache hit");
  await addBlock(2);
  const c = (await counted()) as Awaited<ReturnType<typeof counts>>;
  assert.equal(calls, 2, "tip change must bust the memo");
  assert.equal(c.blocks, 3);
});

test("health freshness: seconds_since_tip tracks the NEW tip immediately (not memoized)", async () => {
  const before = await health();
  await addBlock(3); // tip time advances 120s per block → age drops by ~120s vs the old tip
  const after = await health();
  assert.equal(after.tip_height, 3);
  assert.equal(after.blocks, 4, "served counts refresh with the tip");
  assert.ok(Number(after.seconds_since_tip) <= Number(before.seconds_since_tip) - 100,
    "freshness must be computed from the live tip row, not a cached one");
});
