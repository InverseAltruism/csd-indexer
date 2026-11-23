// The block writer never waits behind readers (Postgres): syncOnce's store calls run on the writer's own pool of one
// connection, outside the readers' pool and its wait cap. On the shared pool a read flood refused the writer with
// "indexer db pool saturated" (69 of 79 block writes in one measured flood), so the tip froze while it lasted. The
// readers keep their cap: past it a read is refused as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { tmpDb } from "./_tmpdb.js";

const id = (tag: string) => "0x" + createHash("sha256").update(tag).digest("hex");
type B = { hash: string; height: number; chainwork: string; header: object; txs: object[] };
const CHAIN: B[] = [];
function grow(): void {
  const h = CHAIN.length, prev = CHAIN[h - 1]?.hash ?? "0x" + "00".repeat(32);
  CHAIN.push({ hash: id(`w-${h}`), height: h, chainwork: String((h + 1) * 1000),
    header: { bits: 0x1e00ffff, merkle: id(`mk-${h}`), nonce: 0, prev, time: 1_700_000_000 + h * 120, version: 1 },
    txs: [{ txid: id(`cb-${h}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 50 }] }] });
}
const server: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
  const t = CHAIN[CHAIN.length - 1]!;
  if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, tip: t.hash, height: t.height, chainwork: t.chainwork }));
  const m = /^\/block\/height\/(\d+)$/.exec(req.url ?? ""), b = m ? CHAIN[Number(m[1])] : undefined;
  if (!b) { res.statusCode = 404; return res.end("{}"); }
  res.end(JSON.stringify({ ok: true, ...b }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;
process.env.CSD_INDEX_DB = tmpDb("pgwriter");
process.env.CSD_INDEX_PG_SCHEMA = "t_pgwriter";
process.env.CSD_INDEX_PG_POOL = "2";            // readers' pool of 2, so their wait cap is 64
process.env.CSD_INDEX_FROM = "0";
const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const PG = store().backend === "postgres";
test.after(async () => { server.close(); await closeDb(); });

test("Postgres: block writes go through during a read flood that saturates the readers' pool",
  { skip: !PG && "Postgres only: SQLite has one connection and no pool to saturate" }, async () => {
    await resetStoreForTests();
    grow(); await syncOnce();
    assert.equal(await indexedHeight(), 0, "HAPPY PATH: the writer indexes with no flood");
    let stop = false, refused = 0, answered = 0;
    const flood = Promise.all(Array.from({ length: 200 }, async () => {
      while (!stop) {
        try { await store().get("SELECT pg_sleep(0.02)"); answered++; }
        catch (e) { if (/saturated/.test((e as Error).message)) refused++; else throw e; await new Promise((r) => setTimeout(r, 1)); }
      }
    }));
    await new Promise((r) => setTimeout(r, 200));      // the flood fills the readers' queue
    const errors: string[] = [];
    for (let i = 1; i <= 10; i++) {
      grow();
      const t0 = Date.now();
      try { const r = await syncOnce(); assert.equal(r.blocks, 1); } catch (e) { errors.push((e as Error).message); }
      assert.ok(Date.now() - t0 < 2000, `pass ${i} took ${Date.now() - t0} ms`);
    }
    stop = true; await flood;
    assert.deepEqual(errors, [], "no block write was refused");
    assert.equal(await indexedHeight(), 10, "every block of the flood's span is indexed");
    assert.ok(refused > 0, `the readers' wait cap still refuses past it (refused ${refused}, answered ${answered})`);
  });
