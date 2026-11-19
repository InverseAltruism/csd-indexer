// WebSocket bounds: what one /ws connection can make the process hold. A subscription key longer than any key an event
// can carry adds nothing, so the keys a connection holds are bounded by the key count cap times the longest key; and a
// client that stops reading is dropped once its socket's queued bytes pass the per-connection outbound bound, the rule
// SSE has (test/sse-overflow.test.ts). The server runs in process (the real attachWs on an ephemeral 127.0.0.1 port) so
// the test can read the server side of each socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MAX_DOMAIN_BYTES } from "@inversealtruism/csd-codec";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("ws-bounds");
process.env.CSD_INDEX_PG_SCHEMA = "t_ws_bounds";
delete process.env.CSD_INDEX_MAX_SSE_BUFFER;
delete process.env.CSD_INDEX_MAX_SUB;

const { attachWs } = await import("../src/stream.js");
const { bus } = await import("../src/events.js");
const { CFG } = await import("../src/config.js");

const server = createServer();
const wss = attachWs(server);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as AddressInfo).port;

// The server side of each connection, with the most bytes its socket held queued right after each subscribe frame was
// handled. This listener is added after attachWs's own, so it runs after the server's ack is sent.
type Srv = { sock: WebSocket; peak: number; closed: Promise<void> };
const accepted: Srv[] = [];
wss.on("connection", (sock: WebSocket) => {
  const s: Srv = { sock, peak: 0, closed: new Promise((r) => sock.once("close", () => r())) };
  sock.on("message", () => { s.peak = Math.max(s.peak, sock.bufferedAmount); });
  accepted.push(s);
});

