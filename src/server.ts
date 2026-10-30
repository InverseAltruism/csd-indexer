// REST API: the Esplora contract (so existing clients + the L0 light client work
// against it unchanged) plus the CSD-specific extras the thin node omits; merkle
// proofs, per-attester data, domain views. Every response is a
// derived view; trust comes from the light client re-verifying the merkle proofs.
import express, { type Request, type Response } from "express";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { CFG, host, port } from "./config.js";
import { store } from "./db.js";
import * as q from "./queries.js";
import * as analytics from "./analytics.js";
import { merkleProof } from "./merkle.js";
import { indexedHeight } from "./indexer.js";
import { sseHandler, attachWs } from "./stream.js";

const TXID = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;

// Package version, read once at boot. Exposed in /health as the cross-host skew tell (the same
// fix class as cairnx's /cairnx/health version field): version drift between two indexer hosts
// is invisible until responses diverge unless the health surface says what is running.
const PKG_VERSION: string = (() => {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String((JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "unknown");
  } catch { return "unknown"; }
})();

export function buildApp() {
  const app = express();
  app.set("etag", false);
  app.disable("x-powered-by"); // don't advertise Express/version (fingerprinting surface)
  app.use((_req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

  const bad = (res: Response, msg: string) => res.status(400).json({ error: msg });
  const nf = (res: Response, msg = "not found") => res.status(404).json({ error: msg });

  // ── public explorer UI (single self-contained SPA; verifies inclusion in-browser) ──
  const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  app.get("/", (_req, res) => res.sendFile(join(PUBLIC, "explorer.html")));
  app.use("/static", express.static(PUBLIC));

  // async handlers: express 4 doesn't catch a rejected promise, so wrap every handler.
  // Params are typed as plain strings (the routes below only read params they declare).
  type Req = Request<Record<string, string>, unknown, unknown, Record<string, string | undefined>>;
  // CAIRN-IDX-ERR-1: never leak the raw error to a public client; a thrown error here can carry a
  // pg connection string, the failing SQL/schema, or a sqlite file path. Log the full error
  // server-side and return a generic, stable body. Status stays 500 (clients branch on status).
  const fail = (res: Response, e: unknown) => {
    console.error("[csd-indexer] handler error:", e);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  };
  const h = (fn: (req: Req, res: Response) => Promise<unknown>) =>
    (req: Req, res: Response) => { fn(req, res).catch((e) => fail(res, e)); };

  // ── health / status ──
  // Freshness surface (added for multi-host failover): a load balancer or failover client
  // routes/refuses on tip_hash + chainwork + seconds_since_tip, NOT just height; two hosts
  // can sit at equal height on different forks, and a wedged node serves a stale-but-answering
  // tip. All original fields (ok, indexed_height, counts) are preserved; the rest are additive.
  //
  // CAIRN-IDX-FAILOVER-1; TRUST CAVEAT (READ BEFORE ROUTING ON THESE FIELDS):
  // tip_hash / chainwork / tip_height / seconds_since_tip are NODE-REPORTED and are NOT
  // PoW-verified by the indexer. seconds_since_tip is derived from `header.time`, which we
  // store verbatim from the node (indexer.ts writeBlock), so a wedged-but-answering node can
  // forge a fresh-looking tip by lying about chainwork and/or the header timestamp (future- or
  // back-dated). These fields are an OPERATIONAL liveness HINT, not a consensus signal: any
  // consumer that uses them to choose where to route VALUE actions MUST independently cross-check
  // the winning tip against the L0 light client (header PoW + chainwork comparison) and reject a
  // header whose time fails an MTP / max-future-drift sanity bound. Treat a single indexer's
  // /health as untrusted for fork selection.
  // counts() is four COUNT(*) full scans and /health is the failover-LB poll target; memoize it
  // per canonical tip (analytics.memoByTip) so the scans run once per block, not once per poll.
  // The wall-clock freshness fields (seconds_since_tip, stale) stay live: they are computed per
  // hit from the (cheap, index-backed) tip row, never from the memo.
  const countsByTip = analytics.memoByTip(q.counts);
  // /domains is a GROUP BY over the whole proposals table on a public unauthenticated read; memoize per
  // canonical tip like counts so the scan runs once per block, not once per request (event-loop DoS guard).
  const domainsByTip = analytics.memoByTip(q.domains);
  app.get("/health", h(async (_req, res) => {
    const indexed_height = await indexedHeight();
    const tipH = await q.tipHeight();
    const tip = await q.blockByHeight(tipH);
    const now = Math.floor(Date.now() / 1000);
    const seconds_since_tip = tip ? now - Number(tip.time) : null;
    res.json({
      ok: true,
      version: PKG_VERSION,                         // cross-host version-skew tell (additive)
      backend: store().backend,                     // "sqlite" | "postgres"; makes a storage cutover observable
      indexed_height,
      tip_height: tipH,
      tip_hash: tip?.hash ?? null,
      chainwork: tip?.chainwork ?? null,           // decimal string; compare with BigInt across hosts
      seconds_since_tip,                            // wall-clock age of the tip block
      stale: seconds_since_tip == null ? true : seconds_since_tip > CFG.staleSecs,
      final_depth: CFG.finalDepth,
      ...(await countsByTip() as Awaited<ReturnType<typeof q.counts>>),
    });
  }));

  // ── streaming (SSE firehoses; WebSocket is attached in serve()) ──
  app.get("/stream/all", sseHandler());
  app.get("/stream/blocks", sseHandler((e) => e.kind === "block" || e.kind === "reorg"));
  app.get("/stream/domain/:d", (req, res) => sseHandler((e) =>
    e.kind === "reorg" || (e.kind === "proposal" && e.domain === req.params.d!))(req, res));

  // ── Esplora core ──
  // CAIRN-IDX-ERR-3: tipHeight() is -1 on an empty index (nothing indexed yet / pg not yet seeded).
  // Serving the literal -1 as a height misleads clients; report "not ready" (503) instead.
  app.get("/blocks/tip/height", h(async (_req, res) => {
    const tip = await q.tipHeight();
    return tip < 0 ? res.status(503).json({ error: "index not ready" }) : res.json(tip);
  }));
  app.get("/blocks/tip/hash", h(async (_req, res) => { const b = await q.blockByHeight(await q.tipHeight()); return b ? res.json(b.hash) : nf(res); }));
  // Recent blocks in ONE call (newest-first); replaces a client tip→N×(height→hash→block) waterfall.
  // Backed by the existing q.recentBlocks(); rows carry height/hash/tx_count/time for the explorer feed.
  app.get("/blocks/recent", h(async (req, res) => {
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit ?? 12)) || 12));
    res.json(await q.recentBlocks(limit));
  }));

  app.get("/block-height/:h", h(async (req, res) => {
    const b = await q.blockByHeight(Number(req.params.h!));
    return b ? res.json(b.hash) : nf(res, "no block at height");
  }));
  app.get("/block/:hash", h(async (req, res) => {
    const b = await q.blockByHash(req.params.hash!);
    return b ? res.json(b) : nf(res, "unknown block");
  }));
  app.get("/block/:hash/txids", h(async (req, res) => {
    const b = await q.blockByHash(req.params.hash!);
    return b ? res.json(await q.blockTxids(b.height)) : nf(res, "unknown block");
  }));
  app.get("/block/:hash/txs", h(async (req, res) => {
    const b = await q.blockByHash(req.params.hash!);
    if (!b) return nf(res, "unknown block");
    res.json(await q.blockTxs(b.height));
  }));

  // ── tx ──
  // Full tx shape (row + outputs), shared by /tx/:id AND the address tx lists below (the explorer's
  // address page reads the outputs for its delta column). q.txsWithOutputs reads a whole page in two
  // queries, so one request holds at most one pool connection at a time.
  app.get("/tx/:id", h(async (req, res) => {
    if (!TXID.test(req.params.id!)) return bad(res, "want /tx/0x<64-hex>");
    const [t] = await q.txsWithOutputs([req.params.id!]);
    if (!t) return nf(res, "unknown tx");
    res.json(t);
  }));
  app.get("/tx/:id/status", h(async (req, res) => {
    const t = await q.tx(req.params.id!);
    if (!t) return nf(res, "unknown tx");
    const tip = await q.tipHeight();
    // CAIRN-IDX-ERR-3: only report confirmations when the tip is at/above the tx's height.
    // tipHeight() is -1 on an empty index, and an in-flight reorg can briefly leave tip<height:
    // either way `tip - height + 1` would be a misleading large-negative count, so clamp to null.
    const confs = tip >= t.height ? tip - t.height + 1 : null;
    res.json({ confirmed: true, block_height: t.height, confirmations: confs, final: confs != null && confs >= CFG.finalDepth });
  }));
  // CSD keystone: merkle inclusion proof (Electrum format) for the L0 light client.
  app.get("/tx/:id/merkle-proof", h(async (req, res) => {
    if (!TXID.test(req.params.id!)) return bad(res, "want /tx/0x<64-hex>/merkle-proof");
    const p = await merkleProof(req.params.id!);
    return p ? res.json(p) : nf(res, "unknown tx (not indexed)");
  }));

  // ── address ──
  app.get("/address/:a", h(async (req, res) => {
    if (!ADDR.test(req.params.a!.toLowerCase())) return bad(res, "want /address/0x<40-hex>");
    res.json({ address: req.params.a!.toLowerCase(), chain_stats: await q.addressStats(req.params.a!) });
  }));
  // Lifetime count and sum of the coinbase outputs paying the address on the indexed chain; a separate route so
  // /address/:a does not read coinbase_totals.
  app.get("/address/:a/coinbase", h(async (req, res) => {
    if (!ADDR.test(req.params.a!.toLowerCase())) return bad(res, "want /address/0x<40-hex>/coinbase");
    const t = await q.addressCoinbase(req.params.a!);
    return t.indexed_height == null ? res.status(503).json({ error: "index not ready" }) : res.json(t);
  }));
  app.get("/address/:a/txs", h(async (req, res) => {
    if (!ADDR.test(req.params.a!.toLowerCase())) return bad(res, "want /address/0x<40-hex>");
    const ids = await q.addressTxids(req.params.a!, null);
    res.json(await q.txsWithOutputs(ids.map((r) => r.txid)));
  }));
  app.get("/address/:a/txs/chain/:last", h(async (req, res) => {
    // Esplora `/address/:addr/txs/chain/:last_seen_txid`; page by the last-seen TXID (not a raw height).
    // CAIRN-IDX PAGINATION-DATALOSS-1 + PG-2/PGDIV-1: the prior impl used `Number(:last)` as a height-only
    // cursor, which (a) dropped same-height txids past the page limit and (b) on Postgres raised a 500 for a
    // fractional/out-of-range value. Resolving the cursor txid's height and paging the full (height, txid)
    // keyset fixes both; an unknown/ill-formed cursor returns an empty page (end-of-pages), never a crash.
    if (!ADDR.test(req.params.a!.toLowerCase())) return bad(res, "want /address/0x<40-hex>");
    const last = String(req.params.last!).toLowerCase();
    if (!TXID.test(last)) return bad(res, "want /address/0x<40-hex>/txs/chain/<last-seen txid 0x-64hex>");
    const h0 = await q.addressTxidHeight(req.params.a!, last);
    if (h0 == null) return res.json([]); // cursor txid not in this address's history → no further pages
    const ids = await q.addressTxids(req.params.a!, { height: h0, txid: last });
    res.json(await q.txsWithOutputs(ids.map((r) => r.txid)));
  }));
  app.get("/address/:a/utxo", h(async (req, res) => {
    if (!ADDR.test(req.params.a!.toLowerCase())) return bad(res, "want /address/0x<40-hex>");
    res.json((await q.addressUtxos(req.params.a!)).map((o) => ({ txid: o.txid, vout: o.vout, value: o.value, status: { confirmed: true, block_height: o.height } })));
  }));

  // ── CSD extras ──
  app.get("/domains", h(async (_req, res) => res.json(await domainsByTip())));
  app.get("/domain/:d/proposals", h(async (req, res) => res.json(await q.proposalsByDomain(
    req.params.d!, Number(req.query.limit) || 100,
    req.query.from !== undefined ? Number(req.query.from) : undefined))));
  app.get("/proposal/:id", h(async (req, res) => {
    const p = await q.proposal(req.params.id!);
    if (!p) return nf(res, "unknown proposal");
    const atts = await q.attestationsFor(req.params.id!);
    // atts is capped; report the AUTHORITATIVE count + a truncation flag so a consumer of this inline list
    // is not misled (the COMPLETE list is the keyset-paginated /proposal/:id/attestations endpoint).
    const attestation_count = await q.attestationCountFor(req.params.id!);
    res.json({ ...p, attestation_count, attestation_count_truncated: attestation_count > atts.length, attestations: atts });
  }));
  // Keyset-paginated so a consumer (the CairnX resolver) can fetch the COMPLETE attestation list in
  // bounded pages: pass ?after_height=&after_txid= from the last row of the previous page until a page
  // returns < limit rows. Without a cursor it returns the first `limit` (default 5k) in (height,txid) order.
  app.get("/proposal/:id/attestations", h(async (req, res) => {
    const num = (v: unknown) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
    res.json(await q.attestationsFor(req.params.id!, {
      limit: num(req.query.limit),
      afterHeight: num(req.query.after_height),
      afterTxid: req.query.after_txid !== undefined ? String(req.query.after_txid) : undefined,
    }));
  }));
  // Chain-order feeds for a consumer that replays records as a block scanner would (README "The API").
  app.get("/blocks/at-or-after/:time", h(async (req, res) => {
    if (!/^\d+$/.test(req.params.time!)) return bad(res, "want /blocks/at-or-after/<unix seconds>");
    const b = await q.blockAtOrAfter(Number(req.params.time!));
    return b ? res.json(b) : nf(res, "no block at or after that time");
  }));
  const feed = (kind: q.FeedKind) => h(async (req, res) => {
    const { domain, at, after, limit } = req.query as Record<string, unknown>;
    if (domain !== undefined && typeof domain !== "string") return bad(res, "want one domain");
    const atM = at === undefined ? null : /^(\d+)(?::(0x[0-9a-fA-F]{64}))?$/.exec(String(at));
    if (at !== undefined && (!atM || !Number.isSafeInteger(Number(atM[1])))) return bad(res, "want at=<height> or at=<height>:<block hash>");
    const afterM = after === undefined ? null : /^(\d+):(\d+)$/.exec(String(after));
    if (after !== undefined && (!afterM || !Number.isSafeInteger(Number(afterM[1])) || !Number.isSafeInteger(Number(afterM[2])))) {
      return bad(res, "want after=<height>:<position in block>");
    }
    if (afterM && !atM?.[2]) return bad(res, "after needs at=<height>:<block hash> from the first page's answer");
    const n = Math.floor(Number(limit));
    const lim = Number.isFinite(n) && n >= 1 ? Math.min(n, q.FEED_LIMIT_MAX) : q.FEED_LIMIT_MAX;
    const page = await q.feedPage(kind, {
      domain: domain ?? null,
      at: atM ? { height: Number(atM[1]), hash: atM[2] ?? null } : null,
      after: afterM ? { height: Number(afterM[1]), pos: Number(afterM[2]) } : null,
      limit: lim,
    });
    if (!page.ok) {
      return page.reason === "empty-index"
        ? res.status(503).json({ error: "index not ready" })
        : res.status(409).json({ error: "the snapshot block is no longer on the indexed chain; start again without after" });
    }
    const last = page.rows[page.rows.length - 1];
    res.json({ at: page.at, rows: page.rows, next: page.rows.length === lim && last ? `${last.height}:${last.pos}` : null });
  });
  app.get("/proposals", feed("proposals"));
  app.get("/attestations", feed("attestations"));
  // Aggregates over the newest REPUTATION_WINDOW attestations; one extra row tells whether older ones exist,
  // and then `truncated` is true and `note` names the window, so the figures are not read as lifetime totals.
  app.get("/address/:a/reputation", h(async (req, res) => {
    const rows = await q.attestationsBy(req.params.a!, q.REPUTATION_WINDOW + 1);
    const truncated = rows.length > q.REPUTATION_WINDOW;
    const atts = truncated ? rows.slice(0, q.REPUTATION_WINDOW) : rows;
    const n = atts.length;
    const avgScore = n ? atts.reduce((s, a) => s + Number(a.score || 0), 0) / n : 0;
    const avgConf = n ? atts.reduce((s, a) => s + Number(a.confidence || 0), 0) / n : 0;
    const feesPaid = atts.reduce((s, a) => s + Number(a.fee || 0), 0);
    res.json({
      address: req.params.a!.toLowerCase(), attestations: n, avg_score: avgScore, avg_confidence: avgConf, fees_paid: feesPaid,
      truncated, ...(truncated ? { note: `newest ${q.REPUTATION_WINDOW} attestations only` } : {}),
    });
  }));

  // All-time coinbase totals per address from coinbase_totals, most outputs first.
  app.get("/miners/coinbase", h(async (req, res) => {
    const raw = req.query.limit;
    if (raw !== undefined && !/^\d+$/.test(String(raw))) return bad(res, `want limit=<1..${q.COINBASE_MINERS_LIMIT_MAX}>`);
    const n = raw === undefined ? q.COINBASE_MINERS_LIMIT_MAX : Number(raw);
    if (n < 1) return bad(res, `want limit=<1..${q.COINBASE_MINERS_LIMIT_MAX}>`);
    const page = await q.coinbaseMiners(Math.min(n, q.COINBASE_MINERS_LIMIT_MAX));
    return page.indexed_height == null ? res.status(503).json({ error: "index not ready" }) : res.json(page);
  }));

  // ── miner / holder / supply analytics (read-only aggregates; see src/analytics.ts) ──
  app.get("/analytics/miners", h(async (req, res) => res.json(await analytics.miners(String(req.query.window ?? "1d")))));
  app.get("/analytics/richlist", h(async (req, res) => res.json(await analytics.richlist(Number(req.query.limit ?? 100)))));
  app.get("/analytics/supply", h(async (_req, res) => res.json(await analytics.supply())));
  // CoinMarketCap-style supply reads: the body is only the figure in whole CSD; an empty index answers 503 without one.
  const supplyText = (pick: (f: analytics.SupplyFigures) => bigint) => h(async (_req, res) => {
    const f = await analytics.supplyFigures();
    if (!f) return res.status(503).type("text/plain").send("index not ready");
    return res.type("text/plain").send(analytics.csdDecimal(pick(f)));
  });
  app.get("/analytics/supply/total", supplyText((f) => f.total));
  app.get("/analytics/supply/circulating", supplyText((f) => f.circulating));
  app.get("/analytics/series", h(async (req, res) => res.json(await analytics.series(String(req.query.window ?? "1d"), Number(req.query.points ?? 56)))));

  return app;
}

/** Build the app + HTTP server with WebSocket streaming attached, and start listening. */
export function serve(p = port(), h = host()): Server {
  const server = createServer(buildApp());
  attachWs(server);
  server.listen(p, h, () => console.log(`csd-indexer API on http://${h}:${p}  (Esplora core · merkle-proof · CSD extras · SSE · WS /ws)`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
