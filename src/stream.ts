// Streaming layer: SSE firehoses (one-way, auto-reconnect, trivial over HTTP) and
// WebSocket per-client subscriptions (mempool.space model). Both ride the in-process
// event bus the indexer publishes to. Events carry tentative/confirmed status and an
// explicit `reorg` so clients can roll back optimistic state.
import type { Request, Response } from "express";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { bus, type IndexEvent } from "./events.js";

// ── SSE: GET /stream/all and /stream/domain/:d ──
export function sseHandler(filter?: (e: IndexEvent) => boolean) {
  return (req: Request, res: Response) => {
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
    req.on("close", () => { clearInterval(ping); off(); });
  };
}

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
    const sub: Sub = { domains: new Set(), addresses: new Set(), proposals: new Set(), all: false };
    const off = bus.onEvent((e) => { if (ws.readyState === ws.OPEN && matches(sub, e)) ws.send(JSON.stringify(e)); });
    ws.on("message", (raw) => {
      let msg: any; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg["track-all"]) sub.all = true;
      for (const d of msg["track-domain"] ?? []) sub.domains.add(String(d));
      for (const a of msg["track-address"] ?? []) sub.addresses.add(String(a).toLowerCase());
      for (const p of (msg["track-proposal"] ? [].concat(msg["track-proposal"]) : [])) sub.proposals.add(String(p));
      ws.send(JSON.stringify({ ack: true, tracking: { domains: [...sub.domains], addresses: [...sub.addresses], proposals: [...sub.proposals], all: sub.all } }));
    });
    ws.on("close", off);
    ws.send(JSON.stringify({ hello: true }));
  });
  return wss;
}
