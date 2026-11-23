// A /tip answer whose height is not a non-negative integer is unusable. Selection leaves such a backend out (a NaN
// height made the best height NaN, so the active backend never counted as close in height and the 3-block hysteresis
// was lost), and the sync pass fails before it reads the chain (the walk saw no height to converge at and unwound to
// the scan floor, or below the checkpoint floor's reach to an empty index). The honest numeric shapes still select
// and sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { realHeader, realTipHash } from "./fixtures/header-32803.js";
import { tmpDb } from "./_tmpdb.js";

const id = (tag: string) => "0x" + createHash("sha256").update(tag).digest("hex");
type Tip = Record<string, unknown>;
function node(tip: () => Tip, block: (h: number) => unknown): Server {
  return createServer((req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
    if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, ...tip() }));
    const m = /^\/block\/height\/(\d+)$/.exec(req.url ?? ""), b = m ? block(Number(m[1])) : undefined;
    if (!b) { res.statusCode = 404; return res.end("{}"); }
    res.end(JSON.stringify({ ok: true, ...(b as object) }));
  });
}
const CHAIN: unknown[] = [];
for (let h = 0, prev = "0x" + "00".repeat(32); h <= 9; h++) {
  const hash = id(`A-${h}`);
  CHAIN.push({ hash, height: h, chainwork: String((h + 1) * 1000), header: { bits: 0x1e00ffff, merkle: id(`mk-${h}`), nonce: 0, prev, time: 1_700_000_000 + h * 120, version: 1 },
    txs: [{ txid: id(`cb-${h}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 50 }] }] });
  prev = hash;
}
let aTip: Tip = {}, cTip: Tip = {}, nTip: Tip = {};
const A = node(() => aTip, (h) => CHAIN[h]);
const C = node(() => cTip, (h) => ({ hash: realTipHash, height: h, chainwork: String(cTip.chainwork), header: realHeader, txs: [] }));
const N = node(() => nTip, () => undefined);
for (const s of [A, C, N]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
const url = (s: Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;
process.env.CSD_RPC = url(A);
process.env.CSD_RPC_BACKENDS = `${url(A)},${url(C)},${url(N)}`;
process.env.CSD_RPC_WORK_ESCAPE = "1000";
process.env.CSD_RPC_ROUTE_PLAUSIBILITY = "0";       // C's tip is one real header at any height: the PoW arm alone here
process.env.CSD_INDEX_DB = tmpDb("tipheight");
process.env.CSD_INDEX_PG_SCHEMA = "t_tipheight";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "38142";   // the built-in floor, above this index's tip
const rpc = await import("../src/rpc.js");
const { CFG } = await import("../src/config.js");
const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { resetStoreForTests, closeDb } = await import("../src/db.js");
await resetStoreForTests();

// C pulls ahead and wins; A then out-works C within the 3-block margin, which keeps C active (no fail-back).
async function stickyAfterCatchUp(nAnswer: Tip | null): Promise<string> {
  CFG.rpcBackends = nAnswer ? [url(A), url(C), url(N)] : [url(A), url(C)];
  if (nAnswer) nTip = nAnswer;
  aTip = { height: 9, chainwork: "10000", tip: id("A-9") }; cTip = { height: 9, chainwork: "10000", tip: realTipHash };
  await rpc.selectBackend();
  cTip = { height: 15, chainwork: "16000", tip: realTipHash };
  assert.equal((await rpc.selectBackend()).active, url(C), "C is ahead on work and height");
  aTip = { height: 14, chainwork: "17000", tip: id("A-9") };
  return (await rpc.selectBackend()).active;
}

test("honest: with two numeric backends the active one stays within the height margin", async () => {
  assert.equal(await stickyAfterCatchUp(null), url(C));
});

for (const height of ["abc", {}]) {
  test(`a third backend answering height ${JSON.stringify(height)} leaves the hysteresis as it was`, async () => {
    assert.equal(await stickyAfterCatchUp({ height, chainwork: "1", tip: id("x") }), url(C));
  });
}

test("honest: a numeric /tip syncs; a /tip without an integer height fails the pass and the index stays", async () => {
  CFG.rpcBackends = [url(A)];
  aTip = { height: 9, chainwork: "10000", tip: id("A-9") };
  await rpc.selectBackend();
  await syncOnce();
  assert.equal(await indexedHeight(), 9, "the honest chain is indexed");
  for (const height of ["abc", undefined, 2.5]) {
    aTip = { height, chainwork: "20000", tip: id("A-9") };
    await assert.rejects(syncOnce(), /height/, `height ${String(height)} fails the pass`);
    assert.equal(await indexedHeight(), 9, `height ${String(height)} unwinds nothing`);
  }
  aTip = { height: 9, chainwork: "10000", tip: id("A-9") };
  const r = await syncOnce();
  assert.equal(r.reorgs, 0);
  assert.equal(await indexedHeight(), 9, "the next honest pass finds the index intact");
});

test.after(async () => { for (const s of [A, C, N]) { s.closeAllConnections?.(); s.close(); } await closeDb(); });
