// WebSocket bounds: what one /ws connection can make the process hold or do. A subscription key longer than any key an
// event can carry adds nothing, so the keys a connection holds are bounded by the key count cap times the longest key.
// Every frame the server sends (hello, ack, event, pong) is bounded: a client that stops reading is dropped once its
// socket's queued bytes pass the per-connection outbound bound, the rule SSE has (test/sse-overflow.test.ts), and a
// ping is answered only while nothing is queued. A frame that arrives after the drop is not handled. The server runs in
// process (the real attachWs on an ephemeral 127.0.0.1 port) so the test can read the server side of each socket. The
// client cap is 1, so a connection slot that is not freed shows as a refused (1013) next client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { MAX_DOMAIN_BYTES } from "@inversealtruism/csd-codec";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("ws-bounds");
process.env.CSD_INDEX_PG_SCHEMA = "t_ws_bounds";
process.env.CSD_INDEX_MAX_WS = "1";
delete process.env.CSD_INDEX_MAX_SSE_BUFFER;
delete process.env.CSD_INDEX_MAX_SUB;

const { attachWs } = await import("../src/stream.js");
const { bus } = await import("../src/events.js");
const { CFG } = await import("../src/config.js");

const server = createServer();
const wss = attachWs(server);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE_LISTENERS = bus.listenerCount("ev");

// The server side of each connection, with the most bytes its socket held queued right after each frame was handled.
// These listeners are added after attachWs's own, so they run after the server's reply is sent.
type Srv = { sock: WebSocket; peak: number; closed: Promise<void> };
const accepted: Srv[] = [];
wss.on("connection", (sock: WebSocket) => {
  const s: Srv = { sock, peak: 0, closed: new Promise((r) => sock.once("close", () => r())) };
  const sample = () => { s.peak = Math.max(s.peak, sock.bufferedAmount); };
  sock.on("message", sample);
  sock.on("ping", sample);
  accepted.push(s);
});

