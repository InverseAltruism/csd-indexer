// /address/:a/coinbase and /miners/coinbase through the real server, over a chain indexed by syncOnce from a
// mock node (no network), including a reorg that takes away a block the miner won.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";

type B = { hash: string; height: number; chainwork: string; header: Record<string, unknown>; txs: unknown[] };
let CHAIN: B[] = [];
let EPOCH = 0;
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
const MINER = "0x" + "a1".repeat(20);
const OTHER_MINER = "0x" + "b2".repeat(20);
const PAYEE = "0x" + "c3".repeat(20);
const UNKNOWN = "0x" + "d4".repeat(20);
// tag -> [coinbase outputs]; a "pay" block adds a transfer from the previous coinbase to PAYEE
const SPEC: Record<string, { to: string; v: number }[]> = {
  g: [{ to: OTHER_MINER, v: 1000 }],
  m1: [{ to: MINER, v: 5000 }],
  m2: [{ to: MINER, v: 4000 }, { to: MINER, v: 300 }],
  o1: [{ to: OTHER_MINER, v: 1000 }],
  m3: [{ to: MINER, v: 7000 }],
  o2: [{ to: OTHER_MINER, v: 1000 }],
  o3: [{ to: OTHER_MINER, v: 1000 }],
};
function buildChain(tags: string[]): B[] {
  EPOCH++;
  let prev = h32("genesis");
  return tags.map((tag, height) => {
    const txs: unknown[] = [{ txid: h32(`cb-${tag}`), inputs: [], outputs: SPEC[tag]!.map((o) => ({ script_pubkey: o.to, value: o.v })) }];
    if (tag === "o1") txs.push({ txid: h32("pay"), inputs: [{ prev_txid: h32("cb-m1"), vout: 0 }], outputs: [{ script_pubkey: PAYEE, value: 4900 }] });
    const b = { hash: h32(`blk-${height}-${tag}`), height, chainwork: String(height * 1000 + EPOCH * 1_000_000_000), header: { bits: 0x1e00ffff, merkle: h32(`mk-${tag}`), nonce: 0, prev, time: 1700000000 + height, version: 1 }, txs };
    prev = b.hash;
    return b;
  });
}
const node: Server = createServer((req, res) => {
  const u = req.url ?? "";
  res.setHeader("content-type", "application/json");
  if (u === "/tip") { const t = CHAIN[CHAIN.length - 1]; return res.end(JSON.stringify({ ok: true, tip: t?.hash ?? "", height: t?.height ?? 0, chainwork: t?.chainwork ?? "0" })); }
  const m = u.match(/^\/block\/height\/(\d+)$/);
  const b = m ? CHAIN[Number(m[1])] : undefined;
  if (b) return res.end(JSON.stringify({ ok: true, ...b }));
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => node.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
process.env.CSD_INDEX_DB = tmpDb("cbroutes");
process.env.CSD_INDEX_PG_SCHEMA = "t_coinbase_routes";
process.env.CSD_INDEX_FROM = "0";

const { syncOnce } = await import("../src/indexer.js");
const { buildApp } = await import("../src/server.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
await resetStoreForTests();

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };
test.after(async () => { srv.close(); node.close(); await closeDb(); });

test("an empty index answers 503 on both routes", async () => {
  assert.equal((await get(`/address/${MINER}/coinbase`)).status, 503);
  assert.equal((await get("/miners/coinbase")).status, 503);
});

test("a miner's coinbase outputs are counted and summed, as of the indexed height", async () => {
  CHAIN = buildChain(["g", "m1", "m2", "o1", "m3"]);
  await syncOnce();
  const r = await get(`/address/${MINER.toUpperCase().replace("0X", "0x")}/coinbase`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { address: MINER, outputs: 4, value: 16300, indexed_height: 4 });
  // the miner spent m1's output and received nothing else, so funded equals the coinbase sum in the same encoding
  const stats = await get(`/address/${MINER}`);
  assert.equal(stats.body.chain_stats.funded, r.body.value);
});

test("an address paid only by a transfer, and an unknown address, answer 0 and 0", async () => {
  assert.deepEqual((await get(`/address/${PAYEE}/coinbase`)).body, { address: PAYEE, outputs: 0, value: 0, indexed_height: 4 });
  assert.equal((await get(`/address/${PAYEE}`)).body.chain_stats.funded, 4900, "the payee did receive coins");
  assert.deepEqual((await get(`/address/${UNKNOWN}/coinbase`)).body, { address: UNKNOWN, outputs: 0, value: 0, indexed_height: 4 });
});

test("a malformed address answers 400", async () => {
  for (const a of ["0x1234", "a1".repeat(20), `0x${"zz".repeat(20)}`, `${MINER}00`]) {
    assert.equal((await get(`/address/${a}/coinbase`)).status, 400, a);
  }
});

test("a reorg that removes a block the miner won takes its outputs out of the total", async () => {
  CHAIN = buildChain(["g", "m1", "m2", "o1", "o2", "o3"]);   // height 4 (m3) replaced, chain one taller
  await syncOnce();
  assert.deepEqual((await get(`/address/${MINER}/coinbase`)).body, { address: MINER, outputs: 3, value: 9300, indexed_height: 5 });
  assert.deepEqual((await get(`/address/${OTHER_MINER}/coinbase`)).body, { address: OTHER_MINER, outputs: 4, value: 4000, indexed_height: 5 });
  CHAIN = buildChain(["g", "o1"]);                            // shorter, heavier: m1 and m2 leave too
  await syncOnce();
  assert.deepEqual((await get(`/address/${MINER}/coinbase`)).body, { address: MINER, outputs: 0, value: 0, indexed_height: 1 });
});

test("/miners/coinbase lists the totals by outputs, then address, and caps the limit", async () => {
  CHAIN = buildChain(["g", "m1", "m2", "o1", "m3"]);
  await syncOnce();
  const all = await get("/miners/coinbase");
  assert.equal(all.status, 200);
  assert.deepEqual(all.body, { indexed_height: 4, miners: [
    { address: MINER, outputs: 4, value: 16300 },
    { address: OTHER_MINER, outputs: 2, value: 2000 },
  ] });
  assert.deepEqual((await get("/miners/coinbase?limit=1")).body.miners, [{ address: MINER, outputs: 4, value: 16300 }]);
  for (const bad of ["0", "-1", "1.5", "abc", ""]) assert.equal((await get(`/miners/coinbase?limit=${bad}`)).status, 400, `limit=${bad}`);
  // equal output counts order by address; more rows than the cap answer the cap
  await store().tx(async (d) => {
    for (let i = 0; i < 1005; i++) await d.run("INSERT INTO coinbase_totals(addr,outputs,value) VALUES(?,?,?)", "0x" + i.toString(16).padStart(40, "0"), 1, 1);
  });
  const capped = await get("/miners/coinbase?limit=5000");
  assert.equal(capped.body.miners.length, 1000);
  const ones = capped.body.miners.filter((m: any) => m.outputs === 1).map((m: any) => m.address);
  assert.deepEqual(ones, [...ones].sort(), "ties ordered by address");
  assert.equal(ones[0], "0x" + "0".repeat(40));
  assert.equal((await get("/miners/coinbase")).body.miners.length, 1000, "the default is the cap");
});
