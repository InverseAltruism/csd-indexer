// REST API: the Esplora contract (so existing clients + the L0 light client work
// against it unchanged) plus the CSD-specific extras the thin node omits — merkle
// proofs, per-attester data, domain views, content joins. Every response is a
// derived view; trust comes from the light client re-verifying the merkle proofs.
import express, { type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { CFG, host, port } from "./config.js";
import * as q from "./queries.js";
import { merkleProof } from "./merkle.js";
import { indexedHeight } from "./indexer.js";
import { sseHandler, attachWs } from "./stream.js";

const TXID = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

export function buildApp() {
  const app = express();
  app.set("etag", false);
  app.use((_req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

  const bad = (res: Response, msg: string) => res.status(400).json({ error: msg });
  const nf = (res: Response, msg = "not found") => res.status(404).json({ error: msg });

  // ── health / status ──
  app.get("/health", (_req, res) => res.json({ ok: true, indexed_height: indexedHeight(), ...q.counts() }));

  // ── streaming (SSE firehoses; WebSocket is attached in serve()) ──
  app.get("/stream/all", sseHandler());
  app.get("/stream/blocks", sseHandler((e) => e.kind === "block" || e.kind === "reorg"));
  app.get("/stream/domain/:d", (req, res) => sseHandler((e) =>
    e.kind === "reorg" || (e.kind === "proposal" && e.domain === req.params.d))(req, res));

  // ── Esplora core ──
  app.get("/blocks/tip/height", (_req, res) => res.json(q.tipHeight()));
  app.get("/blocks/tip/hash", (_req, res) => { const b = q.blockByHeight(q.tipHeight()); return b ? res.json(b.hash) : nf(res); });

  app.get("/block-height/:h", (req, res) => {
    const b = q.blockByHeight(Number(req.params.h));
    return b ? res.json(b.hash) : nf(res, "no block at height");
  });
  app.get("/block/:hash", (req, res) => {
    const b = q.blockByHash(req.params.hash);
    return b ? res.json(b) : nf(res, "unknown block");
  });
  app.get("/block/:hash/txids", (req, res) => {
    const b = q.blockByHash(req.params.hash);
    return b ? res.json(q.blockTxids(b.height)) : nf(res, "unknown block");
  });
  app.get("/block/:hash/txs", (req, res) => {
    const b = q.blockByHash(req.params.hash);
    if (!b) return nf(res, "unknown block");
    res.json(q.blockTxids(b.height).map((t) => withVio(q.tx(t)!)));
  });

  // ── tx ──
  app.get("/tx/:id", (req, res) => {
    if (!TXID.test(req.params.id)) return bad(res, "want /tx/0x<64-hex>");
    const t = q.tx(req.params.id);
    if (!t) return nf(res, "unknown tx");
    res.json({ ...withVio(t), outputs: q.txOutputs(t.txid) });
  });
  app.get("/tx/:id/status", (req, res) => {
    const t = q.tx(req.params.id);
    if (!t) return nf(res, "unknown tx");
    const tip = q.tipHeight();
    res.json({ confirmed: true, block_height: t.height, confirmations: tip - t.height + 1, final: tip - t.height + 1 >= CFG.finalDepth });
  });
  // CSD keystone: merkle inclusion proof (Electrum format) for the L0 light client.
  app.get("/tx/:id/merkle-proof", (req, res) => {
    if (!TXID.test(req.params.id)) return bad(res, "want /tx/0x<64-hex>/merkle-proof");
    const p = merkleProof(req.params.id);
    return p ? res.json(p) : nf(res, "unknown tx (not indexed)");
  });

  // ── address ──
  app.get("/address/:a", (req, res) => {
    if (!ADDR.test(req.params.a.toLowerCase())) return bad(res, "want /address/0x<40-hex>");
    res.json({ address: req.params.a.toLowerCase(), chain_stats: q.addressStats(req.params.a) });
  });
  app.get("/address/:a/txs", (req, res) => {
    if (!ADDR.test(req.params.a.toLowerCase())) return bad(res, "want /address/0x<40-hex>");
    res.json(q.addressTxids(req.params.a, null).map((r) => withVio(q.tx(r.txid)!)));
  });
  app.get("/address/:a/txs/chain/:last", (req, res) => {
    const before = Number(req.params.last);
    res.json(q.addressTxids(req.params.a, Number.isFinite(before) ? before : null).map((r) => withVio(q.tx(r.txid)!)));
  });
  app.get("/address/:a/utxo", (req, res) => {
    if (!ADDR.test(req.params.a.toLowerCase())) return bad(res, "want /address/0x<40-hex>");
    res.json(q.addressUtxos(req.params.a).map((o) => ({ txid: o.txid, vout: o.vout, value: o.value, status: { confirmed: true, block_height: o.height } })));
  });

  // ── CSD extras ──
  app.get("/domains", (_req, res) => res.json(q.domains()));
  app.get("/domain/:d/proposals", (req, res) => res.json(q.proposalsByDomain(req.params.d)));
  app.get("/proposal/:id", (req, res) => {
    const p = q.proposal(req.params.id);
    if (!p) return nf(res, "unknown proposal");
    const atts = q.attestationsFor(req.params.id);
    res.json({ ...p, attestation_count: atts.length, attestations: atts });
  });
  app.get("/proposal/:id/attestations", (req, res) => res.json(q.attestationsFor(req.params.id)));
  app.get("/address/:a/reputation", (req, res) => {
    const atts = q.attestationsBy(req.params.a);
    const n = atts.length;
    const avgScore = n ? atts.reduce((s, a) => s + Number(a.score || 0), 0) / n : 0;
    const avgConf = n ? atts.reduce((s, a) => s + Number(a.confidence || 0), 0) / n : 0;
    const feesPaid = atts.reduce((s, a) => s + Number(a.fee || 0), 0);
    res.json({ address: req.params.a.toLowerCase(), attestations: n, avg_score: avgScore, avg_confidence: avgConf, fees_paid: feesPaid });
  });

  // Content join: resolve canonical bytes by payload_hash via the L1 swarm gateway
  // (self-certifying — the gateway re-checks sha256==hash; we just proxy).
  app.get("/content/:hash", async (req, res) => {
    const hash = String(req.params.hash || "").toLowerCase();
    if (!HASH.test(hash)) return bad(res, "want /content/0x<64-hex payload_hash>");
    try {
      const r = await fetch(`${CFG.swarmGateway}/content/${hash}`);
      if (!r.ok) return res.status(r.status).json({ error: "content unavailable via swarm gateway" });
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader("Content-Type", r.headers.get("content-type") || "application/json; charset=utf-8");
      res.setHeader("ETag", `"${hash}"`);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-CSD-Payload-Hash", hash);
      res.send(buf);
    } catch { res.status(502).json({ error: "swarm gateway unreachable" }); }
  });

  return app;
}

// Attach a "violation" flag if a tx references something impossible — currently a
// passthrough; reserved for future consistency annotations (kept for shape stability).
function withVio<T>(t: T): T { return t; }

/** Build the app + HTTP server with WebSocket streaming attached, and start listening. */
export function serve(p = port(), h = host()): Server {
  const server = createServer(buildApp());
  attachWs(server);
  server.listen(p, h, () => console.log(`csd-indexer API on http://${h}:${p}  (Esplora core · merkle-proof · CSD extras · SSE · WS /ws)`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
