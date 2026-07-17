// ROUTE-1 PoW gate on backend selection (IDX-BACKEND-POW-1). Mirrors cairn's rpcroute ROUTE-1 selftest as
// the parity oracle: a NON-primary backend (the on-host miner :8790 / standby :8795, incl. a forged
// loopback) may only WIN selectBackend() on work/height if its tip header is PoW-VALID and hash-bound. The
// primary (backends[0]) is the trusted authority and is never gated. The gate FAILS SOFT: a backend that
// cannot be PoW-verified (bad PoW, lying tip hash, hung header fetch, unreachable) simply cannot win; it
// never adds latency to the healthy path and never hard-fails a read.
//
// Coverage: (1) unit tests on the ported tipHeaderPowOk (real header verifies; nonce-bump / garbage /
// bits:0 / lying-tip-hash rejected). (2) INFLATION side: a forged-higher-chainwork backend serving an
// INVALID PoW header must NOT be selected (and its forged height must never reach the caller/regression
// guard). (3) HUNG/UNREACHABLE backend: selection still works and fails soft. (4) failover preserved: a
// genuinely-ahead backend with a VALID PoW header DOES still win.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// A REAL on-chain header (block 32803): sha256d(serializeHeader) <= target(bits) -> PoW-valid, and it
// hashes to realTipHash (hash-binding). Same vector cairn's ROUTE-1 selftest uses.
const realHeader = { version: 1, prev: "0x00000000000023001088ebb25d88a0657092d00129c76aaaa28a0f5dd5609095", merkle: "0xe0a002b0c98a8e64ecf2d7d2c2c1d6863b5dd9e03e6a3f22aaea6f03788cf5ef", time: 1781476758, bits: 453072620, nonce: 2749131683 };
const realTipHash = "0x0000000000010c70c936f93ee4acbf76016d9c1f51dcffc78924d561bbcf4928";

type HeaderMode = "valid" | "badpow" | "hang" | "none";
function mockNode() {
  let height = 0, work = 0n, up = true, mode: HeaderMode = "valid";
  const srv: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    if (!up) { res.statusCode = 503; return res.end("{}"); }
    if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height, chainwork: String(work), tip: realTipHash }));
    if (req.url?.startsWith("/block/height/")) {
      if (mode === "hang") return;                                        // never respond -> the verify fetch AbortSignal-times-out
      if (mode === "none") { res.statusCode = 404; return res.end("{}"); }
      const header = mode === "badpow" ? { ...realHeader, nonce: realHeader.nonce + 1 } : realHeader; // bumped nonce: PoW fails + no hash-bind
      return res.end(JSON.stringify({ ok: true, hash: realTipHash, height, chainwork: String(work), header, txs: [] }));
    }
    res.statusCode = 404; res.end("{}");
  });
  return {
    srv,
    set(h: number, w: bigint) { height = h; work = w; },
    setMode(m: HeaderMode) { mode = m; },
    down() { up = false; }, revive() { up = true; },
    url: () => `http://127.0.0.1:${(srv.address() as any).port}`,
  };
}

