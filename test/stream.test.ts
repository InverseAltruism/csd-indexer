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

// CAIRN-IDX-WS-2: a non-track-all WS client (e.g. track-domain only) must NOT receive `block`
// events — there is no per-block WS subscription; clients use {track-all} or SSE /stream/blocks.
test("WS does NOT deliver block events to a non-track-all subscriber", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ "track-domain": ["cairn:wall"] }));
  await next(ws, (m) => m.ack === true);
  // emit a block (must be filtered out) then a matching proposal (must arrive). If the block
  // leaked it would be the first kind!=ack message, so asserting the first such message is the
  // proposal proves the block was dropped.
  setTimeout(() => {
    bus.emitEvent({ kind: "block", height: 77, hash: "0xb10c", tx_count: 1, status: "confirmed" });
    bus.emitEvent({ kind: "proposal", txid: "0xcc", domain: "cairn:wall", height: 78, status: "tentative" });
  }, 50);
  const got = await next(ws, (m) => m.kind === "block" || m.kind === "proposal");
  assert.equal(got.kind, "proposal", "block event must be filtered out for a non-track-all client");
  ws.close();
});

// CAIRN-IDX-WS-2: a track-all client DOES receive block events.
test("WS delivers block events to a track-all subscriber", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ "track-all": true }));
  await next(ws, (m) => m.ack === true);
  setTimeout(() => bus.emitEvent({ kind: "block", height: 88, hash: "0xb88", tx_count: 0, status: "confirmed" }), 50);
  const got = await next(ws, (m) => m.kind === "block");
  assert.equal(got.height, 88, "track-all client receives the block event");
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
