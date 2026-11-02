// Streaming: a real HTTP server + real WS/SSE clients receive bus events, honor
// subscription filters, and ALWAYS receive reorg events. Offline (no node): we
// drive the in-process bus directly, which is exactly what the indexer publishes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("stream");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_stream";

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
// events: there is no per-block WS subscription; clients use {track-all} or SSE /stream/blocks.
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

// Every socket the tests below open is terminated at the end, so a failed assertion cannot hold server.close().
const clients: WebSocket[] = [];
const openWs = async (port: number): Promise<WebSocket> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  clients.push(ws);
  await new Promise((r) => ws.on("open", r));
  return ws;
};
const closed = (ws: WebSocket, ms = 2000) => new Promise<number>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout waiting for the server to close the socket")), ms);
  ws.once("close", (code) => { clearTimeout(t); resolve(code); });
});

// The API and the sync loop share one process with no uncaughtException handler, so a frame that throws out of the
// WebSocket layer stops both. These tests run the server in a child process, since the test runner's own handler
// would keep an in-process server alive.
const boot = `const { serve } = await import(${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)});
  const s = serve(0, "127.0.0.1"); s.on("listening", () => console.log("port " + s.address().port));`;
const child = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", boot],
  { env: { ...process.env, CSD_INDEX_DB: tmpDb("stream-child"), CSD_INDEX_PG_SCHEMA: "t_stream_child" }, stdio: ["ignore", "pipe", "pipe"] });
let childErr = "";
child.stderr.on("data", (d) => { childErr += d; });
const exited = new Promise<string>((r) => child.once("exit", (code) =>
  r(`server exited (${code}): ${childErr.split("\n").find((l) => /Error/.test(l)) ?? childErr}`)));
const CHILD = await new Promise<number>((resolve, reject) => {
  let out = "";
  child.stdout.on("data", (d) => { out += d; const m = /port (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
  void exited.then(reject);
});
const alive = async () => {
  assert.equal(await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("running"), 200))]), "running");
  assert.equal((await fetch(`http://127.0.0.1:${CHILD}/health`)).status, 200, "the API answers");
};
const acked = async (ws: WebSocket, pred: (m: any) => boolean, what: string) => {
  const m = await Promise.race([next(ws, (x) => x.ack === true && pred(x)), exited]);
  assert.notEqual(typeof m, "string", `${what}: ${m}`);
  return m;
};

test("WS: malformed subscribe frames leave the process running; the same socket's honest subscribe is acked", async () => {
  for (const frame of ["null", '{"track-domain":"x"}', '{"track-address":5}', '{"track-proposal":null,"track-domain":{}}', "7", '"s"']) {
    const ws = await openWs(CHILD);
    ws.send(frame);
    ws.send(JSON.stringify({ "track-domain": ["cairn:wall"] }));
    const ack = await acked(ws, (m) => m.tracking.domains.length > 0, frame);
    assert.deepEqual(ack.tracking, { domains: ["cairn:wall"], addresses: [], proposals: [], all: false }, frame);
    ws.close();
  }
  await alive();
});

test("WS: a frame whose handling throws closes only that socket (1011); another client is served", async () => {
  const bad = await openWs(CHILD);
  const code = Promise.race([closed(bad), exited]);
  bad.send(JSON.stringify({ "track-address": [{ toString: 1, valueOf: 1 }] }));
  assert.equal(await code, 1011);
  await alive();
  const ws = await openWs(CHILD);
  ws.send(JSON.stringify({ "track-address": ["0xAB"] }));
  assert.deepEqual((await acked(ws, () => true, "honest")).tracking.addresses, ["0xab"]);
  ws.close();
});

test("WS: a frame over 64 KiB is refused before it is buffered (1009); a subscribe under it is acked", async () => {
  const big = await openWs(CHILD);
  const code = Promise.race([closed(big), exited]);
  big.send(JSON.stringify({ "track-domain": ["d".repeat(65 * 1024)] }));
  assert.equal(await code, 1009);
  await alive();
  const ws = await openWs(CHILD);
  ws.send(JSON.stringify({ "track-domain": ["d".repeat(60 * 1024)] }));
  assert.equal((await acked(ws, () => true, "60 KiB")).tracking.domains[0].length, 60 * 1024);
  ws.close();
});

test("WS: a text frame that is not UTF-8 closes that socket (1007) and the process keeps running", async () => {
  const bad = await openWs(CHILD);
  const code = Promise.race([closed(bad), exited]);
  bad.send(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]), { binary: false });
  assert.equal(await code, 1007);
  await alive();
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

test.after(() => { for (const ws of clients) ws.terminate(); child.kill(); server.close(); });
