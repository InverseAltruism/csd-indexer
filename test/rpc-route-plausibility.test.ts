// F6 (ROUTE-1 route-capture) — the local-anchored plausibility gate on selectBackend. `tipHeaderPowOk`
// alone only checks a tip header against its OWN declared bits (powOk is floored at POW_LIMIT), so a REAL
// min-difficulty header hashes valid + hash-binds while the backend lies about chainwork/height in /tip.
// contenderPlausible() rejects such a contender by anchoring on the indexer's OWN local finality-gated
// headers (the blocks table) — NEVER the live primary — with two bounds:
//   (1) DELTA CAP: claimed height must be <= localTip + CFG.maxAheadBlocks.
//   (2) LWMA EASE: the contender's declared tip target (from its bits) must not be EASIER than the honest
//       expected local target (csd-light expectedBitsFromWindow) times CFG.maxEaseFactor.
//
// MANDATORY two-sided proof (both directions), plus a mutation:
//   FORGED (delta cap):  a valid tip header claiming a HUGE height is EXCLUDED; routing stays on the anchor.
//   FORGED (LWMA):       a valid but TOO-EASY tip header (relative to the anchored local difficulty) within
//                        the delta cap is EXCLUDED; routing stays on the anchor. (realHeader plays the
//                        min-difficulty forgery: the gate compares RELATIVE difficulty, so an anchor >16x
//                        harder than realHeader makes realHeader the "min-diff" forgery without grinding.)
//   HONEST FAILOVER:     a genuinely-ahead secondary at the CORRECT local difficulty, primary stale, WINS.
//   MUTATION:            with the gate disabled (CSD_RPC_ROUTE_PLAUSIBILITY=0) the forged tip WINS, proving
//                        each bound is load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { bitsToTarget, targetToBigInt, bigIntToTarget, targetToBits } from "@inversealtruism/csd-codec";

// A REAL on-chain header (block 32803): PoW-valid at bits 453072620 and hashes to realTipHash.
const realHeader = { version: 1, prev: "0x00000000000023001088ebb25d88a0657092d00129c76aaaa28a0f5dd5609095", merkle: "0xe0a002b0c98a8e64ecf2d7d2c2c1d6863b5dd9e03e6a3f22aaea6f03788cf5ef", time: 1781476758, bits: 453072620, nonce: 2749131683 };
const realTipHash = "0x0000000000010c70c936f93ee4acbf76016d9c1f51dcffc78924d561bbcf4928";
const REAL_BITS = 453072620;
const realTarget = targetToBigInt(bitsToTarget(REAL_BITS));

// A local difficulty 256x HARDER than realHeader (so realHeader is >16x too easy vs this anchor).
const HARDER_BITS = targetToBits(bigIntToTarget(realTarget / 256n));

type Cfg = { height: number; work: bigint; up: boolean; header: any; tipHash: string };
function mockNode(init: Partial<Cfg> = {}) {
  const c: Cfg = { height: 0, work: 0n, up: true, header: realHeader, tipHash: realTipHash, ...init };
  const srv: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
    if (!c.up) { res.statusCode = 503; return res.end("{}"); }
    if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height: c.height, chainwork: String(c.work), tip: c.tipHash }));
    if (req.url?.startsWith("/block/height/")) return res.end(JSON.stringify({ ok: true, hash: c.tipHash, height: c.height, chainwork: String(c.work), header: c.header, txs: [] }));
    res.statusCode = 404; res.end("{}");
  });
  return { srv, set(p: Partial<Cfg>) { Object.assign(c, p); }, url: () => `http://127.0.0.1:${(srv.address() as any).port}` };
}

