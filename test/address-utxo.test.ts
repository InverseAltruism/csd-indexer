// An address's unspent outputs: /address/:a carries their count, so a page that shows the count reads one row, and
// /address/:a/utxo answers at most UTXO_PAGE of them per call with a (height, txid, vout) keyset, so a caller walks a
// large set page by page instead of the indexer serialising the whole set on every call.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("utxo");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_utxo";

const { buildApp } = await import("../src/server.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { UTXO_PAGE, amt } = await import("../src/queries.js");
await resetStoreForTests();

const HEAVY = "0x" + "ab".repeat(20);
const OTHER = "0x" + "cd".repeat(20);
const EMPTY = "0x" + "ef".repeat(20);
const SPENDER = "0x" + "5e".repeat(20); // one spent output past 2^53 and one unspent
const txid = (i: number) => "0x" + i.toString(16).padStart(64, "0");
const N = 2 * 1000 + 503;   // unspent outputs of HEAVY: two full pages and a short one
const SPENT = 40;           // HEAVY's spent outputs, which neither the count nor the pages include

// Up to 3 outputs per tx and up to 7 txs per height, so pages break inside a height and inside a txid.
await store().tx(async (d) => {
  const ins = "INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES(?,?,?,?,?,?,?)";
  for (let i = 0; i < N + SPENT; i++) {
    const t = Math.floor(i / 3), vout = i % 3, h = 100 + Math.floor(t / 7);
    const spent = i % 63 === 5 && i / 63 < SPENT;
    await d.run(ins, txid(9_000_000 - t), vout, HEAVY, i === 7 ? 2n ** 60n : 1000 + i, h, spent ? txid(1) : null, spent ? h + 1 : null);
  }
  for (let i = 0; i < 5; i++) await d.run(ins, txid(5_000_000 + i), 0, OTHER, 77, 100, null, null);
});
const spentCount = Number((await store().get<{ n: number }>("SELECT COUNT(*) n FROM outputs WHERE addr=? AND spent_txid IS NOT NULL", HEAVY))!.n);
const UNSPENT = N + SPENT - spentCount;

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };
test.after(async () => { srv.close(); await closeDb(); });

type Utxo = { txid: string; vout: number; value: number | string; status: { confirmed: boolean; block_height: number } };
const cursorOf = (u: Utxo) => `${u.status.block_height}:${u.txid}:${u.vout}`;

test("/address/:a carries chain_stats.utxo_count: the unspent outputs only", async () => {
  assert.equal(spentCount, SPENT, "fixture: the spent outputs are in place");
  const r = await get(`/address/${HEAVY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.chain_stats.utxo_count, UNSPENT);
  assert.equal((await get(`/address/${OTHER.toUpperCase().replace("0X", "0x")}`)).body.chain_stats.utxo_count, 5);
  assert.equal((await get(`/address/${EMPTY}`)).body.chain_stats.utxo_count, 0);
});

// chain_stats' funded, spent and unspent count come from one pass over the address's outputs; each equals the query
// that computes it alone (a value past 2^53 among HEAVY's outputs keeps funded a decimal string).
test("/address/:a chain_stats: funded, spent, balance and utxo_count equal their separate queries", async () => {
  await store().run("INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES(?,?,?,?,?,?,?)",
    txid(6_000_000), 0, SPENDER, 2n ** 60n, 300, txid(2), 301);
  await store().run("INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES(?,?,?,?,?,?,?)",
    txid(6_000_001), 0, SPENDER, 9, 300, null, null);
  for (const a of [HEAVY, OTHER, EMPTY, SPENDER]) {
    const one = async (sql: string) => (await store().get<{ v: number | bigint }>(sql, a))!.v;
    const funded = await one("SELECT COALESCE(SUM(value),0) v FROM outputs WHERE addr=?");
    const spent = await one("SELECT COALESCE(SUM(value),0) v FROM outputs WHERE addr=? AND spent_txid IS NOT NULL");
    const unspent = await one("SELECT COUNT(*) v FROM outputs WHERE addr=? AND spent_txid IS NULL");
    const r = await get(`/address/${a}`);
    assert.deepEqual(r.body.chain_stats, { funded: amt(funded), spent: amt(spent), balance: amt(BigInt(funded) - BigInt(spent)),
      tx_count: 0, utxo_count: Number(unspent) }, a);
  }
  assert.equal((await get(`/address/${SPENDER}`)).body.chain_stats.spent, String(2n ** 60n), "a spent sum past 2^53 stays exact");
});

test("/address/:a/utxo answers one page of UTXO_PAGE; after= walks the whole set once, in (height, txid, vout) order", async () => {
  assert.equal(UTXO_PAGE, 1000);
  const want = (await store().all<{ txid: string; vout: number; height: number }>(
    "SELECT txid, vout, height FROM outputs WHERE addr=? AND spent_txid IS NULL", HEAVY))
    .map((o) => ({ txid: o.txid, vout: Number(o.vout), height: Number(o.height) }))
    .sort((a, b) => a.height - b.height || (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0) || a.vout - b.vout);
  const seen: Utxo[] = [];
  const sizes: number[] = [];
  let next = "";
  for (let guard = 0; guard < 10; guard++) {
    const r = await get(`/address/${HEAVY}/utxo${next}`);
    assert.equal(r.status, 200);
    sizes.push(r.body.length);
    seen.push(...r.body);
    if (r.body.length < UTXO_PAGE) break;
    next = `?after=${cursorOf(r.body[r.body.length - 1])}`;
  }
  assert.deepEqual(sizes, [1000, 1000, UNSPENT - 2000], "two full pages and the rest");
  assert.deepEqual(seen.map((u) => ({ txid: u.txid, vout: u.vout, height: u.status.block_height })), want, "every unspent output once, in order");
  const big = seen.find((u) => u.txid === txid(9_000_000 - 2) && u.vout === 1)!;
  assert.equal(big.value, String(2n ** 60n), "a value past 2^53 stays exact");
  assert.deepEqual(Object.keys(seen[0]!), ["txid", "vout", "value", "status"], "the Esplora row shape is unchanged");
});

test("/address/:a/utxo: a cursor past the last row answers an empty page; a small set is one page", async () => {
  const r = await get(`/address/${OTHER}/utxo`);
  assert.equal(r.body.length, 5);
  assert.deepEqual((await get(`/address/${OTHER}/utxo?after=${cursorOf(r.body[4])}`)).body, []);
  assert.deepEqual((await get(`/address/${EMPTY}/utxo`)).body, []);
});

test("/address/:a/utxo: a malformed after= is 400; the honest cursor is accepted", async () => {
  for (const bad of ["x", "100", "100:0x12:0", `-1:${txid(1)}:0`, `1.5:${txid(1)}:0`, `100:${txid(1)}:-1`, `100:${txid(1)}:2147483648`,
    `99999999999999999999:${txid(1)}:0`, `100:${txid(1)}:0:1`]) {
    const r = await get(`/address/${HEAVY}/utxo?after=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /after=<height>:<txid>:<vout>/, bad);
  }
  assert.equal((await get(`/address/${HEAVY}/utxo?after=${encodeURIComponent(`100:${txid(1).toUpperCase().replace("0X", "0x")}:0`)}`)).status, 200,
    "a txid in upper case is the same cursor");
  assert.equal((await get(`/address/${HEAVY}/utxo?after=0:${txid(0)}:2147483647`)).status, 200, "the largest vout the column holds");
});