const A = mockNode(), B = mockNode();
await new Promise<void>((r) => A.srv.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => B.srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = A.url();
process.env.CSD_RPC_BACKENDS = `${A.url()},${B.url()}`;
process.env.CSD_RPC_WORK_ESCAPE = "1000";   // high: the forged/hung cases must NOT be rescued by a work-escape
process.env.CSD_RPC_POW_TIMEOUT = "300";     // short: the hung-header case fails soft fast
// Empty, isolated local index -> the F6 plausibility gate has no anchor and stays inactive here, so these
// ROUTE-1 badpow/hung assertions are proven independently (the plausibility gate is tested separately).
process.env.CSD_INDEX_DB = `/tmp/csd-idx-rpcpow-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { (await import("node:fs")).rmSync(process.env.CSD_INDEX_DB + s); } catch {} }
const rpc = await import("../src/rpc.js");

// ── unit: the ported tipHeaderPowOk (ROUTE-1 rule) ───────────────────────────────────────────────────
test("powOk: a real on-chain tip header verifies", () => {
  assert.equal(rpc.tipHeaderPowOk(realHeader, realTipHash), true);
});
test("powOk: bumping the nonce (PoW no longer satisfied) is rejected", () => {
  assert.equal(rpc.tipHeaderPowOk({ ...realHeader, nonce: realHeader.nonce + 1 }, realTipHash), false);
});
test("powOk: garbage / empty / null header -> false (fail safe)", () => {
  assert.equal(rpc.tipHeaderPowOk({}, realTipHash), false);
  assert.equal(rpc.tipHeaderPowOk(null, realTipHash), false);
});
test("powOk: invalid bits (0) -> false", () => {
  assert.equal(rpc.tipHeaderPowOk({ ...realHeader, bits: 0 }, realTipHash), false);
});
test("powOk: valid header bound to a LYING tip hash -> false (hash-binding)", () => {
  assert.equal(rpc.tipHeaderPowOk(realHeader, "0x" + "00".repeat(32)), false);
});
test("powOk: missing/non-hex claimed tip hash -> false (no free win without a real tip)", () => {
  assert.equal(rpc.tipHeaderPowOk(realHeader, null), false);
  assert.equal(rpc.tipHeaderPowOk(realHeader, "0xdead"), false);
});

// ── selection: INFLATION side (the core exploit) ─────────────────────────────────────────────────────
test("inflation BLOCKED: forged-higher-chainwork backend with an INVALID PoW header is NOT selected", async () => {
  // A is the trusted primary at a modest tip; B forges a huge height+chainwork but cannot serve a PoW-valid
  // tip header (nonce-bumped: fails both PoW and hash-binding). Pre-ROUTE-1 B would capture ALL reads.
  A.set(100, 1000n); A.setMode("valid");
  B.set(99999, 1_000_000_000n); B.setMode("badpow");
  let s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "forged secondary must NOT win -> stays on the trusted primary A");
  assert.equal(rpc.activeBackend(), A.url());
  // its forged height must never reach the caller (the regression guard reads this height/work).
  assert.equal(s.height, 100, "reported height is the primary's, not the forged 99999");
  // and it cannot capture over repeated cycles either.
  for (let i = 0; i < 3; i++) s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "still primary after several cycles (no forged capture)");
  assert.equal(s.height, 100);
});

// ── selection: HUNG / UNREACHABLE backend fails soft ─────────────────────────────────────────────────
test("fails soft: a would-be-winner whose header fetch HANGS is excluded, selection stays on the primary", async () => {
  // B claims to out-work the primary but its /block/height header endpoint never responds. The verify
  // fetch AbortSignal-times-out (CSD_RPC_POW_TIMEOUT), returns false, and B is demoted. No throw, no read
  // latency on the healthy primary path.
  A.set(200, 5000n); A.setMode("valid");
  B.set(88888, 9_000_000n); B.setMode("hang");
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "hung-header secondary cannot win -> stays primary (fail soft)");
  assert.equal(s.height, 200, "primary height reported, not the hung backend's claim");
});

test("fails soft: an unreachable backend does not stall selection", async () => {
  A.set(210, 5100n);
  B.down();
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "B down -> selection still resolves to the reachable primary A");
  assert.equal(s.height, 210);
  B.revive();
});

// ── failover PRESERVED: an honest ahead-backend with a VALID PoW header still wins ──────────────────
test("failover preserved: a genuinely-ahead backend with a PoW-VALID tip header DOES win", async () => {
  // B is really ahead (beyond the 3-block hysteresis) with more work AND serves a valid, hash-bound tip
  // header. ROUTE-1 must NOT block honest failover.
  A.set(32800, 100n); A.setMode("valid");
  B.set(32810, 1_000_000n); B.setMode("valid");
  const s = await rpc.selectBackend();
  assert.equal(s.active, B.url(), "honest PoW-valid, genuinely-ahead secondary wins");
  assert.equal(s.switched, true);
  assert.equal(rpc.activeBackend(), B.url());
});

test.after(() => { A.srv.closeAllConnections?.(); B.srv.closeAllConnections?.(); A.srv.close(); B.srv.close(); });