const clients: WebSocket[] = [];
const raws: Socket[] = [];
test.after(() => { for (const c of clients) c.terminate(); for (const r of raws) r.destroy(); wss.close(); server.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** p's value, or `fallback` after `ms`; the timer is cleared either way. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<T>((r) => { t = setTimeout(() => r(fallback), ms); })]); } finally { clearTimeout(t); }
}
const pauseReading = (ws: WebSocket) => (ws as unknown as { _socket: Socket })._socket.pause();
const clientSocketOpen = (ws: WebSocket) => !(ws as unknown as { _socket: Socket })._socket.destroyed;
async function open(): Promise<{ ws: WebSocket; srv: Srv; first: Promise<string> }> {
  const before = accepted.length;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  clients.push(ws);
  const first = new Promise<string>((r) => { ws.once("message", (m) => r(String(m))); ws.once("close", (c) => r(`close ${c}`)); });
  await new Promise((r) => ws.once("open", r));
  while (accepted.length === before) await sleep(5);
  return { ws, srv: accepted[accepted.length - 1]!, first };
}
/** Ends a test's connection and waits until the server has freed its slot. */
async function finish(ws: WebSocket, srv: Srv) { ws.terminate(); await srv.closed; }
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
const fillDomains = async (ws: WebSocket) => {
  for (let from = 0; from < CFG.maxSubKeys; from += 400) await subscribe(ws, { "track-domain": domainsOf(400, MAX_DOMAIN_BYTES, from) });
  return utf8(JSON.stringify({ ack: true, tracking: { domains: domainsOf(CFG.maxSubKeys, MAX_DOMAIN_BYTES), addresses: [], proposals: [], all: false } }));
};
/** After a drop: the bus listener and the slot are free while the dropped client still holds its socket. */
async function assertReleased(dropped: WebSocket) {
  assert.ok(clientSocketOpen(dropped), "the dropped client still holds its socket");
  assert.equal(bus.listenerCount("ev"), BASE_LISTENERS, "the dropped connection's bus listener is gone");
  const c = await open();
  assert.equal(await c.first, '{"hello":true}', "the slot is free: the next client is served, not refused");
  await finish(c.ws, c.srv);
  dropped.terminate();
}

test("a key longer than any an event can carry adds nothing; keys up to that length are tracked", async () => {
  const { ws, srv } = await open();
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
  await finish(ws, srv);
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
  assert.equal(bus.listenerCount("ev"), BASE_LISTENERS);
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
  await finish(ws, srv);
});

// The largest ack: the key cap full in all three categories, every key at its bound and built only from the 27 control
// characters JSON writes as six bytes (\u00XX; U+0008, U+0009, U+000A, U+000C and U+000D have two-byte escapes), the
// key's index in base 27 first so the keys stay distinct. Six bytes is the most JSON writes for one UTF-16 code unit,
// and every bound admits at least as many code units as it admits UTF-8 bytes of these characters, so no subscription
// gets a larger ack. Returns that ack as text; acks are kept as text (only the last is parsed) so the test holds little.
const SIX_BYTE = Array.from({ length: 32 }, (_, c) => String.fromCharCode(c)).filter((ch) => JSON.stringify(ch).length === 8);
const sixByteKey = (i: number, len: number) => {
  let k = "";
  for (let n = i, d = 0; d < 3; d++, n = Math.floor(n / 27)) k += SIX_BYTE[n % 27];
  return k.padEnd(len, SIX_BYTE[0]);
};
async function fillLargest(ws: WebSocket): Promise<string> {
  let ack: Buffer = Buffer.alloc(0);
  for (const [field, len, per] of [["track-domain", MAX_DOMAIN_BYTES, 80], ["track-address", 42, 240], ["track-proposal", 66, 150]] as const) {
    for (let from = 0; from < CFG.maxSubKeys; from += per) {
      const frame = JSON.stringify({ [field]: Array.from({ length: Math.min(per, CFG.maxSubKeys - from) }, (_, i) => sixByteKey(from + i, len)) });
      assert.ok(frame.length < 64 * 1024, `frame of ${frame.length} bytes`);
      const got = new Promise<Buffer>((r) => ws.once("message", (m) => r(m as Buffer)));
      ws.send(frame);
      ack = await got;
    }
  }
  return ack.toString();
}

test("the largest ack a connection can be sent fits under the outbound bound and reaches a reading client", async () => {
  const { ws, srv, first } = await open();
  assert.equal(await first, '{"hello":true}');
  const cap = CFG.maxSubKeys;
  assert.equal(SIX_BYTE.length, 27);
  assert.equal(JSON.stringify(sixByteKey(cap - 1, MAX_DOMAIN_BYTES)).length, 2 + 6 * MAX_DOMAIN_BYTES);
  assert.equal(utf8(sixByteKey(cap - 1, MAX_DOMAIN_BYTES)), MAX_DOMAIN_BYTES);
  const ack = await fillLargest(ws);
  const t = JSON.parse(ack).tracking;
  assert.deepEqual([t.domains.length, t.addresses.length, t.proposals.length, t.all], [cap, cap, cap, false]);
  const bytes = utf8(ack);
  console.log(`ws bounds: largest ack ${bytes} bytes (${cap} distinct keys per category at the bounds, each character written as 6 bytes); ` +
    `outbound bound ${CFG.maxStreamBuffer}`);
  assert.ok(bytes < CFG.maxStreamBuffer, `the largest ack (${bytes} bytes) is under the bound`);
  assert.equal(srv.sock.readyState, WebSocket.OPEN);
  await finish(ws, srv);
});

test("a client that stops reading and keeps sending tiny frames is dropped at the outbound bound; its queue stays within the bound and one frame; the slot and listener are freed", async () => {
  const { ws, srv } = await open();
  const ackBytes = await fillDomains(ws);
  pauseReading(ws);
  // Enough tiny frames to queue many times the bound if nothing stopped it: 2 bytes sent for each ack of about 130 KB.
  const frames = Math.ceil((4 * CFG.maxStreamBuffer) / ackBytes) + 100;
  for (let i = 0; i < frames; i++) ws.send("{}");
  const dropped = await within(srv.closed.then(() => true), 5000, false);
  console.log(`ws bounds: ${frames} frames of 2 bytes, ack ${ackBytes} bytes; server peak queued ${srv.peak} bytes, ` +
    `bound ${CFG.maxStreamBuffer}; dropped ${dropped}`);
  assert.ok(srv.peak <= CFG.maxStreamBuffer + ackBytes, `queued at most the bound plus the frame that crossed it (peak ${srv.peak})`);
  assert.ok(dropped, "the server dropped the connection");
  assert.equal(srv.sock.bufferedAmount, 0, "the dropped socket holds nothing");
  await assertReleased(ws);
});

test("frames already received when the socket is dropped are not handled: no ack is built for them", async () => {
  const { ws, srv } = await open();
  await fillDomains(ws);
  let afterDrop = 0, acksAfterDrop = 0, dropped = false;
  srv.sock.on("message", () => { if (srv.sock.readyState !== WebSocket.OPEN) afterDrop++; });
  const real = JSON.stringify;
  JSON.stringify = ((v: unknown, ...rest: unknown[]) => {
    if (srv.sock.readyState !== WebSocket.OPEN && v !== null && typeof v === "object" && (v as { ack?: unknown }).ack === true) acksAfterDrop++;
    return (real as (...a: unknown[]) => string)(v, ...rest);
  }) as typeof JSON.stringify;
  const t0 = performance.now();
  try {
    pauseReading(ws);
    // one burst, about 24 KB on the wire, far more frames than it takes to pass the bound
    for (let i = 0; i < 3000; i++) ws.send("{}");
    dropped = await within(srv.closed.then(() => true), 10000, false);
  } finally {
    JSON.stringify = real;
  }
  assert.ok(dropped, "the server dropped the connection");
  const ms = performance.now() - t0;
  console.log(`ws bounds: 3000 frames in one burst; ${afterDrop} emitted after the drop, ${acksAfterDrop} acks built for them; ${ms.toFixed(0)} ms`);
  assert.ok(afterDrop > 0, "the burst reached the server past the drop (the case this test is about)");
  assert.equal(acksAfterDrop, 0, "no ack is serialized for a frame handled after the drop");
  assert.ok(ms < 5000, `the burst is done in ${ms.toFixed(0)} ms`);
  await assertReleased(ws);
});

test("a track-all client that stops reading is dropped at the outbound bound on the event path too; the slot and listener are freed", async () => {
  const { ws, srv } = await open();
  await subscribe(ws, { "track-all": true });
  pauseReading(ws);
  const event = { kind: "proposal" as const, txid: "0x01", domain: "x".repeat(256 * 1024), height: 1, status: "tentative" as const };
  const frame = utf8(JSON.stringify(event));
  let peak = 0, sent = 0;
  for (; sent < 200 && srv.sock.readyState === WebSocket.OPEN; sent++) {
    bus.emitEvent(event);
    peak = Math.max(peak, srv.sock.bufferedAmount);
    await sleep(2);
  }
  await within(srv.closed, 2000, undefined);
  assert.equal(srv.sock.readyState, WebSocket.CLOSED, `dropped after ${sent} events of ${frame} bytes`);
  assert.ok(peak <= CFG.maxStreamBuffer + frame, `queued at most the bound plus one event (peak ${peak})`);
  await assertReleased(ws);
});

// A raw client: the upgrade by hand, then masked frames written straight to the socket, which it never reads.
async function rawClient(): Promise<{ sock: Socket; srv: Srv }> {
  const before = accepted.length;
  const sock = connect(port, "127.0.0.1");
  raws.push(sock);
  await new Promise((r) => sock.once("connect", r));
  sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise<void>((resolve) => {
    let seen = "";
    const on = (b: Buffer) => { seen += b.toString("latin1"); if (seen.includes("\r\n\r\n")) { sock.off("data", on); sock.pause(); resolve(); } };
    sock.on("data", on);
  });
  while (accepted.length === before) await sleep(5);
  return { sock, srv: accepted[accepted.length - 1]! };
}
// A masked client frame with an all-zero mask, so the payload bytes go as they are.
const clientFrame = (opcode: number, payload: Buffer) => Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), Buffer.alloc(4), payload]);

