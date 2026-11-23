// /domains orders domains with the same proposal count by their UTF-8 bytes on both backends. The statement's
// ORDER BY domain followed the database's collation: SQLite compares bytes and Postgres under en_US.UTF-8 does not, so
// the two backends answered ties in different orders where the docs promise identical answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("domains-order");
process.env.CSD_INDEX_PG_SCHEMA = "t_domains_order";
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const q = await import("../src/queries.js");
test.after(async () => { await closeDb(); });

test("ties in proposal count are in UTF-8 byte order; more proposals first", async () => {
  await resetStoreForTests();
  const one = ["Zeta", "csd:x", "a", "B", "csd-x", "alpha", "é", "z\u{1F600}", "z�"];
  let n = 0;
  const add = async (domain: string) => store().run("INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time) VALUES(?,?,?,?,?,?,?,?,?)",
    "0x" + (++n).toString(16).padStart(64, "0"), domain, "", "", 0, null, 0, n, n);
  for (const d of one) await add(d);
  for (let i = 0; i < 3; i++) await add("many");
  const got = (await q.domains()).map((r) => r.domain);
  assert.deepEqual(got, ["many", "B", "Zeta", "a", "alpha", "csd-x", "csd:x", "z�", "z\u{1F600}", "é"]);
});
