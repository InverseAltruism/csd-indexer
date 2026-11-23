// The tip pointer (meta indexed_height) moves with its block: syncOnce's forward write of a block and of the pointer are
// one transaction. They were two, and a failure between them (a crash, a lost connection) left the block stored one
// above the pointer; the chainwork guard and the tip window then read the pointer's height, so a node that served a
// lighter block at the top height had it written over the heavier stored one without a hold or a reorg event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { tmpDb } from "./_tmpdb.js";
import { spyStore } from "./_store-spy.js";

const id = (tag: string) => "0x" + createHash("sha256").update(tag).digest("hex");
type B = { hash: string; height: number; chainwork: string; header: object; txs: object[] };
const blk = (h: number, tag: string, prev: string, work: number): B => ({ hash: id(`${tag}-${h}`), height: h, chainwork: String(work),
  header: { bits: 0x1e00ffff, merkle: id(`mk-${tag}-${h}`), nonce: 0, prev, time: 1_700_000_000 + h * 120, version: 1 },
  txs: [{ txid: id(`cb-${tag}-${h}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 50 }] }] });
const base: B[] = [];
for (let h = 0, prev = "0x" + "00".repeat(32); h <= 4; h++) { const b = blk(h, "A", prev, (h + 1) * 1000); base.push(b); prev = b.hash; }
const heavy5 = blk(5, "A", base[4]!.hash, 9000);   // the block the index writes at 5
const light5 = blk(5, "L", base[4]!.hash, 5500);   // a lighter block at 5: more work than 4, less than heavy5
let CHAIN: B[] = [];
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
process.env.CSD_INDEX_DB = tmpDb("tipatomic");
process.env.CSD_INDEX_PG_SCHEMA = "t_tipatomic";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "0";
const { syncOnce, indexedHeight, lastNodeTipHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const storedTop = async () => Number(((await store().get<{ h: number }>("SELECT MAX(height) AS h FROM blocks")) as { h: number }).h);
const hashAt = async (h: number) => (await store().get<{ hash: string }>("SELECT hash FROM blocks WHERE height=?", h))?.hash;

test("honest: each written block moves the pointer with it", async () => {
  await resetStoreForTests();
  CHAIN = [...base, heavy5];
  await syncOnce();
  assert.equal(await indexedHeight(), 5);
  assert.equal(await storedTop(), 5);
  assert.equal(lastNodeTipHeight(), 5, "/health's node_tip_height: the node's tip at the last pass");
});

test("a failure at the pointer write leaves the block and the pointer together; a lighter block then holds", async () => {
  await resetStoreForTests();
  CHAIN = base;
  await syncOnce();
  assert.equal(await indexedHeight(), 4);
  // The first statement that writes the pointer to 5 fails, wherever it runs: the writer's store, inside a
  // transaction or not (on Postgres syncOnce writes on the writer's own pool, not on store()).
  let fired = false;
  const undo = spyStore(store(), async (method, args, real) => {
    const [sql, ...p] = args as [string, ...unknown[]];
    if (!fired && method === "run" && /INTO meta/.test(sql) && p.includes("5")) { fired = true; throw new Error("injected failure at the tip pointer"); }
    return await real(...args);
  });
  CHAIN = [...base, heavy5];
  try { await syncOnce(); } catch { /* the injected failure ends the pass, as a crash would */ } finally { undo(); }
  assert.equal(fired, true, "the failure was injected at the pointer's write");
  assert.equal(await storedTop(), await indexedHeight(), "the stored top and the pointer agree after the failure");
  // The pass that follows: if heavy5 is stored, a node serving the lighter block at 5 is behind on work and holds.
  CHAIN = [...base, light5];
  await syncOnce();
  const at5 = await hashAt(5);
  if (at5 === heavy5.hash) assert.equal(await indexedHeight(), 5, "heavy5 is kept and the guard held");
  else assert.equal(at5, light5.hash, "heavy5 was never committed, so the lighter block is the first at 5");
});

test.after(async () => { server.close(); await closeDb(); });
