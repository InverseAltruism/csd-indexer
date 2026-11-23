// A backend that answers /tip and no block below some height ends both reorg walks at the first height it cannot
// answer: that is no evidence, so the pass changes nothing and the next one asks again. The walks used to skip such a
// height and go on down to the scan floor, one node read per indexed height in one pass (2,000 reads for 2,000 blocks,
// about 148,000 at the live height), with no backend failover while it lasted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { tmpDb } from "./_tmpdb.js";

const id = (tag: string) => "0x" + createHash("sha256").update(tag).digest("hex");
type B = { hash: string; height: number; chainwork: string; header: object; txs: object[] };
function chain(tag: string, n: number, from: B[] = [], work = 1000): B[] {
  const out = [...from];
  for (let h = out.length, prev = out[out.length - 1]?.hash ?? "0x" + "00".repeat(32); h < n; h++) {
    const b = { hash: id(`${tag}-${h}`), height: h, chainwork: String((h + 1) * work),
      header: { bits: 0x1e00ffff, merkle: id(`mk-${tag}-${h}`), nonce: 0, prev, time: 1_700_000_000 + h * 120, version: 1 },
      txs: [{ txid: id(`cb-${tag}-${h}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 50 }] }] };
    out.push(b); prev = b.hash;
  }
  return out;
}
let CHAIN: B[] = [];
let ANSWERS = (_h: number) => true;   // which heights the node answers
let reads = 0;
const server: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
  const t = CHAIN[CHAIN.length - 1]!;
  if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, tip: t.hash, height: t.height, chainwork: t.chainwork }));
  reads++;
  const m = /^\/block\/height\/(\d+)$/.exec(req.url ?? ""), h = m ? Number(m[1]) : -1, b = CHAIN[h];
  if (!b || !ANSWERS(h)) { res.statusCode = 503; return res.end("{}"); }
  res.end(JSON.stringify({ ok: true, ...b }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;
process.env.CSD_INDEX_DB = tmpDb("abswalk");
process.env.CSD_INDEX_PG_SCHEMA = "t_abswalk";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "5";
process.env.CSD_CONFIRMATIONS_FINAL = "6";
const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const hashAt = async (h: number) => (await store().get<{ hash: string }>("SELECT hash FROM blocks WHERE height=?", h))?.hash ?? null;

const A = chain("A", 300);
async function indexA(): Promise<void> {
  await resetStoreForTests();
  CHAIN = A; ANSWERS = () => true;
  await syncOnce();
  assert.equal(await indexedHeight(), 299);
}

test("a node that answers /tip and no block costs a bounded number of reads and changes nothing", async () => {
  await indexA();
  // its tip diverges at 299 (more work), and it answers no block at all
  CHAIN = chain("X", 300, A.slice(0, 299), 2000); ANSWERS = () => false; reads = 0;
  const r = await syncOnce();
  assert.ok(reads <= 10, `reads in one pass: ${reads}`);
  assert.equal(r.reorgs, 0);
  assert.equal(await indexedHeight(), 299);
  assert.equal(await hashAt(299), A[299]!.hash);
});

test("a node that answers only its next block, which does not link, costs a bounded number of reads", async () => {
  await indexA();
  const other = chain("Y", 301, A.slice(0, 280), 2000);   // diverges at 280, one block taller
  CHAIN = other; ANSWERS = (h) => h === 300; reads = 0;
  const r = await syncOnce();
  assert.ok(reads <= 12, `reads in one pass: ${reads}`);
  assert.equal(r.reorgs, 0);
  assert.equal(await hashAt(299), A[299]!.hash, "nothing unwound on absence");
});

test("a confirmed tip mismatch with a deep gap unwinds nothing that pass; the reorg follows when the node answers", async () => {
  await indexA();
  const fork = chain("Z", 300, A.slice(0, 285), 2000);    // a real reorg from 285, the same height, more work
  CHAIN = fork; ANSWERS = (h) => h >= 290;                // answers its tip window, not 285..289
  const r1 = await syncOnce();
  assert.equal(r1.reorgs, 0, "the walk met a height the node did not answer: no evidence, no unwind");
  assert.equal(await hashAt(286), A[286]!.hash);
  ANSWERS = () => true;
  const r2 = await syncOnce();
  assert.equal(r2.reorgs, 1);
  assert.equal(await hashAt(284), A[284]!.hash, "the common ancestor is kept");
  for (const h of [285, 299]) assert.equal(await hashAt(h), fork[h]!.hash, `height ${h} follows the heavier chain`);
});

test.after(async () => { server.close(); await closeDb(); });
