// Streaming layer: SSE firehoses (one-way, auto-reconnect, trivial over HTTP) and
// WebSocket per-client subscriptions (mempool.space model). Both ride the in-process
// event bus the indexer publishes to. Events carry tentative/confirmed status and an
// explicit `reorg` so clients can roll back optimistic state.
import type { Request, Response } from "express";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { MAX_DOMAIN_BYTES } from "@inversealtruism/csd-codec";
import { bus, type IndexEvent } from "./events.js";
import { CFG } from "./config.js";

// Bounds so an unauthenticated public endpoint can't be exhausted by many cheap connections or
// one fat subscribe message (CFG.maxSse, maxWs, maxSubKeys per WS client and category).
const MAX_SSE = CFG.maxSse;
const MAX_WS = CFG.maxWs;
const MAX_SUB_KEYS = CFG.maxSubKeys;
// Per-connection outbound bound, SSE and WS alike. A client that stops reading lets every write queue in the process
// without limit; once a connection's queued bytes pass this bound it is dropped instead.
const MAX_OUT_BUFFER = CFG.maxStreamBuffer;
let sseOpen = 0, wsOpen = 0;

/** The one send rule for both transports: write the frame while the connection is open, then drop the connection if
 *  its queued bytes are past MAX_OUT_BUFFER. A connection holds at most the bound plus the frame that crossed it. */
function boundedSend(c: { open(): boolean; write(s: string): void; queued(): number; drop(): void }): (s: string) => void {
  return (s) => {
    if (!c.open()) return;
    c.write(s);
    if (c.queued() > MAX_OUT_BUFFER) c.drop();
  };
}