const A = mockNode(), B = mockNode();
await new Promise<void>((r) => A.srv.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => B.srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = A.url();
process.env.CSD_RPC_BACKENDS = `${A.url()},${B.url()}`;
process.env.CSD_RPC_WORK_ESCAPE = "1000";   // high: forged cases must not be rescued by a work-escape
process.env.CSD_RPC_POW_TIMEOUT = "800";
process.env.CSD_RPC_MAX_AHEAD = "128";
process.env.CSD_RPC_MAX_EASE = "16";
const DB = `/tmp/csd-idx-plaus-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_FROM = "0";

const rpc = await import("../src/rpc.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");

const LOCAL_TIP = 50;
// Populate a local finality-gated window (heights 0..LOCAL_TIP) at a chosen difficulty, 120s spacing.
// The tip's block TIME is now-staleSecs: staleSecs=0 = a FRESH/steady-state anchor (the M1 wall-clock delta
// cap then reduces to the plain maxAhead); a large staleSecs simulates a FROZEN primary wedge (the local
// scanner cannot advance) so the wall-clock-aware cap must grow to let a genuinely-ahead honest secondary win.
async function populateLocal(bits: number, staleSecs = 0) {
  await resetStoreForTests();
  const s = store();
  const tipTime = Math.floor(Date.now() / 1000) - staleSecs;
  for (let h = 0; h <= LOCAL_TIP; h++) {
    await s.run("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
      h, "0x" + h.toString(16).padStart(64, "0"), null, null, tipTime - (LOCAL_TIP - h) * 120, bits, 0, 1, 0, String(h * 1000));
  }
}

test("FORGED (delta cap): a valid tip header claiming a HUGE height is EXCLUDED; routing stays on the anchor", async () => {
  await populateLocal(REAL_BITS);                       // local anchor = realHeader difficulty
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true }); // primary anchor at the local tip
  B.set({ height: 99999, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash }); // valid header, forged height
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "forged huge-height contender excluded by the delta cap -> stays on anchor A");
  assert.equal(s.height, LOCAL_TIP, "the forged 99999 never reaches the caller/regression guard");
});

test("FORGED (LWMA): a valid but TOO-EASY tip header within the delta cap is EXCLUDED", async () => {
  await populateLocal(HARDER_BITS);                     // local anchor 256x HARDER than realHeader
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true });
  B.set({ height: LOCAL_TIP + 5, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash }); // within delta cap, but >16x too easy
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "too-easy (min-diff-equivalent) contender excluded by the LWMA gate -> stays on anchor A");
  assert.equal(s.height, LOCAL_TIP, "the forged height never reaches the caller");
});

test("HONEST FAILOVER intact: a genuinely-ahead secondary at the CORRECT local difficulty (primary stale) WINS", async () => {
  await populateLocal(REAL_BITS);                       // local anchor = realHeader difficulty
  A.set({ height: LOCAL_TIP - 10, work: 100n, up: true });                     // primary stale/behind
  B.set({ height: LOCAL_TIP + 5, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash }); // ahead, correct difficulty
  const s = await rpc.selectBackend();
  assert.equal(s.active, B.url(), "honest ahead-secondary at the correct local difficulty is STILL selected");
  assert.equal(rpc.activeBackend(), B.url());
});

test("MUTATION (delta cap): disabling the gate lets the forged HUGE-height tip WIN (gate is load-bearing)", async () => {
  await populateLocal(REAL_BITS);
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true });
  B.set({ height: 99999, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash });
  process.env.CSD_RPC_ROUTE_PLAUSIBILITY = "0";        // disable the gate
  try {
    const s = await rpc.selectBackend();
    assert.equal(s.active, B.url(), "with the gate OFF the forged higher-work contender captures the feed");
    assert.equal(s.height, 99999, "and its forged height reaches the caller -> proves the gate blocks this");
  } finally { delete process.env.CSD_RPC_ROUTE_PLAUSIBILITY; }
});

test("MUTATION (LWMA): disabling the gate lets the TOO-EASY tip WIN (LWMA bound is load-bearing)", async () => {
  await populateLocal(HARDER_BITS);
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true });
  B.set({ height: LOCAL_TIP + 5, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash });
  process.env.CSD_RPC_ROUTE_PLAUSIBILITY = "0";
  try {
    const s = await rpc.selectBackend();
    assert.equal(s.active, B.url(), "with the gate OFF the too-easy contender wins -> the LWMA bound is what blocks it");
  } finally { delete process.env.CSD_RPC_ROUTE_PLAUSIBILITY; }
});

// ── M1 (Plan 70 R2 final red-team): the wall-clock-aware delta cap. A reachable-but-FROZEN primary wedge
// stalls the local anchor while the honest chain advances; a fixed maxAhead cap would then reject the
// genuinely-ahead honest secondary after ~maxAhead blocks of wedge (the incident-#10 stale-failover
// regression ROUTE-1 exists to prevent). The cap grows by (now - localTip.time)/blockSecs so an honest
// secondary that advanced DURING the wedge still wins, while a claim beyond wall-clock is still capped and
// a min-diff forgery is still caught by the (relative) LWMA-ease test.
test("WEDGE (M1): a genuinely-ahead honest secondary during a >maxAhead primary wedge is STILL selected", async () => {
  await populateLocal(REAL_BITS, 200 * 120);            // local anchor FROZEN ~200 blocks-worth ago (~6.7h wedge)
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true }); // primary frozen at the stale local tip
  B.set({ height: LOCAL_TIP + 150, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash }); // honest, 150 > maxAhead=128, correct difficulty
  const s = await rpc.selectBackend();
  assert.equal(s.active, B.url(), "honest secondary 150 ahead of a wedge-frozen anchor is SELECTED (the wall-clock cap grew with staleness) - the M1 fix");
});

test("WEDGE (M1): a claim BEYOND what wall-clock allows is still capped -> stays on the anchor", async () => {
  await populateLocal(REAL_BITS, 200 * 120);
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true });
  B.set({ height: LOCAL_TIP + 100000, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash }); // absurd, far beyond ~328 wall-clock cap
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "a height beyond wall-clock (maxAhead 128 + ~200 stale blocks) is still rejected by the grown cap");
});

test("WEDGE (M1): a min-diff forgery during a wedge is STILL rejected by the LWMA-ease defense", async () => {
  await populateLocal(HARDER_BITS, 200 * 120);          // stale AND a hard local difficulty
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true });
  B.set({ height: LOCAL_TIP + 150, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash }); // within the grown cap but >16x too easy
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "a too-easy forgery is rejected even during a wedge - the LWMA-ease defense survives a stale anchor");
});

test.after(async () => { A.srv.closeAllConnections?.(); B.srv.closeAllConnections?.(); A.srv.close(); B.srv.close(); await closeDb(); });