const clients: WebSocket[] = [];
test.after(() => { for (const c of clients) c.terminate(); wss.close(); server.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function open(): Promise<{ ws: WebSocket; srv: Srv }> {
  const before = accepted.length;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  clients.push(ws);
  await new Promise((r) => ws.once("open", r));
  while (accepted.length === before) await sleep(5);
  return { ws, srv: accepted[accepted.length - 1]! };
}
const next = (ws: WebSocket, pred: (m: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
  const t = setTimeout(() => { ws.off("message", on); reject(new Error("timeout waiting for a ws message")); }, ms);
  const on = (raw: unknown) => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (pred(m)) { clearTimeout(t); ws.off("message", on); resolve(m); }
  };
  ws.on("message", on);
});
const subscribe = async (ws: WebSocket, frame: Record<string, unknown>) => {
  const ack = next(ws, (m) => m.ack === true);
  ws.send(JSON.stringify(frame));
  return (await ack).tracking;
};
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");
// Distinct keys of exactly `bytes` UTF-8 bytes (a Set keeps one copy of equal keys).
const domainsOf = (n: number, bytes: number, from = 0) => Array.from({ length: n }, (_, i) => `d${from + i}:`.padEnd(bytes, "x"));

test("a key longer than any an event can carry adds nothing; keys up to that length are tracked", async () => {
  const { ws } = await open();
  const domain128 = "a".repeat(MAX_DOMAIN_BYTES);
  const multibyte128 = "é".repeat(MAX_DOMAIN_BYTES / 2);             // 2 bytes each in UTF-8
  const multibyte129 = "€".repeat(43);                              // 3 bytes each: 129 bytes, 43 characters
  assert.equal(utf8(multibyte128), 128);
  assert.equal(utf8(multibyte129), 129);
  const addr42 = "0x" + "AB".repeat(20), proposal66 = "0x" + "cd".repeat(32);
  const tracking = await subscribe(ws, {
    "track-domain": [domain128, multibyte128, "a".repeat(MAX_DOMAIN_BYTES + 1), multibyte129, "d".repeat(60 * 1024)],
    "track-address": [addr42, addr42 + "0", "0x" + "e".repeat(1000)],
    "track-proposal": [proposal66, proposal66 + "0"],
  });
  assert.deepEqual(tracking, { domains: [domain128, multibyte128], addresses: [addr42.toLowerCase()], proposals: [proposal66], all: false });
  // a lone proposal id over the bound adds nothing either
  assert.deepEqual((await subscribe(ws, { "track-proposal": "p".repeat(67) })).proposals, [proposal66]);
  ws.close();
});

test("HAPPY PATH: a subscriber at the longest keys receives its events and stays connected", async () => {
  const { ws, srv } = await open();
  const domain = "z".repeat(MAX_DOMAIN_BYTES), attester = "0x" + "a1".repeat(20), proposal = "0x" + "9f".repeat(32);
  await subscribe(ws, { "track-domain": [domain], "track-address": [attester], "track-proposal": proposal });
  const gotProposal = next(ws, (m) => m.kind === "proposal");
  bus.emitEvent({ kind: "proposal", txid: "0x01", domain, height: 1, status: "tentative" });
  assert.equal((await gotProposal).domain, domain);
  const gotByAddr = next(ws, (m) => m.kind === "attestation" && m.txid === "0x02");
  bus.emitEvent({ kind: "attestation", txid: "0x02", proposal_id: "0x" + "00".repeat(32), attester, height: 2, status: "tentative" });
  assert.equal((await gotByAddr).attester, attester);
  const gotByProposal = next(ws, (m) => m.kind === "attestation" && m.txid === "0x03");
  bus.emitEvent({ kind: "attestation", txid: "0x03", proposal_id: proposal, attester: "0x" + "b2".repeat(20), height: 3, status: "tentative" });
  assert.equal((await gotByProposal).proposal_id, proposal);
  // unsubscribe-by-close frees the server side
  ws.close();
  await srv.closed;
});

test("a connection holds at most the key cap of keys at the longest length; its ack stays under the outbound bound", async () => {
  const { ws, srv } = await open();
  const cap = CFG.maxSubKeys;
  let tracking: { domains: string[] } = { domains: [] };
  // frames under ws's 64 KiB limit: 400 keys of 128 bytes is about 52 KB of JSON
  for (let from = 0; from < cap + 400; from += 400) tracking = await subscribe(ws, { "track-domain": domainsOf(400, MAX_DOMAIN_BYTES, from) });
  assert.equal(tracking.domains.length, cap, "the count cap holds");
  const held = tracking.domains.reduce((n, d) => n + utf8(d), 0);
  assert.ok(held <= cap * MAX_DOMAIN_BYTES, `held ${held} bytes of domain keys`);
  assert.ok(srv.peak < CFG.maxStreamBuffer, `an ack at the caps is queued whole (peak ${srv.peak})`);
  assert.equal(srv.sock.readyState, WebSocket.OPEN, "a reading client at the caps is not dropped");
  ws.close();
});

test("a client that stops reading and keeps sending tiny frames is dropped at the outbound bound; its queue stays within the bound and one frame", async () => {
  const { ws, srv } = await open();
  const cap = CFG.maxSubKeys;
  for (let from = 0; from < cap; from += 400) await subscribe(ws, { "track-domain": domainsOf(400, MAX_DOMAIN_BYTES, from) });
  // one ack of the whole subscription, as the server serializes it
  const ackBytes = utf8(JSON.stringify({ ack: true, tracking: { domains: domainsOf(cap, MAX_DOMAIN_BYTES), addresses: [], proposals: [], all: false } }));
  (ws as unknown as { _socket: { pause(): void } })._socket.pause();
  // Enough tiny frames to queue many times the bound if nothing stopped it: 2 bytes sent for each ack of about 130 KB.
  const frames = Math.ceil((4 * CFG.maxStreamBuffer) / ackBytes) + 100;
  for (let i = 0; i < frames; i++) ws.send("{}");
  const dropped = await Promise.race([srv.closed.then(() => true), sleep(5000).then(() => false)]);
  console.log(`ws bounds: ${frames} frames of 2 bytes, ack ${ackBytes} bytes; server peak queued ${srv.peak} bytes, ` +
    `bound ${CFG.maxStreamBuffer}; dropped ${dropped}`);
  assert.ok(srv.peak <= CFG.maxStreamBuffer + ackBytes, `queued at most the bound plus the frame that crossed it (peak ${srv.peak})`);
  assert.ok(dropped, "the server dropped the connection");
  assert.equal(srv.sock.bufferedAmount, 0, "the dropped socket holds nothing");
});

test("a track-all client that stops reading is dropped at the outbound bound on the event path too", async () => {
  const { ws, srv } = await open();
  await subscribe(ws, { "track-all": true });
  (ws as unknown as { _socket: { pause(): void } })._socket.pause();
  const event = { kind: "proposal" as const, txid: "0x01", domain: "x".repeat(256 * 1024), height: 1, status: "tentative" as const };
  const frame = utf8(JSON.stringify(event));
  let peak = 0, sent = 0;
  for (; sent < 200 && srv.sock.readyState === WebSocket.OPEN; sent++) {
    bus.emitEvent(event);
    peak = Math.max(peak, srv.sock.bufferedAmount);
    await sleep(2);
  }
  await Promise.race([srv.closed, sleep(2000)]);
  assert.equal(srv.sock.readyState, WebSocket.CLOSED, `dropped after ${sent} events of ${frame} bytes`);
  assert.ok(peak <= CFG.maxStreamBuffer + frame, `queued at most the bound plus one event (peak ${peak})`);
});
