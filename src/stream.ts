// Streaming layer: SSE firehoses (one-way, auto-reconnect, trivial over HTTP) and
// WebSocket per-client subscriptions (mempool.space model). Both ride the in-process
// event bus the indexer publishes to. Events carry tentative/confirmed status and an
// explicit `reorg` so clients can roll back optimistic state.
import type { Request, Response } from "express";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { bus, type IndexEvent } from "./events.js";

// Bounds so an unauthenticated public endpoint can't be exhausted by many cheap connections or
// one fat subscribe message. Tunable via env if a deployment needs more headroom.
const MAX_SSE = Number(process.env.CSD_INDEX_MAX_SSE ?? 500);
const MAX_WS = Number(process.env.CSD_INDEX_MAX_WS ?? 500);
const MAX_SUB_KEYS = Number(process.env.CSD_INDEX_MAX_SUB ?? 1000); // per WS client, per category
let sseOpen = 0, wsOpen = 0;

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
    res.write(`event: hello\ndata: {"ok":true}\n\n`);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    const off = bus.onEvent((e) => {
      if (filter && !filter(e)) return;
      res.write(`event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    req.on("close", () => { clearInterval(ping); off(); sseOpen--; });
  };
}

const capAdd = (set: Set<string>, items: Iterable<string>) => { for (const x of items) { if (set.size >= MAX_SUB_KEYS) break; set.add(x); } };

// ── WebSocket: ws://…/ws with {track-domain:[…]}, {track-address:[…]}, {track-proposal:id} ──
type Sub = { domains: Set<string>; addresses: Set<string>; proposals: Set<string>; all: boolean };

function matches(sub: Sub, e: IndexEvent): boolean {
  if (sub.all) return true;
  if (e.kind === "reorg") return true; // everyone needs reorgs
  if (e.kind === "block") return sub.all;
  if (e.kind === "proposal") return sub.domains.has(e.domain);
  if (e.kind === "attestation") return sub.proposals.has(e.proposal_id) || sub.addresses.has(e.attester.toLowerCase());
  return false;
}

export function attachWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    if (wsOpen >= MAX_WS) { ws.close(1013, "too many clients"); return; }
    wsOpen++;
    const sub: Sub = { domains: new Set(), addresses: new Set(), proposals: new Set(), all: false };
    const off = bus.onEvent((e) => { if (ws.readyState === ws.OPEN && matches(sub, e)) ws.send(JSON.stringify(e)); });
    ws.on("message", (raw) => {
      // bound the message size and the per-client subscription-set growth (DoS hardening)
      const rawLen = Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : (raw as Buffer).length;
      if (rawLen > 64 * 1024) return;
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg["track-all"]) sub.all = true;
      capAdd(sub.domains, (msg["track-domain"] ?? []).map(String));
      capAdd(sub.addresses, (msg["track-address"] ?? []).map((a: any) => String(a).toLowerCase()));
      capAdd(sub.proposals, (msg["track-proposal"] ? [].concat(msg["track-proposal"]) : []).map(String));
      ws.send(JSON.stringify({ ack: true, tracking: { domains: [...sub.domains], addresses: [...sub.addresses], proposals: [...sub.proposals], all: sub.all } }));
    });
    ws.on("close", () => { off(); wsOpen--; });
    ws.send(JSON.stringify({ hello: true }));
  });
  return wss;
}
