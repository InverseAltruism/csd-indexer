// F2/I1: blockByHeight must bind the response to the REQUESTED height. The node answers 200 with
// {ok:false, hash:"", height:null, header:{err}, txs:[]} for a height beyond tip, and that shape used
// to pass the structural check -> a NULL/mismatched height could be written as a canonical row,
// resurrecting spent outputs as live UTXOs served to the wallet/resolver/front-door. Red-first: the
// mismatched/absent height is now refused (null); the honest path (height echoes the request) is
// unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";

const realHeader = { version: 1, prev: "0x" + "0".repeat(64), merkle: "0x" + "0".repeat(64), time: 1700000000, bits: 0x1e00ffff, nonce: 0 };
const srv: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
  if (req.url === "/block/height/5") {
    // honest: the payload's height echoes the request
    return res.end(JSON.stringify({ ok: true, hash: "0x" + "cd".repeat(32), height: 5, chainwork: "5000", header: realHeader, txs: [] }));
  }
  if (req.url === "/block/height/6") {
    // MISMATCH: the payload's height does not match the request
    return res.end(JSON.stringify({ ok: true, hash: "0x" + "cd".repeat(32), height: 999, chainwork: "5000", header: realHeader, txs: [] }));
  }
  if (req.url === "/block/height/999") {
    // beyond tip: the node's 200 error shape carrying height:null
    return res.end(JSON.stringify({ ok: false, hash: "", height: null, header: { err: "height beyond tip" }, txs: [] }));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(srv.address() as any).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;
process.env.CSD_INDEX_DB = `/tmp/csd-idx-heightecho-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(process.env.CSD_INDEX_DB + s); } catch {} }
const rpc = await import("../src/rpc.js");

test("honest path: a height that echoes the request is accepted", async () => {
  const b = await rpc.blockByHeight(5);
  assert.ok(b && b.height === 5, "an honest height-echo resolves");
});

test("a mismatched height is refused (returns null)", async () => {
  const b = await rpc.blockByHeight(6); // server answers height:999
  assert.equal(b, null, "a payload whose height != the request is refused");
});

test("a beyond-tip 200 error shape (height:null) is refused", async () => {
  const b = await rpc.blockByHeight(999);
  assert.equal(b, null, "a null-height error shape is refused");
});

test.after(() => { srv.closeAllConnections?.(); srv.close(); });
