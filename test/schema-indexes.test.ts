// BP5 (N17 + N20): the four transport indexes must exist after boot and must actually
// be USED by the statements they were added for. blocks(hash) serves queries.ts
// blockByHash (2 lookups/height behind every cold /api/headers miss, previously an
// O(chain) seq scan); outputs(height), outputs(spent_height), address_history(height)
// serve writeBlock's per-height self-clear and unwindAbove (previously per-block seq
// scans that made the from-genesis DR replay effectively quadratic).
//
// Existence is asserted on BOTH backends (sqlite_master / pg_indexes). The query-plan
// half is sqlite-only: EXPLAIN QUERY PLAN is a stable sqlite contract, while the pg
// planner on tiny test tables legitimately prefers a seq scan, so a pg plan assertion
// would be flaky by design (CI's test-postgres job still runs the existence half).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { merkleRoot } from "@inversealtruism/csd-codec";

// isolate the DB BEFORE importing any module that reads config
const DB = `/tmp/csd-idx-schemaidx-test-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch { /* gone */ } }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_schema_indexes";
process.env.CSD_INDEX_FROM = "0";

const { writeBlock, unwindAbove } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
await resetStoreForTests();
test.after(async () => { await closeDb(); for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch { /* gone */ } } });

const SQLITE = store().backend === "sqlite";
const BP5_INDEXES = ["idx_blocks_hash", "idx_out_height", "idx_out_spent_height", "idx_addrhist_height"];

// minimal synthetic chain (same builders as indexer.test.ts) so the plan assertions run
// against populated tables that went through the REAL writeBlock path
let nonce = 0;
const txid = (tag: string) => "0x" + Buffer.from(tag.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
const ADDR_A = "0x" + "a1".repeat(20);
function mkBlock(height: number, prev: string, txs: any[]): any {
  return {
    hash: "0x" + Buffer.from(`blk${height}_${nonce++}`.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0"),
    height, chainwork: String((height + 1) * 1000),
    header: { bits: 0x1e00ffff, merkle: merkleRoot(txs.map((t) => t.txid)), nonce, prev, time: 1700000000 + height, version: 1 },
    txs,
  };
}
const coinbase = (tag: string, to: string, value = 5_000_000_000) => ({
  txid: txid(tag), version: 1, locktime: 0, inputs: [{}], outputs: [{ script_pubkey: to.replace(/^0x/, ""), value }],
});

let prev = "0x" + "00".repeat(32);
const hashes: string[] = [];
for (let h = 0; h <= 9; h++) {
  const b = mkBlock(h, prev, [coinbase(`cb${h}`, ADDR_A)]);
  await writeBlock(b);
  prev = b.hash; hashes.push(b.hash);
}

async function existingIndexNames(): Promise<Set<string>> {
  const rows = SQLITE
    ? await store().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'")
    : await store().all<{ name: string }>("SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()");
  return new Set(rows.map((r) => r.name));
}

test("BP5 indexes exist after boot (blocks.hash, outputs.height, outputs.spent_height, address_history.height)", async () => {
  const names = await existingIndexNames();
  for (const ix of BP5_INDEXES) assert.ok(names.has(ix), `missing index ${ix} on backend ${store().backend}`);
});

// EXPLAIN QUERY PLAN detail lines for one statement, joined ("SEARCH t USING INDEX ix" / "SCAN t")
async function plan(sql: string, ...params: unknown[]): Promise<string> {
  const rows = await store().all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
  return rows.map((r) => r.detail).join(" | ");
}
function assertUsesIndex(p: string, table: string, ix: string, label: string) {
  assert.match(p, new RegExp(`SEARCH ${table} USING (COVERING )?INDEX ${ix}`), `${label}: expected ${ix}, plan was: ${p}`);
  assert.ok(!new RegExp(`SCAN ${table}\\b`).test(p), `${label}: table scan on ${table}, plan was: ${p}`);
}

test("blockByHash lookup uses idx_blocks_hash (no table scan)", { skip: !SQLITE && "EXPLAIN QUERY PLAN is sqlite-only" }, async () => {
  // exact statement from queries.ts blockByHash
  const p = await plan("SELECT * FROM blocks WHERE hash=? AND orphaned=0", hashes[5]);
  assertUsesIndex(p, "blocks", "idx_blocks_hash", "blockByHash");
});

test("writeBlock height self-clear uses idx_out_height and idx_addrhist_height (no table scan)", { skip: !SQLITE && "EXPLAIN QUERY PLAN is sqlite-only" }, async () => {
  // exact statements from indexer.ts writeBlock's per-height clear (and unwindAbove's > variants)
  assertUsesIndex(await plan("DELETE FROM outputs WHERE height=?", 5), "outputs", "idx_out_height", "writeBlock DELETE outputs");
  assertUsesIndex(await plan("DELETE FROM address_history WHERE height=?", 5), "address_history", "idx_addrhist_height", "writeBlock DELETE address_history");
  assertUsesIndex(await plan("DELETE FROM outputs WHERE height>?", 5), "outputs", "idx_out_height", "unwindAbove DELETE outputs");
  assertUsesIndex(await plan("DELETE FROM address_history WHERE height>?", 5), "address_history", "idx_addrhist_height", "unwindAbove DELETE address_history");
});

test("spent_height un-spend (writeBlock = and unwindAbove >) uses idx_out_spent_height (no table scan)", { skip: !SQLITE && "EXPLAIN QUERY PLAN is sqlite-only" }, async () => {
  // exact statements from indexer.ts writeBlock (equality) and unwindAbove (range)
  assertUsesIndex(await plan("UPDATE outputs SET spent_txid=NULL, spent_height=NULL WHERE spent_height=?", 5), "outputs", "idx_out_spent_height", "writeBlock un-spend");
  assertUsesIndex(await plan("UPDATE outputs SET spent_txid=NULL, spent_height=NULL WHERE spent_height>?", 5), "outputs", "idx_out_spent_height", "unwindAbove un-spend");
});

test("write path and reorg unwind still behave identically with the indexes present", async () => {
  // unwind above 7, then re-extend: rows below intact, rows above gone, replay clean
  await unwindAbove(7);
  const gone = await store().get<any>("SELECT COUNT(*) n FROM blocks WHERE height>7");
  assert.equal(Number(gone.n), 0, "blocks above ancestor deleted");
  const kept = await store().get<any>("SELECT COUNT(*) n FROM outputs");
  assert.equal(Number(kept.n), 8, "outputs at heights 0..7 kept");
  const b8 = mkBlock(8, hashes[7]!, [coinbase("cb8b", ADDR_A)]);
  await writeBlock(b8);
  const re = await store().get<any>("SELECT hash FROM blocks WHERE height=8 AND orphaned=0");
  assert.equal(re.hash, b8.hash, "replay after unwind writes cleanly");
});
