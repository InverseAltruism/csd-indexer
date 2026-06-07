// Streaming: a real HTTP server + real WS/SSE clients receive bus events, honor
// subscription filters, and ALWAYS receive reorg events. Offline (no node) — we
// drive the in-process bus directly, which is exactly what the indexer publishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { WebSocket } from "ws";

const DB = `/tmp/csd-idx-stream-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;

const { serve } = await import("../src/server.js");
const { bus } = await import("../src/events.js");

const PORT = 18799;
const server = serve(PORT, "127.0.0.1");
await new Promise((r) => setTimeout(r, 250));

const next = (ws: WebSocket, pred: (m: any) => boolean, ms = 2000) =>
  new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for ws message")), ms);
    const on = (raw: any) => { let m; try { m = JSON.parse(String(raw)); } catch { return; } if (pred(m)) { clearTimeout(t); ws.off("message", on); resolve(m); } };
    ws.on("message", on);
  });

test("WS delivers matching domain events and filters out others", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ "track-domain": ["cairn:wall"] }));
  await next(ws, (m) => m.ack === true);

  // a NON-matching domain proposal must NOT arrive; a matching one must.
  setTimeout(() => {
    bus.emitEvent({ kind: "proposal", txid: "0xaa", domain: "other:domain", height: 1, status: "tentative" });
    bus.emitEvent({ kind: "proposal", txid: "0xbb", domain: "cairn:wall", height: 2, status: "tentative" });
  }, 50);
  const got = await next(ws, (m) => m.kind === "proposal");
  assert.equal(got.domain, "cairn:wall", "only the tracked domain's proposal is delivered");
  assert.equal(got.txid, "0xbb");
  ws.close();
});

test("WS always delivers reorg events regardless of subscription", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ "track-domain": ["nothing:matches"] }));
  await next(ws, (m) => m.ack === true);
  setTimeout(() => bus.emitEvent({ kind: "reorg", ancestor: 100, depth: 3 }), 50);
  const got = await next(ws, (m) => m.kind === "reorg");
  assert.equal(got.ancestor, 100);
  assert.equal(got.depth, 3);
  ws.close();
});

test("SSE /stream/blocks streams block + reorg events", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PORT}/stream/blocks`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  // first frame is the hello
  await reader.read();
  setTimeout(() => bus.emitEvent({ kind: "block", height: 42, hash: "0xdead", tx_count: 2, status: "confirmed" }), 50);
  let buf = "";
  for (let i = 0; i < 20; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    if (buf.includes('"height":42')) break;
  }
  assert.ok(buf.includes("event: block"), "SSE emits a block event");
  assert.ok(buf.includes('"height":42'), "with the right payload");
  ctrl.abort();
});

test.after(() => server.close());
