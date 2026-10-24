// SSE outbound-overflow teardown. A client that stops reading makes the server's write buffer grow; past
// CSD_INDEX_MAX_SSE_BUFFER the connection is dropped AND its slot, ping timer and bus listener are freed.
// The overflow branch must run cleanup(): a bare `closed = true` there makes the later 'close' cleanup
// return early, so each overflowed client holds a slot for the life of the process until the cap refuses
// every client. The cap here is 1 slot, so a leaked slot shows up as a 503 for the next client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket, type AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("sse-overflow");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_sseoverflow";
process.env.CSD_INDEX_MAX_SSE = "1";
process.env.CSD_INDEX_MAX_SSE_BUFFER = String(64 * 1024);

const { buildApp } = await import("../src/server.js");
const { bus } = await import("../src/events.js");
const { closeDb } = await import("../src/db.js");

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const port = (srv.address() as AddressInfo).port;
const BASE_LISTENERS = bus.listenerCount("ev");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A raw client that reads up to the hello frame and then stops reading.
async function stalledClient(): Promise<Socket> {
  const sock = connect(port, "127.0.0.1");
  sock.write("GET /stream/all HTTP/1.1\r\nHost: x\r\n\r\n");
  await new Promise<void>((resolve) => {
    let seen = "";
    const on = (b: Buffer) => { seen += b.toString(); if (seen.includes("event: hello")) { sock.off("data", on); sock.pause(); resolve(); } };
    sock.on("data", on);
  });
  return sock;
}
const sseStatus = async (): Promise<number> => {
  const ctrl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${port}/stream/all`, { signal: ctrl.signal });
  ctrl.abort();
  return r.status;
};
const bigEvent = (kb: number) => bus.emitEvent({ kind: "proposal", txid: "0x01", domain: "x".repeat(kb * 1024), height: 1, status: "tentative" });

test("a client that stops reading is dropped past the buffer cap, and its slot and listener are freed", async () => {
  const sock = await stalledClient();
  assert.equal(bus.listenerCount("ev"), BASE_LISTENERS + 1);
  assert.equal(await sseStatus(), 503, "the one slot is held by the stalled client");
  // fill the kernel buffers on both ends, then the server's own write buffer, until the overflow fires
  let sent = 0;
  for (; sent < 400 && bus.listenerCount("ev") > BASE_LISTENERS; sent++) { bigEvent(256); await sleep(5); }
  assert.equal(bus.listenerCount("ev"), BASE_LISTENERS, `torn down at the cap while the client still holds the socket (${sent} events of 256 KB)`);
  assert.equal(await sseStatus(), 200, "the slot is free before the client goes away");
  sock.destroy();
  await sleep(100);
  assert.equal(bus.listenerCount("ev"), BASE_LISTENERS, "the bus listener of the dropped client is gone");
  assert.equal(await sseStatus(), 200, "its SSE slot is free again");
});

test("HAPPY PATH: a client that keeps reading receives every large event and is not dropped", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/stream/all`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const N = 40, KB = 16;   // 640 KB in total, ten times the buffer cap
  let frames = 0, buf = "";
  const dec = new TextDecoder();
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { if (buf.slice(0, i).startsWith("event: proposal")) frames++; buf = buf.slice(i + 2); }
      if (frames === N) return;
    }
  })();
  await sleep(50);
  for (let i = 0; i < N; i++) { bigEvent(KB); await sleep(2); }
  await reading;
  assert.equal(frames, N, "every event arrived");
  assert.equal(bus.listenerCount("ev"), BASE_LISTENERS + 1, "still subscribed");
  ctrl.abort();
  await sleep(100);
  assert.equal(bus.listenerCount("ev"), BASE_LISTENERS, "a normal disconnect frees the listener");
  assert.equal(await sseStatus(), 200, "and the slot");
});

test.after(async () => {
  srv.closeAllConnections(); srv.close(); await closeDb();
  // A leaked ping interval (the failure this file pins) keeps the process alive; end it so a red run fails
  // instead of hanging the runner. Unref'd: on a clean run the process exits before this fires.
  setTimeout(() => process.exit(process.exitCode ?? 1), 2000).unref();
});