for (const [payloadLen, budget] of [[125, 24 * 1024 * 1024], [0, 1024 * 1024]] as const) {
  test(`a client that never reads and sends only pings of ${payloadLen} bytes queues at most one pong; the socket stays open`, async () => {
    const { sock, srv } = await rawClient();
    try {
      const one = clientFrame(0x9, Buffer.alloc(payloadLen, 0x61));
      const chunk = Buffer.concat(Array.from({ length: Math.floor(60000 / one.length) }, () => one));
      let sent = 0;
      // The flood stops early once the queue is past the bound, so a failing run holds a few MB, not the whole budget.
      while (sent < budget && srv.sock.readyState === WebSocket.OPEN && srv.peak <= CFG.maxStreamBuffer) {
        if (!sock.write(chunk)) await new Promise((r) => sock.once("drain", r));
        sent += chunk.length;
        await new Promise((r) => setImmediate(r));
        srv.peak = Math.max(srv.peak, srv.sock.bufferedAmount);
      }
      await sleep(100);
      console.log(`ws bounds: ${sent} bytes of ${payloadLen}-byte pings from a client that reads nothing; server peak queued ${srv.peak} bytes, ` +
        `now ${srv.sock.bufferedAmount}; readyState ${srv.sock.readyState}`);
      assert.ok(srv.peak <= 2 + payloadLen, `at most one pong (${2 + payloadLen} bytes) queued (peak ${srv.peak})`);
      assert.equal(srv.sock.readyState, WebSocket.OPEN, "the socket is not dropped: its pongs are withheld while anything is queued");
    } finally {
      sock.destroy();
      await srv.closed;
    }
  });
}

