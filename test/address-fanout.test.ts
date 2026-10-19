// M-116: a list read must not hold one pool connection per row. /address/:a/txs used to run two queries per
// txid of the page at once (51 for a 25-row page), so a few concurrent reads of a busy address filled the
// Postgres pool's wait queue and 500'd every other reader, the resolver's proposal feed included.
// The rows served are unchanged: each list element equals the per-txid row plus its outputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";

const DB = `/tmp/csd-idx-fanout-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_fanout";
process.env.CSD_INDEX_PG_POOL = "2";   // a small pool: its wait-queue bound is then max(64, 2*8) = 64

const { buildApp } = await import("../src/server.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const q = await import("../src/queries.js");

const PG = store().backend === "postgres";
const HEAVY = "0x" + "ab".repeat(20);
const OTHER = "0x" + "cd".repeat(20);
const txid = (i: number) => "0x" + i.toString(16).padStart(64, "0");
const BIG = 2n ** 60n;                 // past 2^53: serialized as a decimal string
const NTX = 60, BLOCK_H = 5000, BLOCK_TXS = 30;

await resetStoreForTests();
await store().tx(async (d) => {
  for (let i = 0; i < NTX; i++) {
    const h = 1000 + Math.floor(i / 3);   // three txs per height, so the keyset cursor crosses same-height rows
    await d.run("INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES(?,?,?,?,?,?,?,?,?,?)", txid(i), h, i % 3, "Transfer", HEAVY, 1000 + i, 1700000000 + h, 1, 2, 0);
    await d.run("INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES(?,?,?,?,?,?,?)", txid(i), 1, OTHER, 7000 + i, h, null, null);
    await d.run("INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES(?,?,?,?,?,?,?)", txid(i), 0, HEAVY, i === 59 ? BIG : 5000 + i, h, null, null);
    await d.run("INSERT INTO address_history(addr,txid,height,pos,direction,delta) VALUES(?,?,?,?,?,?)", HEAVY, txid(i), h, i % 3, "in", 5000);
  }
  await d.run("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork) VALUES(?,?,?,?,?,?,?,?,?,?)", BLOCK_H, txid(9_000_000), null, null, 1700000000, 0x1e00ffff, 0, 1, BLOCK_TXS, "1");
  for (let p = 0; p < BLOCK_TXS; p++) {   // inserted out of block order: the endpoint must restore it
    const pos = (p * 7) % BLOCK_TXS;
    await d.run("INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES(?,?,?,?,?,?,?,?,?,?)", txid(8_000_000 + pos), BLOCK_H, pos, pos === 0 ? "Coinbase" : "Transfer", OTHER, pos, 1700000000, 1, 1, pos === 0 ? 1 : 0);
  }
  for (let i = 0; i < 40; i++) await d.run("INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time) VALUES(?,?,?,?,?,?,?,?,?)", txid(7_000_000 + i), "cairnx:v1", txid(6_000_000 + i), "u", 99, HEAVY, 1, 1000 + i, 1700000000);
});

// Count store reads and the most that are in flight at once.
let calls = 0, inflight = 0, maxInflight = 0;
const s = store() as unknown as Record<"get" | "all", (...a: unknown[]) => Promise<unknown>>;
for (const m of ["get", "all"] as const) {
  const orig = s[m].bind(store());
  s[m] = async (...a: unknown[]) => {
    calls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
    try { return await orig(...a); } finally { inflight--; }
  };
}
const measure = async <T>(fn: () => Promise<T>): Promise<{ out: T; calls: number; maxInflight: number }> => {
  calls = 0; maxInflight = 0;
  const out = await fn();
  return { out, calls, maxInflight };
};

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };

// The per-txid shape the list endpoints served before: q.tx's row plus its outputs in vout order through amt().
async function expectedTx(id: string) {
  const t = await q.tx(id);
  const outs = await store().all<any>("SELECT * FROM outputs WHERE txid=? ORDER BY vout", id);
  return { ...t, outputs: outs.map((o) => ({ ...o, value: q.amt(o.value) })) };
}

test("/address/:a/txs: a 25-row page is read in a constant number of queries, one at a time", async () => {
  const { out, calls: n, maxInflight: m } = await measure(() => get(`/address/${HEAVY}/txs`));
  assert.equal(out.status, 200);
  assert.equal(out.body.length, 25);
  assert.ok(n <= 3, `queries per request: ${n}`);
  assert.equal(m, 1, `store reads in flight at once: ${m}`);
});

test("HAPPY PATH: the page holds the same rows, order and outputs as the per-txid reads", async () => {
  const ids = await q.addressTxids(HEAVY, null);
  const { body } = await get(`/address/${HEAVY}/txs`);
  assert.deepEqual(body.map((t: any) => t.txid), ids.map((r) => r.txid), "newest first, txid ascending within a height");
  for (let i = 0; i < ids.length; i++) assert.deepEqual(body[i], JSON.parse(JSON.stringify(await expectedTx(ids[i]!.txid))));
  const big = body.find((t: any) => t.txid === txid(59));
  assert.equal(big.outputs[0].value, BIG.toString(), "a value past 2^53 is a decimal string");
  assert.deepEqual(big.outputs.map((o: any) => o.vout), [0, 1], "outputs in vout order");
});

test("HAPPY PATH: the keyset page /txs/chain/:last continues the list without loss, in a constant number of queries", async () => {
  const first = (await get(`/address/${HEAVY}/txs`)).body as any[];
  const last = first[first.length - 1].txid;
  const { out, calls: n, maxInflight: m } = await measure(() => get(`/address/${HEAVY}/txs/chain/${last}`));
  const ids = await q.addressTxids(HEAVY, { height: first[first.length - 1].height, txid: last });
  assert.deepEqual(out.body.map((t: any) => t.txid), ids.map((r) => r.txid));
  for (let i = 0; i < ids.length; i++) assert.deepEqual(out.body[i], JSON.parse(JSON.stringify(await expectedTx(ids[i]!.txid))));
  assert.ok(n <= 4, `queries per request: ${n}`);
  assert.equal(m, 1);
});

test("/block/:hash/txs: every tx row of the block in block order, in a constant number of queries", async () => {
  const { out, calls: n, maxInflight: m } = await measure(() => get(`/block/${txid(9_000_000)}/txs`));
  assert.equal(out.status, 200);
  const ids = await q.blockTxids(BLOCK_H);
  assert.equal(out.body.length, BLOCK_TXS);
  assert.deepEqual(out.body.map((t: any) => t.pos), [...Array(BLOCK_TXS).keys()]);
  for (let i = 0; i < ids.length; i++) assert.deepEqual(out.body[i], JSON.parse(JSON.stringify(await q.tx(ids[i]!))));
  assert.ok(n <= 2, `queries per request: ${n}`);
  assert.equal(m, 1);
});

test("HAPPY PATH: /tx/:id still answers the row with its outputs, and 404 for an unknown txid", async () => {
  assert.deepEqual((await get(`/tx/${txid(59)}`)).body, JSON.parse(JSON.stringify(await expectedTx(txid(59)))));
  assert.equal((await get(`/tx/${txid(424242)}`)).status, 404);
});

test("Postgres: concurrent heavy-address reads and the resolver feed all answer 200 on a 2-connection pool",
  { skip: !PG && "pool saturation exists only on the Postgres backend (sqlite has no pool); CI's postgres job runs it" }, async () => {
    const addr = [...Array(16)].map(() => fetch(`${base}/address/${HEAVY}/txs`).then((r) => r.status));
    const feed = [...Array(4)].map(() => fetch(`${base}/domain/cairnx:v1/proposals?from=0&limit=10000`).then((r) => r.status));
    const [a, f] = await Promise.all([Promise.all(addr), Promise.all(feed)]);
    assert.deepEqual(a, Array(16).fill(200), "every address read answered");
    assert.deepEqual(f, Array(4).fill(200), "every feed read answered");
  });

test.after(async () => { srv.close(); await closeDb(); });
