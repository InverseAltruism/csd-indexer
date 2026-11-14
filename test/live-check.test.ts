// test/_live_check.mjs, the manual gate run against a live index and its node, run here against the API serving an
// index of the repeat chain and a mock node. The gate checks block tip-2; a txid held there whose first occurrence
// is an earlier block or position is proven in that place (README "Honest limits").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { merkleRoot } from "@inversealtruism/csd-codec";
import { tmpDb } from "./_tmpdb.js";
import { type Blk, block, coinbase, id, mockNode, repeatChain, spend } from "./_repeat-chain.js";

let CHAIN: Blk[] = [];
const node = await mockNode(() => CHAIN);
process.env.CSD_RPC = node.url;
process.env.CSD_INDEX_DB = tmpDb("live-check");
process.env.CSD_INDEX_PG_SCHEMA = "t_live_check";
delete process.env.CSD_INDEX_FROM;

const { syncOnce } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");
const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const api = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
test.after(async () => { srv.close(); node.close(); await closeDb(); });

const repo = fileURLToPath(new URL("..", import.meta.url));
/** The gate's exit code and output, run as AGENTS.md says (tsx, from the repo dir). */
async function liveCheck(): Promise<{ code: unknown; out: string }> {
  const run = promisify(execFile)("./node_modules/.bin/tsx", ["test/_live_check.mjs"], { cwd: repo, env: { ...process.env, CSD_INDEX_API: api, CSD_RPC: node.url } });
  try { return { code: 0, out: (await run).stdout }; }
  catch (e) { const err = e as { code?: unknown; stdout?: string }; return { code: err.code, out: err.stdout ?? "" }; }
}

const { P, D, S, main } = repeatChain();
const Z = spend("z", S, 44);
const b7 = block(main[6] as Blk, "7", [coinbase("7"), Z, Z]);   // Z again at position 2 of its own block
const b8 = block(b7, "8", [coinbase("8")]), b9 = block(b8, "9", [coinbase("9")]);

test("the live gate passes on blocks holding a txid first held by an earlier block or position", async () => {
  await resetStoreForTests();
  // tip 6: block 4 holds C1 (first at height 1) and D; tip 7: block 5 holds P and A (first at 2 and 3);
  // tip 9: block 7 holds Z at positions 1 and 2
  for (const chain of [main, [...main, b7], [...main, b7, b8, b9]]) {
    CHAIN = chain;
    await syncOnce();
    const r = await liveCheck();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /LIVE E2E: \d+ passed, 0 failed/);
  }
});

test("the live gate fails when the node's header of the first block does not commit a txid tip-2 holds again", async () => {
  await resetStoreForTests();
  CHAIN = main;
  await syncOnce();
  // the node now answers height 1 (C1's first block) with a header root over another list
  const b1 = main[1] as Blk;
  CHAIN = main.map((b) => (b === b1 ? { ...b1, header: { ...b1.header, merkle: merkleRoot([id("other"), b1.txs[1]?.txid ?? ""]) } } : b));
  const r = await liveCheck();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /❌ block 4: ALL 2 served merkle proofs verify/);
});

test("the live gate fails when the index lists at a position of tip-2 a txid the node's block holds elsewhere", async () => {
  await resetStoreForTests();
  CHAIN = main;
  await syncOnce();
  // block 4 is [C1, D]; the index now lists P (first held at height 2, its proof folds there) at position 1
  await store().run("DELETE FROM txs WHERE txid=?", D.txid);
  await store().run("INSERT INTO tx_repeats(height, pos, txid) VALUES (?, ?, ?)", 4, 1, P.txid);
  const r = await liveCheck();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /❌ block 4: ALL 2 served merkle proofs verify/);
});

test("the live gate fails when the index places a txid at a later occurrence than tip-2 holds it", async () => {
  await resetStoreForTests();
  CHAIN = [...main, b7, b8, b9];
  await syncOnce();
  // block 7 holds Z at positions 1 and 2; the index now places Z at 2 and lists 1 as the repeat (the lists match)
  await store().run("UPDATE txs SET pos=2 WHERE txid=?", Z.txid);
  await store().run("UPDATE tx_repeats SET pos=1 WHERE height=7 AND pos=2");
  const r = await liveCheck();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /❌ block 7: ALL 3 served merkle proofs verify/);
});
