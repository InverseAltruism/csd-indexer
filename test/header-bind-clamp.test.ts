// I3 (O-6 / P74-44): the block header integers bound into 64-bit columns go through the SAME clamp helper
// the file already applies to output value, fee and expires_epoch.
//
// writeBlock bound `Number(blk.header.bits ?? 0)` (and nonce, version, time) raw. A backend payload at or
// above 2^63 then THROWS on the pg bind inside the block's dbTx: the transaction rolls back, the tip never
// advances, and the same block re-poisons every poll = a permanent indexer wedge. On sqlite the identical
// input does not throw at all, it silently stores a REAL, which is a cross-backend divergence in this
// repo's headline "byte-identical rows" claim. safeValue() closes both: it parses exactly and saturates at
// the signed-int64 ceiling the column can actually hold, exactly as it already does for output values.
//
// IDX-VERSION: safeValue's ceiling is int64 max, but `blocks.version` was declared `version INTEGER`, which
// is int4 on Postgres: the PRODUCTION backend. So I3 routed version through the clamp and then bound the
// clamped value into a column that tops out at 2147483647: the pg bind still failed with SQLSTATE 22003
// inside writeBlock's dbTx and the wedge stayed open for this one column. bits/nonce/time were already
// BIGINT and were genuinely fixed. The column is now BIGINT too (db.ts carries the operator migration for
// existing pg deployments).
//
// The gate had the same blind spot as the code: the assertions below run green on sqlite EITHER WAY,
// because sqlite's INTEGER is a 64-bit int. So this suite now also asserts the DECLARED column type, which
// is what actually differs, and CI's postgres job re-runs the behavioral arms against a real int8 bind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-hdrclamp-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });

const INT64_MAX = "9223372036854775807";
const INT32_MAX = 2147483647;          // the int4 ceiling `version INTEGER` used to impose on Postgres
const U32_MAX = 4294967295;            // the top of the domain csd-codec encodes header.version in (u32)
// Live values recorded from 127.0.0.1:8789 /block/height/67630 on 2026-08-02 (production's exact shape).
// nonce 2982576990 is itself above INT32_MAX, which is why nonce was already BIGINT and version was not.
const LIVE = { bits: 439936688, nonce: 2982576990, time: 1785701851, version: 1 };
type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
function blk(height: number, tag: string, prev: string, header: Partial<Record<string, unknown>> = {}): B {
  return {
    hash: h32(`blk-${tag}`), height, chainwork: String(height * 1000 + 1_000_000),
    header: { bits: LIVE.bits, merkle: h32(`mk-${tag}`), nonce: LIVE.nonce, prev, time: LIVE.time + height * 60, version: LIVE.version, ...header },
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

// Declared column types, backend-agnostic. The DDL is ONE shared constant, so asserting the declaration on
// whichever backend this suite runs against also gates the Postgres column: which is the whole point: the
// behavioral arms below pass on sqlite whether version is INTEGER or BIGINT (sqlite's INTEGER is already a
// 64-bit int), so the original suite was green on the one backend that never had the defect.
async function declaredTypes(table: string): Promise<Record<string, string | undefined>> {
  const s = store();
  const rows = s.backend === "sqlite"
    ? await s.all<{ name: string; type: string }>("SELECT name, type FROM pragma_table_info(?)", table)
    : await s.all<{ name: string; type: string }>(
        "SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?", table);
  return Object.fromEntries(rows.map((r) => [String(r.name), String(r.type).toLowerCase()]));
}

// ── IDX-VERSION RED-FIRST: the column must be DECLARED wide enough for what safeValue can hand it ──
test("IDX-VERSION: every clamped header column is declared 64-bit, so the clamped value can actually bind", async () => {
  await resetStoreForTests();
  const t = await declaredTypes("blocks");
  for (const col of ["time", "bits", "nonce", "version"]) {
    assert.equal(t[col], "bigint",
      `blocks.${col} is declared "${t[col]}". safeValue() saturates at ${INT64_MAX}; on Postgres an INTEGER column is int4 (ceiling ${INT32_MAX}), so that value fails the bind with SQLSTATE 22003 inside writeBlock's dbTx, the tx rolls back and the tip never advances = permanent wedge. version shipped as INTEGER; the other three were already BIGINT.`);
  }
});

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
  // the live nonce is already above the int4 ceiling, which is the measurement that says the u32 domain
  // below is real traffic on this chain and not a hypothetical
  assert.ok(LIVE.nonce > INT32_MAX, "the live header shape already carries a u32 above int4 max");
});

test("HAPPY PATH: a header version across the whole u32 domain round-trips EXACTLY (not clamped)", async () => {
  await resetStoreForTests();
  // csd-codec encodes header.version with u32(), so 0 .. 4294967295 is the protocol-legal domain. Clamping
  // version into int32 instead of widening the column would have stored a different value than the node
  // signed for the top half of that domain ("accept DIFFERENT", the GRX-WIRE-CLAMP-1 shape) and would have
  // newly diverged from sqlite, which stores those exactly today.
  const g = blk(0, "g", h32("genesis"));
  CHAIN = [g, blk(1, "u32lo", g.hash, { version: INT32_MAX + 1 }), blk(2, "u32hi", h32("blk-u32lo"), { version: U32_MAX })];
  await syncOnce();
  assert.equal(await indexedHeight(), 2, "the u32 header ingests (pre-fix this bind threw 22003 on pg)");
  assert.equal(String((await row(1)).version), String(INT32_MAX + 1), "2^31 stored exactly, not saturated to int4 max");
  assert.equal(String((await row(2)).version), String(U32_MAX), "u32 max stored exactly, not saturated to int4 max");
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

// This one asserted `version === INT64_MAX` and "still no wedge" before IDX-VERSION, which was true ONLY on
// sqlite: on Postgres the very same write threw SQLSTATE 22003 on the int4 bind. It is a real cross-backend
// claim now, and CI's postgres job is where it earns that.
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
