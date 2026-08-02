// I3 (O-6 / P74-44): the block header integers bound into 64-bit columns go through the SAME clamp helper
// the file already applies to output value, fee and expires_epoch.
//
// writeBlock bound `Number(blk.header.bits ?? 0)` (and nonce, version, time) raw. A backend payload at or
// above 2^63 then THROWS on the pg bind inside the block's dbTx: the transaction rolls back, the tip never
// advances, and the same block re-poisons every poll = a permanent indexer wedge. On sqlite the identical
// input does not throw at all, it silently stores a REAL, which is a cross-backend divergence in this
// repo's headline "byte-identical rows" claim. safeValue() closes both: it parses exactly and saturates at
// the signed-int64 ceiling the column can actually hold, exactly as it already does for output values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-hdrclamp-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }

const INT64_MAX = "9223372036854775807";
type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
function blk(height: number, tag: string, prev: string, header: Partial<Record<string, unknown>> = {}): B {
  return {
    hash: h32(`blk-${tag}`), height, chainwork: String(height * 1000 + 1_000_000),
    header: { bits: 0x1e00ffff, merkle: h32(`mk-${tag}`), nonce: 42, prev, time: 1700000000 + height, version: 1, ...header },
    txs: [{ txid: h32(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 5000000000 }] }],
  };
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
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_hdrclamp";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";

const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const row = async (h: number) => (await store().get<Record<string, unknown>>("SELECT * FROM blocks WHERE height=? AND orphaned=0", h))!;

// ── PAIRED HAPPY-PATH: a real-shaped header round-trips to the exact same integers ──
test("HAPPY PATH: a real-shaped header stores bits/nonce/version/time exactly as served", async () => {
  await resetStoreForTests();
  const g = blk(0, "g", h32("genesis"));
  CHAIN = [g, blk(1, "a", g.hash)];
  await syncOnce();
  assert.equal(await indexedHeight(), 1);
  for (const h of [0, 1]) {
    const r = await row(h);
    assert.equal(String(r.bits), String(CHAIN[h]!.header.bits), `height ${h} bits byte-identical`);
    assert.equal(String(r.nonce), String(CHAIN[h]!.header.nonce), `height ${h} nonce byte-identical`);
    assert.equal(String(r.version), String(CHAIN[h]!.header.version), `height ${h} version byte-identical`);
    assert.equal(String(r.time), String(CHAIN[h]!.header.time), `height ${h} time byte-identical`);
  }
});

// ── I3 RED-FIRST: an out-of-range header integer clamps instead of wedging / storing junk ──
test("I3: bits = 2**63 writes a CLAMPED exact integer and the tip still advances", async () => {
  await resetStoreForTests();
  const g = blk(0, "g", h32("genesis"));
  CHAIN = [g, blk(1, "poison", g.hash, { bits: 2 ** 63 })];
  await syncOnce();
  await syncOnce();                                   // second poll: a wedge would show as no progress here
  assert.equal(await indexedHeight(), 1, "the tip advanced past the poisoned block (no permanent wedge)");
  const r = await row(1);
  assert.equal(String(r.bits), INT64_MAX,
    "bits saturated at the signed-int64 ceiling the column can bind; pre-fix sqlite stored the REAL 9223372036854776000 and pg threw on the bind");
});

test("I3: nonce, version and time are covered by the same helper", async () => {
  await resetStoreForTests();
  const g = blk(0, "g", h32("genesis"));
  CHAIN = [g, blk(1, "poison2", g.hash, { nonce: 2 ** 64, version: 2 ** 63, time: 1e21 })];
  await syncOnce();
  await syncOnce();
  assert.equal(await indexedHeight(), 1, "still no wedge");
  const r = await row(1);
  assert.equal(String(r.nonce), INT64_MAX, "nonce clamped");
  assert.equal(String(r.version), INT64_MAX, "version clamped");
  assert.equal(String(r.time), INT64_MAX, "time clamped");
});

test("I3: a malformed (negative / NaN) header integer degrades to 0, never a lossy REAL", async () => {
  await resetStoreForTests();
  const g = blk(0, "g", h32("genesis"));
  CHAIN = [g, blk(1, "poison3", g.hash, { bits: -1, nonce: "not-a-number", time: null })];
  await syncOnce();
  assert.equal(await indexedHeight(), 1);
  const r = await row(1);
  assert.equal(String(r.bits), "0");
  assert.equal(String(r.nonce), "0");
  assert.equal(String(r.time), "0");
});

test.after(async () => { server.close(); await closeDb(); });
