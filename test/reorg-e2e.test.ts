// End-to-end reorg test for syncOnce() against a MOCK node (the real rpc.ts fetches it), driving
// the actual fork-detection + unwind/replay paths that the unit test (which calls writeBlock/
// unwindAbove directly) never reaches. Covers: forward (taller) reorg, the EQUAL-height tip-swap
// and the SHORTER-higher-work reorg (HIGH-1 — these are missed by the forward scan), and the
// scanFrom floor. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-reorg-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }

// ── mock node serving a mutable chain: chain[h] = { hash, header, txs } ──
type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
function blk(height: number, tag: string, prev: string, props: { propTxid?: string; domain?: string } = {}): B {
  const txs: any[] = [{ txid: h32(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 5000000000 }] }];
  if (props.propTxid) txs.push({ txid: props.propTxid, inputs: [{ prev_txid: h32("cb-g"), vout: 0 }], outputs: [{ script_pubkey: "0x" + "c3".repeat(20), value: 1 }], app: { type: "Propose", domain: props.domain ?? "csd:test", payload_hash: h32("ph"), uri: "u", expires_epoch: 9999 } });
  return { hash: h32(`blk-${tag}`), height, chainwork: String(height * 1000), header: { bits: 0x1e00ffff, merkle: h32(`mk-${tag}`), nonce: 0, prev, time: 1700000000 + height, version: 1 }, txs };
}
function buildChain(tags: string[]): B[] {
  const out: B[] = []; let prev = h32("genesis");
  tags.forEach((tag, i) => { const b = blk(i, tag, prev, tag.startsWith("P") ? { propTxid: h32(`prop-${tag}`), domain: `dom-${tag}` } : {}); out.push(b); prev = b.hash; });
  return out;
}
let BLOCKS_DOWN = false; // L10 fault injection: /tip answers but every /block/height fails
const server: Server = createServer((req, res) => {
  const u = req.url || "";
  res.setHeader("content-type", "application/json");
  if (u === "/tip") { const t = CHAIN[CHAIN.length - 1]; return res.end(JSON.stringify({ ok: true, tip: t?.hash ?? "", height: t?.height ?? 0, chainwork: t?.chainwork ?? "0" })); }
  const m = u.match(/^\/block\/height\/(\d+)$/);
  if (m) {
    if (BLOCKS_DOWN) { res.statusCode = 500; return res.end("{}"); }
    const b = CHAIN[Number(m[1])]; return b ? res.end(JSON.stringify({ ok: true, ...b })) : (res.statusCode = 404, res.end("{}"));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";

const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { db } = await import("../src/db.js");
const storedHash = (h: number) => (db().prepare("SELECT hash FROM blocks WHERE height=? AND orphaned=0").get(h) as any)?.hash ?? null;
const propCount = (dom: string) => (db().prepare("SELECT COUNT(*) n FROM proposals WHERE domain=?").get(dom) as any).n;
const liveTip = () => (db().prepare("SELECT MAX(height) h FROM blocks WHERE orphaned=0").get() as any).h;

test("forward (taller) reorg: a longer competing chain unwinds + replays", async () => {
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc"]); // heights 0..3, props at 1,2,3
  await syncOnce();
  assert.equal(indexedHeight(), 3);
  assert.equal(storedHash(2), h32("blk-Pb"));
  // reorg: heights 2,3 replaced by a TALLER branch (now 0..4)
  CHAIN = buildChain(["g", "Pa", "Px", "Py", "Pz"]);
  await syncOnce();
  assert.equal(indexedHeight(), 4, "adopted the taller branch tip");
  assert.equal(storedHash(2), h32("blk-Px"), "height 2 now the new branch");
  assert.equal(propCount("dom-Pb"), 0, "orphaned proposal dom-Pb removed");
  assert.equal(propCount("dom-Px"), 1, "new proposal dom-Px present");
});

test("HIGH-1 EQUAL-height tip-swap: same height, different block → must unwind orphan", async () => {
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc"]);
  await syncOnce();
  assert.equal(indexedHeight(), 3);
  assert.equal(propCount("dom-Pc"), 1);
  // node swaps the tip block at the SAME height 3 (Pc → Pq) — forward scan would miss this
  const swapped = buildChain(["g", "Pa", "Pb", "Pq"]);
  CHAIN = swapped;
  await syncOnce();
  assert.equal(liveTip(), 3, "tip height unchanged");
  assert.equal(storedHash(3), h32("blk-Pq"), "tip block swapped to the canonical one");
  assert.equal(propCount("dom-Pc"), 0, "the orphaned tip proposal is gone (no ghost proposal)");
  assert.equal(propCount("dom-Pq"), 1, "the new canonical proposal is indexed");
});

test("HIGH-1 SHORTER-higher-work reorg: node tip BELOW ours → unwind to node tip", async () => {
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd"]); // 0..4
  await syncOnce();
  assert.equal(indexedHeight(), 4);
  // node reorgs to a SHORTER chain (tip now height 2, different block at 2)
  CHAIN = buildChain(["g", "Pa", "Pz"]); // 0..2
  await syncOnce();
  assert.equal(liveTip(), 2, "indexer tip regressed to the node's shorter tip (no inflated tip)");
  assert.equal(storedHash(2), h32("blk-Pz"));
  assert.equal(propCount("dom-Pc"), 0, "orphaned height-3 proposal gone");
  assert.equal(propCount("dom-Pd"), 0, "orphaned height-4 proposal gone");
  // balances: NO outputs from the orphaned heights 3,4 may linger (no double-counted balance)
  const orphanOuts = (db().prepare("SELECT COUNT(*) n FROM outputs WHERE txid IN (?,?)").get(h32("cb-Pc"), h32("cb-Pd")) as any).n;
  assert.equal(orphanOuts, 0, "orphaned coinbase outputs (heights 3,4) deleted — no ghost UTXOs");
  // every remaining unspent output belongs to a canonical (non-orphaned) block
  const danglingUtxos = (db().prepare("SELECT COUNT(*) n FROM outputs o WHERE o.spent_txid IS NULL AND o.height > 2").get() as any).n;
  assert.equal(danglingUtxos, 0, "no unspent outputs above the new tip height");
});

// ── D-I1 regression: a reorg DEEPER than finalDepth at/above the tip must NOT wedge the loop ──
// (Old code threw in findReorgAncestor / returned 0 in reconcileTipWindow → syncOnce wedged forever.)
test("D-I1 DEEP TALLER reorg (> finalDepth) at the tip: converges, does not wedge", async () => {
  // 0..11 (12 blocks); divergence will be at height 3 → depth 9, well beyond finalDepth=6
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd", "Pe", "Pf", "Pg", "Ph", "Pi", "Pj", "Pk"]);
  await syncOnce();
  assert.equal(indexedHeight(), 11);
  // node reorgs from height 3 upward to a TALLER branch (now 0..12). node tip (12) ≥ ours (11),
  // and the fork point (h3) is deeper than finalDepth — the exact case the old code wedged on.
  CHAIN = buildChain(["g", "Pa", "Pb", "Pr", "Ps", "Pt", "Pu", "Pv", "Pw", "Px", "Py", "Pz", "P1"]);
  await syncOnce();
  assert.equal(indexedHeight(), 12, "adopted the deeper taller branch (no wedge, no throw)");
  assert.equal(storedHash(2), h32("blk-Pb"), "common ancestor at height 2 preserved");
  assert.equal(storedHash(3), h32("blk-Pr"), "height 3 unwound + replayed onto the new branch");
  assert.equal(propCount("dom-Pe"), 0, "orphaned deep proposal (old height 4) removed");
  assert.equal(propCount("dom-Ps"), 1, "new branch proposal (height 4) indexed");
});

test("D-I1 DEEP EQUAL-height reorg (> finalDepth, node tip == ours): converges, does not wedge", async () => {
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd", "Pe", "Pf", "Pg", "Ph", "Pi", "Pj", "Pk"]); // 0..11
  await syncOnce();
  assert.equal(indexedHeight(), 11);
  // same-length branch diverging at height 3 (tip stays 11) — forward scan can't see it AND the old
  // reconcile returned 0 for node-tip≥ours, so the loop never made progress (stuck on the orphan).
  CHAIN = buildChain(["g", "Pa", "Pb", "Pm", "Pn", "Po", "Pp", "Pq", "Pr2", "Ps2", "Pt2", "Pu2"]); // 0..11
  await syncOnce();
  assert.equal(liveTip(), 11, "tip height unchanged");
  assert.equal(storedHash(11), h32("blk-Pu2"), "tip block swapped to the canonical deep branch");
  assert.equal(propCount("dom-Pf"), 0, "orphaned deep proposal (old height 5) gone — no ghost");
  assert.equal(propCount("dom-Po"), 1, "new branch proposal (height 5) indexed");
});

// ── L10 regression: an ALL-NULL window (node serves /tip but every /block/height fails) must be
// treated as "node unhealthy → abort reconcile, retry next poll", NOT "diverged below the floor"
// (the old code unwound the ENTIRE index in that case). Only a CONFIRMED hash mismatch at a height
// the node actually returned may unwind.
test("L10 all-null window: /tip up but every /block/height failing does NOT wipe the index", async () => {
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc"]); // fresh canonical 0..3
  BLOCKS_DOWN = false;
  await syncOnce();
  assert.equal(indexedHeight(), 3);
  const rowsBefore = (db().prepare("SELECT COUNT(*) n FROM blocks WHERE orphaned=0").get() as any).n;
  // node degrades: /tip still answers, every /block/height now 500s
  BLOCKS_DOWN = true;
  const r = await syncOnce();
  assert.equal(r.reorgs, 0, "no reorg signalled on an all-null window");
  assert.equal(indexedHeight(), 3, "indexed height untouched (reconcile aborted, no unwind)");
  const rowsAfter = (db().prepare("SELECT COUNT(*) n FROM blocks WHERE orphaned=0").get() as any).n;
  assert.equal(rowsAfter, rowsBefore, "no rows deleted — index intact through the blip");
  // node recovers → next poll proceeds normally with the index still in place
  BLOCKS_DOWN = false;
  await syncOnce();
  assert.equal(indexedHeight(), 3);
  assert.equal(storedHash(3), h32("blk-Pc"), "canonical tip block still present after recovery");
});

test.after(() => server.close());
