// F7 (chainwork-guard hygiene). indexedChainwork() used to collapse THREE cases to 0n — a missing row, an
// empty chainwork string, AND a BigInt parse THROW on garbage — so an UNREADABLE own-work read produced a
// silent 0n, which disabled the 2026-07-05 regression guard (it HOLDs only when ourWork > 0n). A garbage
// read could therefore let a lower-work node drive an unwind. Now indexedChainwork distinguishes a
// LEGITIMATE stored 0 (-> 0n, guard correctly inert) from an UNREADABLE read (-> null, caller FAILS
// CLOSED). This proves the three unreadable cases distinctly, the two legitimate cases, and that syncOnce
// HOLDs on an unreadable own-work read instead of reconciling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-guard-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }

// mock node (checkpoint-floor pattern): a settable chain, so we can drive an equal/heavier reorg.
type Blk = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: Blk[] = [];
let WORK_EPOCH = 0;
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
function blk(height: number, tag: string, prev: string): Blk {
  return { hash: h32(`blk-${tag}`), height, chainwork: String(height * 1000 + WORK_EPOCH * 1_000_000_000),
    header: { bits: 0x1e00ffff, merkle: h32(`mk-${tag}`), nonce: 0, prev, time: 1700000000 + height, version: 1 },
    txs: [{ txid: h32(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 5000000000 }] }] };
}
function buildChain(tags: string[]): Blk[] {
  WORK_EPOCH++;
  const out: Blk[] = []; let prev = h32("genesis");
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
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;   // single mock backend
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "0";         // don't let the floor mask the guard behavior

const { syncOnce, indexedChainwork, indexedHeight } = await import("../src/indexer.js");
const { store, setMeta, resetStoreForTests, closeDb } = await import("../src/db.js");

// insert a single block at h with a chosen raw chainwork value, and point the tip meta at it.
async function seedTip(h: number, chainworkRaw: string | null) {
  await resetStoreForTests();
  await store().run("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
    h, h32(`tip-${h}`), null, null, 1700000000, 0x1e00ffff, 0, 1, 0, chainworkRaw);
  await setMeta("indexed_height", String(h));
}

test("F7 legit POSITIVE chainwork -> parsed exactly (guard active)", async () => {
  await seedTip(5, "123456789012345678901234567890");
  assert.equal(await indexedChainwork(), 123456789012345678901234567890n);
});

test("F7 legit stored '0' -> 0n (NOT null): a real zero, guard correctly inert", async () => {
  await seedTip(5, "0");
  assert.equal(await indexedChainwork(), 0n);
});

test("F7 UNREADABLE (garbage/parse-throw) -> null (fail closed)", async () => {
  await seedTip(5, "not-a-number");
  assert.equal(await indexedChainwork(), null);
});

test("F7 UNREADABLE (empty string) -> null (fail closed)", async () => {
  await seedTip(5, "");
  assert.equal(await indexedChainwork(), null);
});

test("F7 UNREADABLE (SQL NULL chainwork) -> null (fail closed)", async () => {
  await seedTip(5, null);
  assert.equal(await indexedChainwork(), null);
});

test("F7 fresh index (below scanFrom) -> 0n, not null", async () => {
  await resetStoreForTests();   // empty: indexedHeight() = scanFrom-1 = -1 < scanFrom
  assert.equal(await indexedChainwork(), 0n);
});

test("F7 syncOnce HOLDs on an unreadable own-work read instead of reconciling", async () => {
  // index a valid chain 0..5
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd", "Pe"]);
  await syncOnce();
  assert.equal(await indexedHeight(), 5);
  // CORRUPT the stored chainwork at our tip to garbage (an unreadable own-work read).
  await store().run("UPDATE blocks SET chainwork='xxGARBAGExx' WHERE height=5");
  assert.equal(await indexedChainwork(), null, "own-work now reads as unreadable");
  // Present a HEAVIER reorg diverging at height 3 (common ancestor 2) that would normally reconcile+unwind.
  const heavier = buildChain(["g", "Pa", "Pb", "Pz", "Py", "Px", "Pw"]); // 0..6, diverges at 3
  CHAIN = heavier;
  const r = await syncOnce();
  assert.equal(r.reorgs, 0, "unreadable own-work -> FAIL CLOSED: no reconcile/unwind");
  assert.equal(await indexedHeight(), 5, "index NOT unwound/advanced while own-work is unreadable");
  const storedHash5 = ((await store().get("SELECT hash FROM blocks WHERE height=5 AND orphaned=0")) as any)?.hash;
  assert.equal(storedHash5, h32("blk-Pe"), "tip still the original branch (held, not replaced)");

  // CONTROL: repair the chainwork to a legit value >= node's earlier work but < the heavier chain, then the
  // SAME heavier divergence DOES reconcile -> proves the HOLD above was caused by the unreadable read.
  await store().run("UPDATE blocks SET chainwork=? WHERE height=5", String(5 * 1000 + 1)); // small, below heavier chain
  CHAIN = heavier;
  const r2 = await syncOnce();
  assert.ok(r2.reorgs >= 1, "with a legit (readable) own-work, the same heavier reorg reconciles");
  assert.equal(await indexedHeight(), 6, "advanced to the heavier chain tip");
});

test.after(async () => { server.close(); await closeDb(); });
