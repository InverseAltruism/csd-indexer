// CAIRN-IDX PAGINATION-DATALOSS-1 regression: the addressTxids keyset cursor must page the FULL
// (height, txid) tuple. A height-only cursor (`height < beforeHeight`) silently drops the remaining
// same-height txids when one block has more than `limit` txids touching an address (a busy
// treasury/faucet/exchange address) — they appear on NO page. This drives the real query layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB = `/tmp/csd-idx-pag-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_pag";
process.env.CSD_INDEX_FROM = "0";

const { addressTxids, addressTxidHeight } = await import("../src/queries.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
await resetStoreForTests();

const ADDR = "0x" + "ab".repeat(20);
const tx = (i: number) => "0x" + String(i).padStart(64, "0"); // lexical order == numeric order

test("addressTxids pages ALL same-height txids (no data loss past the page limit)", async () => {
  const d = store();
  // 30 distinct txids at height 100 (> the default limit of 25) + 5 at height 50, one address.
  for (let i = 0; i < 30; i++) await d.run("INSERT INTO address_history(addr,txid,height,pos,direction,delta) VALUES(?,?,?,?,?,?)", ADDR, tx(i), 100, 0, "in", 1);
  for (let i = 100; i < 105; i++) await d.run("INSERT INTO address_history(addr,txid,height,pos,direction,delta) VALUES(?,?,?,?,?,?)", ADDR, tx(i), 50, 0, "in", 1);

  // Page through with the SAME (height, txid) cursor the Esplora route now uses.
  const seen: string[] = [];
  let cursor: { height: number; txid: string } | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const page: { txid: string; height: number }[] = await addressTxids(ADDR, cursor, 25);
    if (!page.length) break;
    for (const r of page) seen.push(r.txid);
    const last = page[page.length - 1]!;
    cursor = { height: last.height, txid: last.txid };
    if (page.length < 25) break;
  }

  assert.equal(seen.length, 35, "all 35 distinct txids returned across pages (no same-height drop)");
  assert.equal(new Set(seen).size, 35, "no duplicate txid across pages");
  // every height-100 txid present (the class that the height-only cursor dropped)
  for (let i = 0; i < 30; i++) assert.ok(seen.includes(tx(i)), `height-100 txid #${i} present`);
  for (let i = 100; i < 105; i++) assert.ok(seen.includes(tx(i)), `height-50 txid #${i} present`);
});

test("addressTxidHeight resolves a cursor txid's height; unknown → null", async () => {
  assert.equal(await addressTxidHeight(ADDR, tx(0)), 100);
  assert.equal(await addressTxidHeight(ADDR, tx(100)), 50);
  assert.equal(await addressTxidHeight(ADDR, "0x" + "ff".repeat(32)), null);
});

test.after(async () => { await closeDb(); });
