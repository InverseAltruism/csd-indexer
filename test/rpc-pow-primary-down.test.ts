// ROUTE-1 PoW gate, PRIMARY-DOWN path with 3 backends (IDX-BACKEND-POW-1, Fable-5 FIX 1). Cairn's
// 2-backend rule left primary-down as ungated liveness failover, safe only because there was exactly one
// secondary to fail over to. The production list is [:8789, :8790, :8795] (3 backends), so during a primary
// outage a forged loopback (a compromised CSD_RPC_BACKENDS entry) could out-claim the honest standby with
// ZERO PoW. The gate now anchors on the lowest-chainwork reachable backend when the primary is down and
// still PoW-verifies anyone claiming to beat it. Scenario: primary A DOWN, B honest+PoW-valid, C forged
// (invalid PoW) claiming the moon -> C is NOT selected, B wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

const realHeader = { version: 1, prev: "0x00000000000023001088ebb25d88a0657092d00129c76aaaa28a0f5dd5609095", merkle: "0xe0a002b0c98a8e64ecf2d7d2c2c1d6863b5dd9e03e6a3f22aaea6f03788cf5ef", time: 1781476758, bits: 453072620, nonce: 2749131683 };
const realTipHash = "0x0000000000010c70c936f93ee4acbf76016d9c1f51dcffc78924d561bbcf4928";

type HeaderMode = "valid" | "badpow";
function mockNode() {
  let height = 0, work = 0n, up = true, mode: HeaderMode = "valid";
  const srv: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    if (!up) { res.statusCode = 503; return res.end("{}"); }
    if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height, chainwork: String(work), tip: realTipHash }));
    if (req.url?.startsWith("/block/height/")) {
      const header = mode === "badpow" ? { ...realHeader, nonce: realHeader.nonce + 1 } : realHeader;
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

const A = mockNode(), B = mockNode(), C = mockNode();
await new Promise<void>((r) => A.srv.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => B.srv.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => C.srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = A.url();
process.env.CSD_RPC_BACKENDS = `${A.url()},${B.url()},${C.url()}`;   // 3 backends, like production [:8789,:8790,:8795]
process.env.CSD_RPC_WORK_ESCAPE = "1000";
// Empty, isolated local index -> the F6 plausibility gate stays inactive (no anchor) so this primary-down
// failover assertion holds on its own; the plausibility gate is exercised in rpc-route-plausibility.
process.env.CSD_INDEX_DB = `/tmp/csd-idx-rpcpd-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { (await import("node:fs")).rmSync(process.env.CSD_INDEX_DB + s); } catch {} }
const rpc = await import("../src/rpc.js");

test("primary DOWN, 3 backends: a forged-work standby (invalid PoW) does NOT win; the honest standby does", async () => {
  A.down();                                   // primary outage
  B.set(100, 1000n); B.setMode("valid");      // honest standby: real, PoW-valid tip
  C.set(99999, 1_000_000_000n); C.setMode("badpow"); // forged standby: claims the moon, no valid PoW
  let s = await rpc.selectBackend();
  assert.equal(s.active, B.url(), "forged standby C must NOT capture the feed during the primary outage");
  assert.notEqual(s.active, C.url());
  assert.equal(rpc.activeBackend(), B.url());
  assert.equal(s.height, 100, "reported height is the honest standby's, not the forged 99999");
  // stays honest across repeated degraded cycles.
  for (let i = 0; i < 3; i++) s = await rpc.selectBackend();
  assert.equal(s.active, B.url(), "still the honest standby after several cycles (no forged capture)");
  assert.equal(s.height, 100);
});

test.after(() => {
  for (const n of [A, B, C]) { n.srv.closeAllConnections?.(); n.srv.close(); }
});
