// L9 (serial-poll DoS): getJson bounds every node RPC read with an AbortSignal timeout. A backend that
// answers /tip fast but then STALLS /block would otherwise wedge the serial sync loop forever. With the
// timeout, a hung /block aborts and blockByHeight returns null (the loop retries next poll) instead of
// hanging. The healthy path is unaffected: a fast response returns normally and never trips the timeout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";

let stallBlock = false;
const realHeader = { version: 1, prev: "0x" + "0".repeat(64), merkle: "0x" + "0".repeat(64), time: 1700000000, bits: 0x1e00ffff, nonce: 0 };
const srv: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
  if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height: 5, chainwork: "5000", tip: "0x" + "ab".repeat(32) }));
  if (req.url?.startsWith("/block/height/")) {
    if (stallBlock) return;                                  // never respond -> the getJson AbortSignal must fire
    return res.end(JSON.stringify({ ok: true, hash: "0x" + "cd".repeat(32), height: 5, chainwork: "5000", header: realHeader, txs: [] }));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(srv.address() as any).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;
process.env.CSD_RPC_TIMEOUT = "400";                         // short so the stall test is fast
process.env.CSD_INDEX_DB = `/tmp/csd-idx-timeout-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(process.env.CSD_INDEX_DB + s); } catch {} }
const rpc = await import("../src/rpc.js");

test("healthy path: /tip and a fast /block return normally (no false abort)", async () => {
  stallBlock = false;
  const t = await rpc.tip();
  assert.equal(t.height, 5);
  const b = await rpc.blockByHeight(5);
  assert.ok(b && b.height === 5, "a fast /block resolves within the timeout");
});

test("a backend that STALLS /block aborts (returns null) instead of wedging the serial poll", async () => {
  stallBlock = true;
  const started = Date.now();
  const b = await rpc.blockByHeight(5);
  const elapsed = Date.now() - started;
  assert.equal(b, null, "the stalled /block aborts and blockByHeight returns null (loop retries next poll)");
  assert.ok(elapsed >= 300 && elapsed < 3000, `aborted near the ${400}ms timeout, not hung (elapsed ${elapsed}ms)`);
  // /tip still answers fast afterwards -> the abort did not poison the client.
  stallBlock = false;
  assert.equal((await rpc.tip()).height, 5);
});

test.after(() => { srv.closeAllConnections?.(); srv.close(); });
