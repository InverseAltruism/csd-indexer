// With CSD_INDEX_FROM above 0 the index holds no block below it, so the place of a txid is its first occurrence
// at or above that height (README "Honest limits"). test/first-occurrence.test.ts covers the default start, 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDb } from "./_tmpdb.js";
import { mockNode, repeatChain } from "./_repeat-chain.js";

const { C1, P, A, main } = repeatChain();
const node = await mockNode(() => main);
process.env.CSD_RPC = node.url;
process.env.CSD_INDEX_DB = tmpDb("first-occurrence-floor");
process.env.CSD_INDEX_PG_SCHEMA = "t_first_occurrence_floor";
process.env.CSD_INDEX_FROM = "3";

const { syncOnce } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
await resetStoreForTests();
test.after(async () => { node.close(); await closeDb(); });

test("a start height above 0: a txid first held below it is placed at its first occurrence at or above it", async () => {
  await syncOnce();
  const all = async (sql: string) => JSON.parse(JSON.stringify(await store().all(sql)));
  assert.deepEqual(await all("SELECT height FROM blocks ORDER BY height"), [3, 4, 5, 6].map((height) => ({ height })));
  // C1 is held at heights 1 and 4, P at 2 and 5, A at 3 and 5
  const placed = (await all("SELECT txid, height, pos FROM txs ORDER BY height, pos")).filter((r: { txid: string }) => [C1.txid, P.txid, A.txid].includes(r.txid));
  assert.deepEqual(placed, [{ txid: A.txid, height: 3, pos: 1 }, { txid: C1.txid, height: 4, pos: 0 }, { txid: P.txid, height: 5, pos: 2 }]);
  assert.deepEqual(await all("SELECT height, pos, txid FROM tx_repeats"), [{ height: 5, pos: 3, txid: A.txid }]);
});
