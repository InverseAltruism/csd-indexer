// I2 (O-2 / P74-35): an ABSENCE in a reorg walk must never WIDEN an unwind.
//
// Both walk loops SKIP a height the node did not answer, and `mismatched` is a bare latch that carries no
// depth. So one confirmed hash mismatch at the tip, plus a transient null deeper in the same walk, plus a
// match below it, made the unwind run down to that deeper match and DELETE heights the node never
// contradicted, un-spending their outputs back into live UTXOs (the ghost-UTXO class). The fix tracks the
// LOWEST height the node actually contradicted and clamps the ancestor to lowestMismatch-1, in
// reconcileTipWindow AND in findReorgAncestor, which has the identical absence-skipping walk.
//
// Two scenarios, one per walk. Both are exit-code gated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("absclamp");

type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
let WITHHELD = new Set<number>();   // heights the node refuses to answer (transient absence, not divergence)
let WORK_EPOCH = 0;
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
function blk(height: number, tag: string, prev: string): B {
  return {
    hash: h32(`blk-${tag}`), height, chainwork: String(height * 1000 + WORK_EPOCH * 1_000_000_000),
    header: { bits: 0x1e00ffff, merkle: h32(`mk-${tag}`), nonce: 0, prev, time: 1700000000 + height, version: 1 },
    txs: [
      { txid: h32(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 5000000000 }] },
      { txid: h32(`prop-${tag}`), inputs: [{ prev_txid: h32("cb-g"), vout: 0 }], outputs: [{ script_pubkey: "0x" + "c3".repeat(20), value: 1 }],
        app: { type: "Propose", domain: `dom-${tag}`, payload_hash: h32("ph"), uri: "u", expires_epoch: 9999 } },
    ],
  };
}
function buildChain(tags: string[]): B[] {
  WORK_EPOCH++;
  const out: B[] = []; let prev = h32("genesis");
  tags.forEach((tag, i) => { const b = blk(i, tag, prev); out.push(b); prev = b.hash; });
  return out;
}
const server: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
  const u = req.url || "";
  if (u === "/tip") { const t = CHAIN[CHAIN.length - 1]; return res.end(JSON.stringify({ ok: true, tip: t?.hash ?? "", height: t?.height ?? 0, chainwork: t?.chainwork ?? "0" })); }
  const m = u.match(/^\/block\/height\/(\d+)$/);
  if (m) {
    const h = Number(m[1]);
    if (WITHHELD.has(h)) { res.statusCode = 500; return res.end("{}"); }
    const b = CHAIN[h]; return b ? res.end(JSON.stringify({ ok: true, ...b })) : (res.statusCode = 404, res.end("{}"));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_absclamp";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";

const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const storedHash = async (h: number) => ((await store().get("SELECT hash FROM blocks WHERE height=? AND orphaned=0", h)) as any)?.hash ?? null;
const propCount = async (dom: string) => Number(((await store().get("SELECT COUNT(*) n FROM proposals WHERE domain=?", dom)) as any).n);
const TEN = ["g", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];   // heights 0..10

// ── I2a: reconcileTipWindow. Real tip swap at 10 only; the node cannot answer height 9. ──
test("I2a reconcile: a real tip-swap plus a transient absence below it unwinds ONLY the contradicted height", async () => {
  await resetStoreForTests();
  WITHHELD = new Set();
  CHAIN = buildChain(TEN);
  await syncOnce();
  assert.equal(await indexedHeight(), 10);
  assert.equal(await propCount("dom-P9"), 1);

  CHAIN = buildChain([...TEN.slice(0, 10), "P10b"]);   // heights 0..9 identical, height 10 swapped
  WITHHELD = new Set([9]);                             // node blips on height 9 during the same walk
  const r = await syncOnce();

  assert.equal(r.reorgs, 1, "reorgs=1");
  assert.equal(r.reorgDepth, 1, "depth=1: only the height the node actually contradicted");
  assert.equal(await indexedHeight(), 10, "height 10 unwound and immediately replayed");
  assert.equal(await storedHash(10), h32("blk-P10b"), "the canonical swapped tip is indexed");
  assert.equal(await storedHash(9), h32("blk-P9"), "height 9 survived: the node never contradicted it");
  assert.equal(await propCount("dom-P9"), 1, "height 9's proposal survived (no ghost-UTXO / lost-row class)");
});

// ── I2b: findReorgAncestor. Node withholds 9 and 10 but serves a taller 11 whose prev contradicts our 10. ──
test("I2b findReorgAncestor: an absence in the walk-back does not widen the unwind either", async () => {
  await resetStoreForTests();
  WITHHELD = new Set();
  CHAIN = buildChain(TEN);
  await syncOnce();
  assert.equal(await indexedHeight(), 10);

  // canonical branch: 0..9 identical, 10 and 11 are new. The node can answer 11 and 8, but not 9 or 10.
  CHAIN = buildChain([...TEN.slice(0, 10), "P10c", "P11c"]);
  WITHHELD = new Set([9, 10]);
  const r = await syncOnce();

  assert.equal(r.reorgs, 1, "the forward scan did detect the divergence at our tip");
  assert.equal(r.reorgDepth, 1, "depth=1: clamped to the one height the new block's prev contradicted");
  assert.equal(await storedHash(9), h32("blk-P9"), "height 9 survived the walk-back absence");
  assert.equal(await propCount("dom-P9"), 1, "height 9's proposal survived");
  assert.equal(await indexedHeight(), 9, "tip is the last surviving canonical height; the withheld 10 replays next poll");

  // the node recovers: the genuine reorg completes normally, nothing was lost in between
  WITHHELD = new Set();
  await syncOnce();
  assert.equal(await indexedHeight(), 11);
  assert.equal(await storedHash(10), h32("blk-P10c"));
  assert.equal(await storedHash(11), h32("blk-P11c"));
});

// ── PAIRED HAPPY-PATH: a genuine deep reorg with the node answering everything is UNCHANGED ──
test("HAPPY PATH: a genuine deep contiguous reorg still unwinds to the TRUE ancestor", async () => {
  await resetStoreForTests();
  WITHHELD = new Set();
  CHAIN = buildChain(TEN);
  await syncOnce();
  assert.equal(await indexedHeight(), 10);

  // diverges at height 4 (deeper than finalDepth=6 from the tip), node answers every height
  CHAIN = buildChain(["g", "P1", "P2", "P3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10", "Q11"]);
  const r = await syncOnce();
  assert.equal(r.reorgs, 1);
  assert.equal(r.reorgDepth, 7, "unwound to the TRUE ancestor (height 3), depth 10-3 = 7");
  assert.equal(await storedHash(3), h32("blk-P3"), "true common ancestor preserved");
  assert.equal(await storedHash(4), h32("blk-Q4"), "the canonical branch replayed from the fork point");
  assert.equal(await propCount("dom-P9"), 0, "genuinely orphaned rows ARE removed (the clamp did not over-protect)");
  assert.equal(await indexedHeight(), 11);
});

test.after(async () => { server.close(); await closeDb(); });
