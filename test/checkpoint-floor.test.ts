// Checkpoint-floor backstop: the indexer must REFUSE to unwind below the latest shipped SPV checkpoint,
// even for a genuinely heavier chain (that crosses the chainwork guard), because a reorg below a buried
// checkpoint is not something to auto-delete for. Uses a LOW floor (3) via env so tiny test heights
// exercise both branches: unwind to a height BELOW the floor is refused; unwind to a height AT/above it
// is allowed. Set the env BEFORE importing so config.ts picks it up. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-floor-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }

type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
let WORK_EPOCH = 0; // each built chain out-works prior ones (a node only adopts a heavier chain)
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
function blk(height: number, tag: string, prev: string): B {
  return { hash: h32(`blk-${tag}`), height, chainwork: String(height * 1000 + WORK_EPOCH * 1_000_000_000),
    header: { bits: 0x1e00ffff, merkle: h32(`mk-${tag}`), nonce: 0, prev, time: 1700000000 + height, version: 1 },
    txs: [{ txid: h32(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 5000000000 }] }] };
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
  if (m) { const b = CHAIN[Number(m[1])]; return b ? res.end(JSON.stringify({ ok: true, ...b })) : (res.statusCode = 404, res.end("{}")); }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;      // single backend = the mock (no live-node polling)
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_floor";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "3";            // low floor so heights 0..5 exercise both branches

const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
await resetStoreForTests();
const storedHash = async (h: number) => ((await store().get("SELECT hash FROM blocks WHERE height=? AND orphaned=0", h)) as any)?.hash ?? null;
const liveTip = async () => Number(((await store().get("SELECT MAX(height) h FROM blocks WHERE orphaned=0")) as any).h);

test("floor: REFUSES to unwind below the floor even for a heavier chain (deep ancestor)", async () => {
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd", "Pe"]); // 0..5
  await syncOnce();
  assert.equal(await indexedHeight(), 5);
  const rowsBefore = Number(((await store().get("SELECT COUNT(*) n FROM blocks WHERE orphaned=0")) as any).n);
  // heavier reorg (WORK_EPOCH++) diverging at height 2 -> common ancestor 1, which is BELOW the floor (3)
  CHAIN = buildChain(["g", "Pa", "Pz"]); // 0..2
  const r = await syncOnce();
  assert.equal(r.reorgs, 0, "floor refused the unwind (no reorg signalled)");
  assert.equal(await indexedHeight(), 5, "index NOT unwound below the floor");
  assert.equal(await storedHash(5), h32("blk-Pe"), "tip still present");
  const rowsAfter = Number(((await store().get("SELECT COUNT(*) n FROM blocks WHERE orphaned=0")) as any).n);
  assert.equal(rowsAfter, rowsBefore, "no rows deleted");
});

test("floor: ALLOWS an unwind whose ancestor is AT the floor", async () => {
  // fresh index 0..5 (WORK_EPOCH keeps this heavier than the prior test's chains)
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd", "Pe"]); // 0..5
  await syncOnce();
  assert.equal(await liveTip(), 5);
  // heavier reorg diverging at height 4 -> common ancestor 3 == floor -> allowed
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Px"]); // 0..4, block 4 differs
  await syncOnce();
  assert.equal(await liveTip(), 4, "unwound to the new (shorter) heavier tip");
  assert.equal(await storedHash(4), h32("blk-Px"), "height 4 swapped to the new branch");
  assert.equal(await storedHash(3), h32("blk-Pc"), "ancestor at the floor (3) preserved");
});

test.after(async () => { server.close(); await closeDb(); });