// ── SSE: GET /stream/all and /stream/domain/:d ──
export function sseHandler(filter?: (e: IndexEvent) => boolean) {
  return (req: Request, res: Response) => {
    if (sseOpen >= MAX_SSE) { res.status(503).setHeader("Retry-After", "30"); return res.end("too many SSE clients"); }
    sseOpen++;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders?.();
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(ping); off(); sseOpen--; };
    // res.writableLength is Node's in-flight byte estimate. The drop must call cleanup() (not a bare closed=true):
    // cleanup is the idempotent teardown (closed=true + clearInterval(ping) + off() + sseOpen--), so it both stops
    // further sends AND frees the timer/listener/slot; the 'close' handler then no-ops. A bare closed=true would poison
    // cleanup's own `if (closed) return` sentinel and permanently leak the ping timer, bus listener, and SSE slot.
    const send = boundedSend({
      open: () => !closed,
      write: (s) => res.write(s),
      queued: () => res.writableLength,
      drop: () => { cleanup(); try { res.end(); } catch { /* already closing */ } },
    });
    send(`event: hello\ndata: {"ok":true}\n\n`);
    const ping = setInterval(() => send(`: ping\n\n`), 25000);
    const off = bus.onEvent((e) => {
      if (filter && !filter(e)) return;
      send(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    req.on("close", cleanup);
    res.on("close", cleanup);
  };
}

// A key longer than any an event can carry adds nothing, so a connection holds at most MAX_SUB_KEYS keys of the longest
// length per category. The longest: a domain is at most MAX_DOMAIN_BYTES UTF-8 bytes (the node refuses a longer one),
// an attester address is 0x and 40 hex characters, a proposal id is 0x and 64.
const fitsDomain = (k: string) => Buffer.byteLength(k, "utf8") <= MAX_DOMAIN_BYTES;
const fitsAddress = (k: string) => k.length <= 2 + 40;
const fitsProposal = (k: string) => k.length <= 2 + 64;
const capAdd = (set: Set<string>, items: string[], fits: (k: string) => boolean) => {
  for (const x of items) { if (set.size >= MAX_SUB_KEYS) break; if (fits(x)) set.add(x); }
};
// A subscribe field of another type than its documented one adds nothing.
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// Largest subscribe frame; ws refuses a longer one with 1009 before buffering it.
const WS_MAX_FRAME = 64 * 1024;

// ── WebSocket: ws://…/ws with {track-domain:[…]}, {track-address:[…]}, {track-proposal:id} ──
type Sub = { domains: Set<string>; addresses: Set<string>; proposals: Set<string>; all: boolean };

function matches(sub: Sub, e: IndexEvent): boolean {
  if (sub.all) return true;             // track-all clients get every event (handled above)
  if (e.kind === "reorg") return true;  // everyone needs reorgs, even with a narrow subscription
  // CAIRN-IDX-WS-2: block events are intentionally NOT delivered to non-track-all WS clients.
  // There is no per-block WS subscription, and a narrow client (track-domain/address/proposal)
  // only wants the matching proposal/attestation/reorg stream. A client that wants every block
  // sends {track-all:true} (returns above) or uses the SSE GET /stream/blocks firehose. (Was
  // `return sub.all` here, dead since sub.all is already false at this point; made explicit.)
  if (e.kind === "block") return false;
  if (e.kind === "proposal") return sub.domains.has(e.domain);
  if (e.kind === "attestation") return sub.proposals.has(e.proposal_id) || sub.addresses.has(e.attester.toLowerCase());
  return false;
}

export function attachWs(server: Server): WebSocketServer {
  // autoPong off: ws's automatic pong is written outside boundedSend (see the ping listener below).
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: WS_MAX_FRAME, autoPong: false });
  wss.on("connection", (ws: WebSocket) => {
    // First, before the cap's early return: a socket closed with 1013 still has its earlier frames read, and ws emits a
    // protocol error (an oversize or malformed frame) on the socket before closing it with its code.
    ws.on("error", () => { /* ws closes the socket with the error's code itself */ });
    if (wsOpen >= MAX_WS) { ws.close(1013, "too many clients"); return; }
    wsOpen++;
    const sub: Sub = { domains: new Set(), addresses: new Set(), proposals: new Set(), all: false };
    // terminate(), not close(): a close frame would queue behind the bytes the client is not reading.
    const send = boundedSend({
      open: () => ws.readyState === ws.OPEN,
      write: (s) => ws.send(s),
      queued: () => ws.bufferedAmount,
      drop: () => ws.terminate(),
    });
    const off = bus.onEvent((e) => { if (matches(sub, e)) send(JSON.stringify(e)); });
    // A pong echoes the ping's payload and goes out only while nothing is queued for this socket, so a client that
    // pings and never reads holds at most one pong; a ping that meets queued bytes (a large ack, say) gets none.
    ws.on("ping", (data) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount === 0) ws.pong(data); });
    // A throw from these listeners, like an `error` emitted with no listener, is uncaught and ends the process, the sync
    // loop with the API (test/stream.test.ts); a frame that still throws past the shape checks closes its own socket only.
    ws.on("message", (raw) => {
      // ws still emits the rest of a chunk it read before terminate(); a dropped socket's frames are not handled.
      if (ws.readyState !== ws.OPEN) return;
      try {
        let msg: unknown; try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
        const m = msg as Record<string, unknown>;
        if (m["track-all"]) sub.all = true;
        capAdd(sub.domains, list(m["track-domain"]).map(String), fitsDomain);
        capAdd(sub.addresses, list(m["track-address"]).map((a) => String(a).toLowerCase()), fitsAddress);
        const p = m["track-proposal"];
        capAdd(sub.proposals, (Array.isArray(p) ? p : p ? [p] : []).map(String), fitsProposal);
        send(JSON.stringify({ ack: true, tracking: { domains: [...sub.domains], addresses: [...sub.addresses], proposals: [...sub.proposals], all: sub.all } }));
      } catch {
        ws.close(1011, "subscribe frame not handled");
      }
    });
    ws.on("close", () => { off(); wsOpen--; });
    send(JSON.stringify({ hello: true }));
  });
  return wss;
}