test("HAPPY PATH: a reading client that pings while nothing is queued for it gets a pong for each ping, with the ping's payload", async () => {
  const { ws, srv } = await open();
  const pongs: string[] = [];
  ws.on("pong", (d) => { pongs.push(String(d)); });
  const sent = ["hb0", "hb1", "hb2", "hb3", "hb4"];
  for (const p of sent) { ws.ping(Buffer.from(p)); await sleep(20); }
  for (let i = 0; i < 50 && pongs.length < sent.length; i++) await sleep(10);
  assert.deepEqual(pongs, sent);
  await finish(ws, srv);
});

// The stated limit: a ping that arrives while the connection has bytes queued (here right behind two acks of the largest
// size, under the bound together) gets no pong. Whether a given ping meets a queue depends on timing, so the test asserts
// the rule, not a count: every pong was sent with nothing queued, the pongs are the pings' payloads in order, and a ping
// with nothing queued after the rounds is answered.
test("a reading client behind its own queued bytes can miss a pong; no pong is ever queued behind other bytes", async () => {
  const { ws, srv } = await open();
  await fillLargest(ws);
  const queuedAtPong: number[] = [];
  let queuedAtPing = 0;
  srv.sock.on("ping", () => { if (srv.sock.bufferedAmount > 0) queuedAtPing++; });
  const realPong = srv.sock.pong.bind(srv.sock);
  srv.sock.pong = ((...a: Parameters<WebSocket["pong"]>) => { queuedAtPong.push(srv.sock.bufferedAmount); realPong(...a); }) as WebSocket["pong"];
  const pongs: string[] = [];
  ws.on("pong", (d) => { pongs.push(String(d)); });
  const sent: string[] = [];
  for (let i = 0; i < 10; i++) {
    let acks = 0;
    const both = new Promise<void>((r) => {
      const on = (m: Buffer) => { if (m.subarray(0, 6).toString() === '{"ack"' && ++acks === 2) { ws.off("message", on); r(); } };
      ws.on("message", on);
    });
    ws.send("{}"); ws.send("{}");
    sent.push(`p${i}`); ws.ping(Buffer.from(`p${i}`));
    await both;
    await sleep(20);
  }
  ws.ping(Buffer.from("last"));
  for (let i = 0; i < 100 && pongs.at(-1) !== "last"; i++) await sleep(10);
  console.log(`ws bounds: ${sent.length} pings behind two largest acks each: ${queuedAtPing} met a queue, ${pongs.length - 1} answered; ` +
    `queued bytes at each pong sent: ${[...new Set(queuedAtPong)].join(",")}`);
  assert.ok(queuedAtPong.every((q) => q === 0), `every pong was sent with nothing queued (${queuedAtPong.join(",")})`);
  assert.equal(pongs.at(-1), "last", "a ping with nothing queued is answered");
  const answered = pongs.slice(0, -1);
  assert.ok(answered.length <= sent.length);
  let j = 0;
  for (const p of answered) { while (j < sent.length && sent[j] !== p) j++; assert.ok(j++ < sent.length, `pong ${p} echoes a ping, in order`); }
  await finish(ws, srv);
});
