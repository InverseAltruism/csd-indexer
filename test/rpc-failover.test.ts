// Multi-backend RPC failover: selectBackend() must read the reachable, highest-chainwork backend, with
// stickiness (no flap, no auto-fail-back). Two mock nodes A (primary) and B whose tips we drive. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

function mockNode() {
  let height = 0, work = 0n, up = true;
  const srv: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");                                // no keep-alive: sockets close so srv.close() is clean
    if (!up) { res.statusCode = 503; return res.end("{}"); }             // "down" -> not ok -> treated unreachable
    if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height, chainwork: String(work), tip: "0x00" }));
    res.statusCode = 404; res.end("{}");
  });
  return {
    srv,
    set(h: number, w: bigint) { height = h; work = w; },
    down() { up = false; }, revive() { up = true; },
    url: () => `http://127.0.0.1:${(srv.address() as any).port}`,
  };
}

const A = mockNode(), B = mockNode();
await new Promise<void>((r) => A.srv.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => B.srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = A.url();
process.env.CSD_RPC_BACKENDS = `${A.url()},${B.url()}`;
const rpc = await import("../src/rpc.js");

test("failover: prefers the primary on a chainwork tie", async () => {
  A.set(100, 1000n); B.set(100, 1000n);
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "tie resolves to primary A");
});

test("failover: switches to the higher-chainwork backend", async () => {
  A.set(100, 1000n); B.set(105, 1500n);
  const s = await rpc.selectBackend();
  assert.equal(s.active, B.url(), "B has more work");
  assert.equal(s.switched, true);
  assert.equal(rpc.activeBackend(), B.url());
});

test("failover: sticky, NO auto-fail-back when the primary catches up to a tie", async () => {
  A.set(105, 1500n); B.set(105, 1500n);
  const s = await rpc.selectBackend();
  assert.equal(s.active, B.url(), "stays on B (avoids oscillation)");
  assert.equal(s.switched, false);
});

test("failover: falls to the only reachable backend", async () => {
  B.down(); A.set(106, 1600n);
  const s = await rpc.selectBackend();
  assert.equal(s.active, A.url(), "B down -> A");
  assert.equal(s.switched, true);
  B.revive();
});

test("failover: keeps the last ACTIVE when nothing is reachable", async () => {
  const before = rpc.activeBackend();
  A.down(); B.down();
  const s = await rpc.selectBackend();
  assert.equal(s.active, before, "kept last ACTIVE (reads then fail + retry)");
  assert.equal(s.switched, false);
  A.revive(); B.revive();
});

test.after(() => { A.srv.closeAllConnections?.(); B.srv.closeAllConnections?.(); A.srv.close(); B.srv.close(); });
