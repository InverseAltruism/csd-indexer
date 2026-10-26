// The explorer in a real browser, served the way cairn's front door serves it (at /explorer, a nonce on its inline
// script, the explorer CSP of cairn src/server.ts), every read stubbed: the indexer's reads, the resolver's lists and
// verdicts, cairn's /content, and /api/market/* fresh, stale and off as 503. Cairn's chart module is replaced by
// test/fixtures/chart-stub.js, which implements only the exports the page calls, so these tests check the page's own
// wiring (what it passes the module, where it puts the results, when it mounts and destroys charts); the module's
// rendering is tested in cairn. No test reads cairn's tree. At 390 and 1280 px: no page error, the failed requests
// named, no horizontal overflow, a chart in every host, each USD figure with its basis and source, the stale age
// passed on, no USD text with the market off, never NaN or a 0 USD; the hashrate window from the module in the tile
// and on the chart; the request cadence; no chart of a replaced view left alive; the verdict reads and their
// fallback; an Attest on an offer worded by its verdict; the name page's primary badge from the resolver's pick; the
// proposal page's content check; the indexer's state beside the search; the home's activity ledger; a miss told apart
// from a failed read; the design direction's colour rule on every view; a new block's entrance.
// Needs playwright-core (PLAYWRIGHT_CORE or the devDependency) and a Chromium (PLAYWRIGHT_CHROMIUM or the build that
// playwright-core installs, chromium_headless_shell-1243); without either the file skips by name, and with
// EXPLORER_BROWSER_REQUIRED=1 (CI) it fails instead. Run: npx tsx --test test/explorer-browser.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const EXPLORER = fileURLToPath(new URL("../public/explorer.html", import.meta.url));
const CHART_STUB = fileURLToPath(new URL("./fixtures/chart-stub.js", import.meta.url));
// /trade's trustLevel stand-in (cairn's /trade/discover.js), as the chart module's
const TRUST_STUB = fileURLToPath(new URL("./fixtures/trust-stub.js", import.meta.url));
// Cairn's shell set (/ui/*, /header.js, /footer.js) is served from test/fixtures/ui/, stand-ins with only what the page and
// these tests read; with S.shell false every one of them answers 404 as the indexer does on a direct hit.
const UI = (f: string) => fileURLToPath(new URL(`./fixtures/ui/${f}`, import.meta.url));
const SHELL: Record<string, [string, string]> = {
  "/ui/theme-init.js": [UI("theme-init.js"), "text/javascript"], "/ui/theme.js": [UI("theme.js"), "text/javascript"],
  "/ui/tokens.css": [UI("tokens.css"), "text/css"], "/ui/fonts.css": [UI("empty.css"), "text/css"], "/ui/theme.css": [UI("empty.css"), "text/css"],
  "/ui/components.css": [UI("components.css"), "text/css"], "/header.js": [UI("header.js"), "text/javascript"],
};

// playwright-core is loaded untyped, and the page callbacks below run in the browser (this file has no DOM lib):
// `any` at those two boundaries only.
declare const document: any, location: any, innerWidth: number, getComputedStyle: any, navigator: any, window: any, Document: any, Element: any;
let chromium: any = null, why = "";
try { chromium = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core").chromium; }
catch { why = "playwright-core not found (set PLAYWRIGHT_CORE to its path)"; }
let browser: any = null;
if (!why) {
  try { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ["--no-sandbox"] }); }
  catch (e) { why = `no Chromium for playwright-core (set PLAYWRIGHT_CHROMIUM): ${String((e as Error).message).split("\n")[0]}`; }
}

test("a browser is present when EXPLORER_BROWSER_REQUIRED=1", { skip: process.env.EXPLORER_BROWSER_REQUIRED !== "1" }, () => {
  assert.equal(why, "", "the browser tests would skip");
});

// ── fixtures: a 121 s chain with a little jitter, the shapes of the live reads ──
const NOW = Math.floor(Date.now() / 1000), TIP = 121_800, MINER = "0x40379fb123bec901080bb94deeda2f457062b7bd";
const bt = (h: number) => NOW - (TIP - h) * 121 + ((h % 7) - 3) * 10;
const iso = (s: number) => new Date(s * 1000).toISOString();
// a block hash as the chain has them: twelve leading zeros, then digits
const bhash = (h: number) => "0x" + "0".repeat(12) + createHash("sha256").update(`block ${h}`).digest("hex").slice(0, 52);
const block = (h: number) => ({ height: h, hash: bhash(h), prev: bhash(h - 1),
  merkle: "0x" + "ab".repeat(32), time: bt(h), bits: 453035574, nonce: 1, version: 1, tx_count: 1, chainwork: String(BigInt(h) * 10n ** 15n), orphaned: 0 });
// S.newer: blocks mined above the fixture's tip since the page opened (a poll then finds them)
const recent = (n: number) => Array.from({ length: n }, (_, i) => block(TIP + S.newer - i));
const FROM = TIP - 720;
const SERIES = { window: "1d", from: FROM, to: TIP, points: Array.from({ length: 56 }, (_, k) => {
  const h = FROM + Math.round(((k + 1) * 720) / 56), p = FROM + Math.round((k * 720) / 56);
  return { t: bt(h), height: h, ghs: 3000 + 400 * Math.sin(k / 5), difficulty: 3.6e14, intervalSecs: (bt(h) - bt(p)) / (h - p) };
}) };
const MINERS = { ok: true, window: "1d", from_height: FROM, to_height: TIP, blocks: 720, total_txs: 900, total_fees: 0, avg_interval_secs: 121,
  network_hashrate: 3.149e12, miner_count: 1, concentration: { top1: 1, top3: 1, hhi: 1 },
  miners: [{ addr: MINER, blocks: 720, share: 1, last_height: TIP, last_time: bt(TIP), fees_collected: "0", est_hashrate: 3.149e12, est_rel_err: 0.04 }] };
const INDEXER: Record<string, unknown> = {
  "/health": { ok: true, version: "0.2.13", backend: "sqlite", indexed_height: TIP, tip_height: TIP, seconds_since_tip: 60, stale: false, final_depth: 6,
    blocks: TIP + 1, txs: 147_000, proposals: 2300, attestations: 350 },
  "/analytics/supply": { ok: true, height: TIP, emitted_supply: "609005000000000", max_supply: "10511999988436800", pct_emitted: 5.79, block_reward: "5000000000",
    halving: { era: 0, interval: 1051200, next_height: 1051200, blocks_remaining: 929400, est_seconds_remaining: 111528000, next_reward: "2500000000" } },
  "/analytics/miners": MINERS,
  "/analytics/richlist": { ok: true, height: TIP, holders: [{ rank: 1, addr: MINER, balance: "375062706850941", utxos: 9, pct_of_emitted: 61.5 }] },
  "/analytics/series": SERIES,
  "/domain/cairnx:v1/proposals": [],
};
const VWAP = 0.0594, EMITTED = 6_090_050, MAX = 105_119_999.884368;
// the last price the market body carries; a test moves it to see a figure change
const PRICE = { last: 0.0455 };
function csdBody(): unknown {
  const age = S.market === "stale" ? 40 * 60 : 60;
  const base = { ok: true, pair: "CSD/USD", quote: "USDT", price: { last: PRICE.last, at: iso(NOW - age), source: "safetrade" }, range24h: { low: 0.023, high: 0.0899 },
    change24h: null, stale: S.market === "stale", ageSecs: age, fallback: false, disagree: false, dropped: [] };
  const full = { ...base, vwap24h: VWAP, volume24h: { usd: 25620.23, csd: 431012.5 }, supply: { emitted: EMITTED, max: MAX, height: TIP, at: iso(NOW - 30) },
    marketCap: { usd: EMITTED * VWAP, basis: "vwap24h" }, fdv: { usd: MAX * VWAP, basis: "vwap24h" } };
  if (S.thin) return { ...base, vwap24h: null, volume24h: { usd: null, csd: null }, supply: null, marketCap: null, fdv: null };
  // a range without its low and a supply without its emitted figure (Number(null) is 0, so a careless page prints 0)
  if (S.partial) return { ...full, range24h: { low: null, high: 0.0899 }, supply: { ...full.supply, emitted: null } };
  return full;
}
const day0 = NOW - (NOW % 86_400);
const csdSeries = (q: URLSearchParams) => ({ ok: true, pair: "csd-usd", period: q.get("period"), range: q.get("range"), source: "coinpaprika",
  points: Array.from({ length: 30 }, (_, i) => { const c = 0.045 + 0.01 * Math.sin(i / 4); return [day0 - (29 - i) * 86_400, c, c * 1.04, c * 0.96, c, 9000]; }) });

const S = { market: "fresh" as "fresh" | "stale" | "off", thin: false, partial: false, series: true, records: "on" as "on" | "404" | "400" | "500", gates: true, shell: true,
  // the indexer's /health as live, at an old tip, behind the node, or not answering; a path prefix the indexer fails with a 500
  health: "live" as "live" | "old" | "behind" | "down", fail: "", newer: 0,
  // the resolver behind the front door: answering, not answering (the front door's 502), or before its first scan (503)
  cx: "up" as "up" | "502" | "503",
  // a path prefix the resolver alone fails with a 500 (the others answer)
  cxFail: "",
  // /domain/:d/proposals honouring its limit (newest 100 by default) as the indexer does; cairn's avatar module and
  // /trade's verified-token list present or absent
  paged: false, avatar: true, trust: true };
// /trade/verified-tokens.json as cairn serves it: the tokens Cairn lists, bound to their deploys, and the look-alike tickers
const TRUST_LIST: { verified: Record<string, { name?: string; deployId?: string }>; impersonated: string[] } = { verified: {}, impersonated: ["BTC"] };
// CairnX proposals in the shapes of /domain/:d/proposals, and the resolver's verdicts for them: one refused mint
const cxProp = (n: number, uri: object) => ({ txid: "0x" + n.toString(16).padStart(64, "0"), height: TIP - n, proposer: MINER, fee: 25000000, domain: "cairnx:v1", uri: JSON.stringify(uri) });
const PROPS = Array.from({ length: 130 }, (_, i) => cxProp(i + 1, { v: 1, t: "mint", ticker: "CAIRN", amount: "100" }));
const REFUSED = PROPS[0]!.txid;
const VERDICTS: Record<string, { kind: string; applied: boolean; note: string; height: number }> = Object.fromEntries(PROPS.map((p, i) =>
  [p.txid, { kind: "mint", applied: i !== 0, note: i === 0 ? "mint past supply" : "", height: p.height }]));
/** The resolver's applied verdicts for these records (the domain page's word-for-effect needs one). */
const applied = (...ps: { txid: string; height: number }[]) => { for (const p of ps) VERDICTS[p.txid] = { kind: "x", applied: true, note: "", height: p.height }; };
const RECORD_READS: number[] = [];
// The resolver's V25 gate height in /cairnx/health's `gates`, placed between the fixture records' heights.
const V25_AT = TIP - 950;
// An address whose Propose txs are cairnx records: 25 on the first page, 25 more behind "load more", the refused
// mint on the second page.
const WALLET = "0x" + "77".repeat(20);
const txRow = (p: { txid: string; height: number }) => ({ txid: p.txid, height: p.height, pos: 1, app_type: "Propose", signer: WALLET, fee: 25000000,
  time: bt(p.height), n_in: 1, n_out: 1, coinbase: false, outputs: [] });
const PAGE1 = PROPS.slice(1, 26), PAGE2 = [PROPS[0]!, ...PROPS.slice(26, 50)];
// Attests on CairnX offers in the shapes of the node's /tx (the app's score, confidence and proposal id) and the
// indexer's /tx, with the resolver's verdicts: F's live refused fill (1.255 CSD paid, "offer filled") and refused cancel,
// their applied counterparts, an applied claim and token swap, and a fill the resolver has no verdict for (404).
const SELLER = "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec", BUYER = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
const OFFER = cxProp(970, { v: 1, t: "offer", give: { ticker: "CAIRN", amount: "100000000" }, want: { value: 125500000 } });
const SWAP = cxProp(971, { v: 1, t: "offer", give: { ticker: "CAIRN", amount: "100" }, want: { ticker: "QTOK", amount: "12345" } });
type Verdict = { kind: string; applied: boolean; note: string | null };
const att = (n: number, pid: string, score: number, confidence: number, verdict: Verdict | null) =>
  ({ txid: "0x" + (0xa000 + n).toString(16).padStart(64, "0"), height: TIP - 40 - n, pid, score, confidence, verdict });
const ATTESTS = {
  refusedFill: att(1, OFFER.txid, 100, 100, { kind: "fill", applied: false, note: "offer filled" }),
  fill: att(2, OFFER.txid, 100, 100, { kind: "fill", applied: true, note: null }),
  refusedCancel: att(3, OFFER.txid, 0, 0, { kind: "cancel", applied: false, note: "offer cancelled" }),
  cancel: att(4, OFFER.txid, 0, 0, { kind: "cancel", applied: true, note: null }),
  claim: att(5, OFFER.txid, 50, 0, { kind: "claim", applied: true, note: null }),
  swap: att(6, SWAP.txid, 100, 1_000_000, { kind: "fill", applied: true, note: null }),
  unread: att(7, OFFER.txid, 100, 100, null),
};
type Attest = (typeof ATTESTS)[keyof typeof ATTESTS];
const attPaid = (a: Attest) => (a.score === 100 && a.confidence === 100 ? 125500000 : 0);
const attTx = (a: Attest) => ({ txid: a.txid, height: a.height, pos: 3, app_type: "Attest", signer: BUYER, fee: 5000000, time: bt(a.height), n_in: 1, n_out: 2, coinbase: 0,
  outputs: [{ txid: a.txid, vout: 0, addr: SELLER, value: attPaid(a) }, { txid: a.txid, vout: 1, addr: BUYER, value: 1368000000 }] });
const ATT_BY_ID = new Map(Object.values(ATTESTS).map((a) => [a.txid, a]));
for (const a of Object.values(ATTESTS)) if (a.verdict) VERDICTS[a.txid] = { ...a.verdict, note: a.verdict.note ?? "", height: a.height };
// The resolver's primary names (/cairnx/primaries), for the address labels; a test that needs one sets it.
const PRIMARIES: Record<string, string> = {};
// the domain's total in /domains while S.paged (the indexer's count, above the 100 a read shows)
let PAGED_TOTAL: number | null = null;
// Two names of one owner that both point at the owner: the resolver's primary pick (/cairnx/primary) is "solo".
const NAMES: Record<string, unknown> = {
  twin: { ok: true, name: "twin", owner: MINER, addr: MINER, height: TIP - 30, effectiveHeight: TIP - 30, lease: {}, offer: { give: { name: "twin" }, want: { ticker: "QTOK", amount: "12345" } } },
  solo: { ok: true, name: "solo", owner: MINER, addr: MINER, height: TIP - 31, effectiveHeight: TIP - 31, lease: {}, offer: null },
};
function ADDRESS(k: string, _q: URLSearchParams): unknown {
  if (k === `/address/${BUYER}`) return { address: BUYER, chain_stats: { balance: 0, funded: 0, spent: 0, tx_count: ATT_BY_ID.size } };
  if (k === `/address/${BUYER}/utxo`) return [];
  if (k === `/address/${BUYER}/txs`) return Object.values(ATTESTS).map(attTx);
  if (k.startsWith("/tx/") && ATT_BY_ID.has(k.slice(4))) return attTx(ATT_BY_ID.get(k.slice(4))!);
  if (k === `/address/${WALLET}`) return { address: WALLET, chain_stats: { balance: 0, funded: 0, spent: 0, tx_count: 50 } };
  if (k === `/address/${WALLET}/utxo`) return [];
  if (k === `/address/${WALLET}/txs`) return PAGE1.map(txRow);
  if (k === `/address/${WALLET}/txs/chain/${PAGE1[PAGE1.length - 1]!.txid}`) return PAGE2.map(txRow);
  const prop = k.startsWith("/proposal/") ? [...PROPS, ...Object.values(CONTENT_PROPS), OFFER, SWAP].find((p) => p.txid === k.slice(10)) : undefined;
  return prop ?? undefined;
}
// Proposals whose content cairn's /content serves: honest JSON, honest bytes that are not UTF-8, bytes that do not
// hash to the payload hash, and a hash cairn does not hold (404).
const sha = (b: Buffer) => "0x" + createHash("sha256").update(b).digest("hex");
const GOOD = Buffer.from('{"v":1,"t":"peer"}'), BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0xc3]);
const CONTENT = new Map<string, Buffer>([[sha(GOOD), GOOD], [sha(BINARY), BINARY], [sha(Buffer.from("claimed")), Buffer.from("served instead")]]);
const contentProp = (n: number, payload_hash: string) => ({ txid: "0x" + (0xc0 + n).toString(16).padStart(64, "0"), domain: "csd:test", payload_hash, uri: "",
  proposer: MINER, fee: 25000000, expires_epoch: 5000, height: TIP - n, attestation_count: 0, attestation_count_truncated: false, attestations: [] as unknown[] });
// How the stub answers some hashes instead of cairn's 200 with its X-CSD-Payload-Hash header: an edge or app-shell
// HTML 200, a 200 naming another hash, cairn's 200 without the header, a 502, a dropped connection.
const ODD = new Map<string, "html" | "other" | "noheader" | "502" | "drop">([[sha(Buffer.from("edge")), "html"], [sha(Buffer.from("other")), "other"],
  [sha(GOOD).replace(/.$/, "0"), "502"], [sha(Buffer.from("drop")), "drop"]]);
const NOHEADER = sha(Buffer.from("plain bytes"));
CONTENT.set(NOHEADER, Buffer.from("plain bytes"));
ODD.set(NOHEADER, "noheader");
const CONTENT_PROPS = { good: contentProp(1, sha(GOOD)), binary: contentProp(2, sha(BINARY)), tampered: contentProp(3, sha(Buffer.from("claimed"))),
  absent: contentProp(4, sha(Buffer.from("not held"))), edgeHtml: contentProp(5, sha(Buffer.from("edge"))), otherHash: contentProp(6, sha(Buffer.from("other"))),
  noHeader: contentProp(7, NOHEADER), upperCase: contentProp(8, "0x" + sha(GOOD).slice(2).toUpperCase()), e502: contentProp(9, sha(GOOD).replace(/.$/, "0")),
  dropped: contentProp(10, sha(Buffer.from("drop"))), noHash: contentProp(11, "") };
const REQS: string[] = [];
const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(body));
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let p: string;
  // a malformed escape: the indexer's express answers 400
  try { p = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: "bad request" }); }
  REQS.push(p);
  if (p === "/explorer" || p === "/") {
    // as cairn src/server.ts serves /explorer: the first <script> stamped with a per-response nonce, and this CSP
    const nonce = randomBytes(16).toString("base64");
    const html = (await readFile(EXPLORER, "utf8")).replace(/<script>/, `<script nonce="${nonce}">`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy":
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` });
    return res.end(html);
  }
  if (p === "/explorer/api/stream/blocks" || p === "/stream/blocks") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.write(": open\n\n");
    return void req.on("close", () => res.end());
  }
  const api = p.startsWith("/explorer/api/") ? p.slice(13) : null;
  if (api !== null || ["/health", "/domains", "/blocks/recent"].includes(p) || p.startsWith("/analytics/") || p.startsWith("/domain/") || p.startsWith("/proposal/")) {
    const k = api ?? p;
    if (S.fail && k.startsWith(S.fail)) return json(res, 500, { error: "internal" });
    if (k === "/health" && S.health !== "live") {
      if (S.health === "down") return json(res, 503, { error: "unavailable" });
      const h = INDEXER["/health"] as Record<string, unknown>;
      return json(res, 200, S.health === "old" ? { ...h, seconds_since_tip: 1260, stale: true } : { ...h, tip_height: TIP + 7 });
    }
    if (k === "/blocks/recent") return json(res, 200, recent(Number(url.searchParams.get("limit") || 12)));
    // the indexer's domains are those its proposals name, with their counts
    if (k === "/domains") { const n = (INDEXER["/domain/cairnx:v1/proposals"] as unknown[]).length; return json(res, 200, n ? [{ domain: "cairnx:v1", proposals: S.paged ? PAGED_TOTAL ?? n : n }] : []); }
    if (S.paged && k.startsWith("/domain/") && k.endsWith("/proposals") && k in INDEXER) return json(res, 200, (INDEXER[k] as unknown[]).slice(0, Math.min(10_000, Number(url.searchParams.get("limit")) || 100)));
    // a domain the indexer has no proposals in: an empty list, as the indexer answers
    if (k.startsWith("/domain/") && k.endsWith("/proposals") && !(k in INDEXER)) return json(res, 200, []);
    if (k === "/analytics/series" && !S.series) return json(res, 404, { error: "not found" });
    const addr = ADDRESS(k, url.searchParams);
    if (addr !== undefined) return json(res, 200, addr);
    return k in INDEXER ? json(res, 200, INDEXER[k]) : json(res, 404, { error: "not found" });
  }
  if (p.startsWith("/api/market/")) {
    const body = S.market === "off" ? null : p === "/api/market/csd" ? csdBody() : p === "/api/market/series" ? csdSeries(url.searchParams) : null;
    // no-store, unlike the real route's max-age=60: a fake clock runs ahead of the browser's HTTP cache, which would
    // otherwise answer the page's re-reads with the earlier body
    return body ? json(res, 200, body, { "cache-control": "no-store" }) : json(res, 503, { ok: false, error: "market data off" }, { "cache-control": "no-store" });
  }
  if (p.startsWith("/api/rpc/tx/") && ATT_BY_ID.has(p.slice(12))) {
    const a = ATT_BY_ID.get(p.slice(12))!;
    return json(res, 200, { ok: true, txid: a.txid, height: a.height, tx: { app: { type: "Attest", proposal_id: a.pid, score: a.score, confidence: a.confidence } } });
  }
  if (p.startsWith("/trade/api/cairnx/")) {
    const k = p.slice(17);
    if (S.cx === "502") return json(res, 502, { ok: false, error: "cairnx backend unavailable" });
    if (S.cx === "503") return json(res, 503, { ok: false, error: "not ready: no validated scan since this resolver started; retry shortly" });
    if (S.cxFail && k.startsWith(S.cxFail)) return json(res, 500, { ok: false, error: "internal" });
    if (k === `/address/${WALLET}`) return json(res, 200, { balances: { QTOK: { available: "12345", locked: "100" } }, names: ["twin"] });
    if (k.startsWith("/record/")) { const v = VERDICTS[k.slice(8)]; return v ? json(res, 200, { txid: k.slice(8), ...v, tipHeight: TIP }) : json(res, 404, { ok: false, error: "no resolved record for this txid" }); }
    if (k === `/primary/${MINER}`) return json(res, 200, { ok: true, address: MINER, name: "solo" });
    if (k.startsWith("/name/") && k.slice(6) in NAMES) return json(res, 200, NAMES[k.slice(6)]);
    if (k === "/name-history/twin") return json(res, 200, { ok: true, name: "twin", events: [ATTESTS.fill, ATTESTS.refusedFill].map((a) => ({ txid: a.txid, height: a.height, pos: 3, kind: "fill" })) });
    if (k === "/tokens") return json(res, 200, [{ ticker: "QTOK", name: "Quarter", decimals: 2, supply: "100000000", minted: "100000", mint: "issuer" }]);
    if (k === "/records") {
      if (S.records === "404") return json(res, 404, { ok: false, error: "not a cairnx read endpoint" });
      if (S.records === "400") return json(res, 400, { ok: false, error: "at most 100 txids per request, got 130" });
      if (S.records === "500") return json(res, 500, { ok: false, error: "resolver down" });
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      RECORD_READS.push(ids.length);
      return json(res, 200, { ok: true, tipHeight: TIP, records: Object.fromEntries(ids.filter((id) => id in VERDICTS).map((id) => [id, VERDICTS[id]])) });
    }
    if (k === "/health") return S.gates ? json(res, 200, { ok: true, gates: { V25: V25_AT } }) : json(res, 404, { ok: false, error: "not found" });
    if (k === "/token/ZED") return json(res, 200, { ticker: "ZED", name: "Zed", decimals: 0, supply: "1000", minted: "10", mint: "issuer", height: TIP - 5,
      deployer: MINER, deployId: "0x" + "de".repeat(32), tmeta: "0x" + "4d".repeat(32), holders: {} });
    if (k.startsWith("/token/")) return json(res, 404, { ok: false, error: "unknown ticker" });
    if (k === "/name/onsale") return json(res, 200, { ok: true, owner: MINER, height: TIP - 9, effectiveHeight: TIP - 9, lease: {}, offer: { give: { name: "onsale" }, want: null } });
    // the resolver's answer for a name nobody holds
    if (k.startsWith("/name/")) return json(res, 404, { ok: false, error: "unregistered name", name: k.slice(6) });
    if (k === "/log" && S.records === "500") return json(res, 500, { ok: false, error: "resolver down" });
    if (k === "/log") return json(res, 200, Object.entries(VERDICTS).map(([id, v]) => ({ id, ok: v.applied, note: v.note, height: v.height })));
    if (k === "/primaries") { const want = (url.searchParams.get("addrs") ?? "").split(","); return json(res, 200, { ok: true, primaries: Object.fromEntries(want.filter((a) => a in PRIMARIES).map((a) => [a, PRIMARIES[a]])) }); }
    return json(res, 200, []);
  }
  if (p === "/api/health") return json(res, 200, { ok: true, tipHeight: TIP });
  if (p.startsWith("/content/")) {
    const h = p.slice(9), odd = ODD.get(h);
    if (odd === "drop") return void req.socket.destroy();
    if (odd === "502") return json(res, 502, { error: "bad gateway" });
    if (odd === "html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>Just a moment...</title>"); }
    if (odd === "other") { res.writeHead(200, { "content-type": "application/json", "x-csd-payload-hash": sha(GOOD) }); return res.end(GOOD); }
    const body = CONTENT.get(h);
    if (!body) return json(res, 404, { ok: false, error: "unknown payload_hash (not registered here)" });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...(odd === "noheader" ? {} : { "x-csd-payload-hash": h }) });
    return res.end(body);
  }
  if (p === "/ui/avatar.js" || p === "/trade/discover.js") {
    if (p === "/ui/avatar.js" && (!S.avatar || !S.shell)) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<pre>Cannot GET</pre>"); }
    res.writeHead(200, { "content-type": "text/javascript" }); return res.end(await readFile(p === "/ui/avatar.js" ? UI("avatar.js") : TRUST_STUB));
  }
  if (p === "/trade/verified-tokens.json") return S.trust ? json(res, 200, { note: "display convenience", ...TRUST_LIST }) : json(res, 404, { ok: false, error: "not found" });
  if (p === "/charts/chart.js") {
    res.writeHead(200, { "content-type": "text/javascript" }); return res.end(await readFile(CHART_STUB));
  }
  if (p in SHELL || p === "/footer.js") {
    // absent: the indexer's own 404 for a path it does not serve
    if (!S.shell) { res.writeHead(404, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" }); return res.end("<!DOCTYPE html><pre>Cannot GET</pre>"); }
    // footer.js present and empty: the page keeps its own footer
    const [file, type] = SHELL[p] ?? ["", "text/javascript"];
    res.writeHead(200, { "content-type": type }); return res.end(file ? await readFile(file) : "");
  }
  res.writeHead(404); res.end("not found");
});
if (!why) await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = why ? "" : `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { await browser?.close(); server.close(); });

type View = { page: any; errors: string[]; failed: string[]; asked: string[]; overflow: number; reqs: number; bytes: () => number; close: () => Promise<void> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll `ready` in the page from here: the page's own timers may be fake. */
async function until(page: any, ready: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await page.evaluate(ready))) { if (Date.now() > end) throw new Error(`timed out waiting for ${ready.toString().slice(0, 120)}`); await sleep(100); }
}
async function open(path: string, width: number, ready: () => boolean, { clock = false, response = "", scheme = "dark", locale = "en-US", at = 0, reduced = false, init = null as null | (() => void) } = {}): Promise<View> {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, isMobile: width < 500, hasTouch: width < 500, colorScheme: scheme, locale, serviceWorkers: "block",
    reducedMotion: reduced ? "reduce" : "no-preference" });
  await ctx.addInitScript(() => { try { localStorage.setItem("cairn:terms:v4", "2026-10-12T00:00:00.000Z"); } catch { /* no storage */ } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  if (clock || at) await page.clock.install(at ? { time: at } : undefined);
  const errors: string[] = [], failed: string[] = [], asked: string[] = [];
  let bytes = 0;
  page.on("request", (r: any) => asked.push(new URL(r.url()).pathname)); // every fetch the page makes, browser cache or not
  page.on("pageerror", (e: Error) => errors.push(`pageerror ${e.message}`));
  page.on("console", (m: any) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const seen: string[] = [];
  page.on("response", async (r: any) => {
    seen.push(`${r.status()} ${new URL(r.url()).pathname}`);
    if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
    if (!/event-stream/.test(r.headers()["content-type"] ?? "")) try { bytes += (await r.body()).length; } catch { /* aborted */ }
  });
  REQS.length = 0;
  await page.goto(ORIGIN + path, { waitUntil: "load" });
  await until(page, ready);
  for (const end = Date.now() + 15_000; response && !seen.includes(response); await sleep(100)) if (Date.now() > end) throw new Error(`no response ${response}`);
  await sleep(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  return { page, errors, failed, asked, overflow, reqs: REQS.length, bytes: () => bytes, close: () => ctx.close() };
}
const withMarket = () => ["#emchart", "#hrchart", "#btchart", "#csdusd-chart"].every((s) => !!document.querySelector(`${s} canvas`));
const charted = () => ["#emchart", "#hrchart", "#btchart"].every((s) => !!document.querySelector(`${s} canvas`));
const OFF = "503 /api/market/csd";
const bad = /NaN|undefined|Infinity|(^|\s)\$?0(\.0+)? USD/;
const figures = (page: any) => page.evaluate(() => [...document.querySelectorAll("#csd-mkt .mkt-fig")].map((f) => ({
  label: f.querySelector(".mkt-l")?.textContent ?? "", value: f.querySelector(".mkt-v")?.textContent ?? "", second: f.querySelector(".mkt-u")?.textContent ?? "",
  source: f.querySelector(".mkt-s")?.textContent ?? "" })));

for (const market of ["fresh", "stale", "off"] as const) for (const width of [390, 1280]) {
  test(`${market}, ${width} px: no error, no overflow, every chart drawn, the hashrate window named, the CSD/USD figures sourced or hidden`, { skip: why || false }, async () => {
    Object.assign(S, { market, thin: false, series: true });
    const v = await open("/explorer", width, market === "off" ? charted : withMarket, { response: market === "off" ? OFF : "" });
    try {
      assert.deepEqual(v.errors, []);
      assert.deepEqual(v.failed, market === "off" ? ["503 /api/market/csd"] : []);
      assert.equal(v.overflow, 0, "horizontal overflow");
      assert.equal(await v.page.textContent("#pu-hr .n"), "3.15 TH/s", "the indexer's figure over the window");
      assert.equal(await v.page.textContent("#pu-hr .l"), "Hashrate · series of 56 points", "the module's window text for the 1d series, in the tile");
      assert.equal(await v.page.textContent(".panel:has(#hrchart) .h-side"), "series of 56 points", "the same window on the chart");
      assert.equal(await v.page.getAttribute("#hrchart canvas", "data-points"), "56", "the series' 56 points handed to the chart");
      assert.equal(await v.page.evaluate(() => (globalThis as any).__chartStubLive), market === "off" ? 3 : 4, "one live mount per chart host");
      // the library lays its pane out in the first row of a table, whose cells this page's own td rules once capped
      const narrow = await v.page.evaluate(() => ["#emchart", "#hrchart", "#btchart", "#csdusd-chart"].filter((s) => document.querySelector(`${s} canvas`)).map((s) => ({
        s, plot: Math.round(document.querySelector(`${s} .cc-plot`).getBoundingClientRect().width),
        pane: Math.round(Math.max(...[...document.querySelectorAll(`${s} .cc-plot tr:first-child > td`)].map((c: any) => c.getBoundingClientRect().width))) })).filter((x) => x.pane < 0.65 * x.plot));
      assert.deepEqual(narrow, [], "each chart's pane fills its plot");
      const text: string = await v.page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(text, bad);
      assert.match(await v.page.textContent("#tok-note"), /a paid fill can be refused/, "the token note says delivery is the resolver's");
      assert.doesNotMatch(text, /atomic/i, "no atomic delivery claim: a paid fill can be refused");
      if (market === "off") {
        assert.equal(await v.page.isVisible("#csd-mkt"), false, "the CSD/USD block hidden");
        assert.doesNotMatch(text, /USD/, "no USD text with the market off");
      } else {
        const figs = await figures(v.page);
        assert.deepEqual(figs.map((f: { label: string }) => f.label), ["price", "24h VWAP", "market cap", "fully diluted", "24h volume"]);
        for (const f of figs) assert.match(f.value, / USD$/, `${f.label} in USD`);
        const stale = market === "stale" ? " · stale 2400s" : "";
        assert.deepEqual(figs.map((f: { source: string }) => f.source), ["last trade", "24h volume / 24h amount", "at the 24h VWAP · thin market",
          "at the 24h VWAP", "the venue's 24h volume"].map((b) => `rate: ${b} · SafeTrade${stale}`), "each figure's basis, with the body's venue and age");
        assert.equal(figs[0].value, "0.0455 USD");
        assert.match(await v.page.textContent("#csd-mkt .mkt-sub"), /CSD prices from SafeTrade, an exchange we do not operate/);
        assert.equal(await v.page.getAttribute("#csd-mkt .mkt-sub a", "href"), "https://safetrade.com/exchange/CSD-USDT");
        assert.equal(await v.page.textContent("#csd-mkt > .muted"), "CSD/USD · last 30 days · daily closes · CoinPaprika");
        const note: string = await v.page.textContent("#csdusd-chart .cc-note");
        if (market === "stale") assert.equal(note, "stale 2400s", "the body's age passed to the chart");
        else assert.doesNotMatch(await v.page.textContent("#csd-mkt"), /stale/);
      }
      console.log(`      ${market} ${width}: ${v.reqs} requests, ${Math.round(v.bytes() / 1024)} KB`);
    } finally { await v.close(); }
  });
}

test("a body without a VWAP, supply or volume: dashes for those figures, never a 0 USD", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", thin: true, series: true });
  const v = await open("/explorer", 1280, withMarket);
  try {
    const figs = await figures(v.page);
    assert.deepEqual(figs.map((f: { value: string }) => f.value), ["0.0455 USD", "-", "-", "-", "-"]);
    assert.doesNotMatch(await v.page.textContent("#csd-mkt"), bad);
  } finally { await v.close(); S.thin = false; }
});

test("a range without its low and a supply without its emitted figure: no range line, a dash, never a 0", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", thin: false, partial: true, series: true });
  const v = await open("/explorer", 1280, withMarket);
  try {
    const figs = await figures(v.page);
    assert.equal(figs[0].second, "", "no 24h range line without both ends");
    assert.equal(figs[2].second, "emitted - CSD at block 121,800");
    assert.equal(figs[3].second, "max supply 105,119,999.88 CSD", "the honest part of the same body still shown");
    assert.doesNotMatch(await v.page.textContent("#csd-mkt"), /(^|\s)0( to| CSD)/);
  } finally { await v.close(); S.partial = false; }
});

test("the indexer without /analytics/series (404): the tile names the blocks, the hashrate chart says it has no series", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: false });
  const v = await open("/explorer", 1280, () => !!document.querySelector("#emchart canvas") && !!document.querySelector("#hrchart .cc-empty"));
  try {
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.failed.sort(), ["404 /explorer/api/analytics/series", "503 /api/market/csd"]);
    assert.equal(await v.page.textContent("#pu-hr .l"), "Hashrate · blocks 121080 to 121800", "the module's window text from the miners read");
    assert.equal(await v.page.textContent("#hrchart .cc-empty"), "no hashrate series from this indexer");
  } finally { await v.close(); S.series = true; }
});

test("standalone (the page at /): no market read, no chart module, the figures without charts", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", series: true });
  const v = await open("/", 1280, () => !!document.querySelector("#pu-hr") && !!document.querySelector("#blkfeed tr"));
  try {
    assert.deepEqual(v.errors, []);
    assert.deepEqual(REQS.filter((p) => /^\/(api\/market|charts|vendor|trade)\//.test(p)), []);
    assert.equal(await v.page.isVisible("#emchart"), false);
    assert.equal(await v.page.isVisible("#csd-mkt"), false);
    assert.equal(await v.page.locator("#hrchart").count(), 0, "no chart panels standalone");
    assert.equal(await v.page.textContent("#pu-hr .n"), "3.15 TH/s");
    // the window text is the chart module's, which a standalone page has not: the label is bare, the title names the blocks
    assert.equal(await v.page.textContent("#pu-hr .l"), "Hashrate");
    assert.match(await v.page.getAttribute("#pu-hr", "title"), /over blocks 121,080 to 121,800, from the indexer/);
  } finally { await v.close(); }
});

/** Canvases alive in the page's heap after a GC, less those in its document (the library keeps a constant few). */
async function strayCanvases(page: any): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const proto = await cdp.send("Runtime.evaluate", { expression: "HTMLCanvasElement.prototype" });
    const found = await cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId });
    const live = await cdp.send("Runtime.callFunctionOn", { objectId: found.objects.objectId, functionDeclaration: "function () { return this.length; }", returnByValue: true });
    await cdp.send("Runtime.releaseObject", { objectId: found.objects.objectId }); // the array itself holds the canvases
    return live.result.value - (await page.evaluate(() => document.querySelectorAll("canvas").length));
  } finally { await cdp.detach(); }
}
/** Advance the page's fake clock a minute at a time, letting each minute's reads finish. */
async function minutes(page: any, n: number): Promise<void> {
  for (let i = 0; i < n; i++) { await page.clock.runFor(60_000); await sleep(150); }
}

test("market off: one price read, none in the next 4 min, one more after 5 min", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true });
  const v = await open("/explorer", 1280, () => !!document.querySelector("#pu-hr"), { clock: true, response: OFF });
  const count = (p: string) => v.asked.filter((x) => x === p).length;
  try {
    assert.equal(count("/api/market/csd"), 1);
    await minutes(v.page, 4);
    assert.equal(count("/api/market/csd"), 1, "no read inside the 5 min back-off");
    await minutes(v.page, 2);
    assert.equal(count("/api/market/csd"), 2, "asked again after 5 min");
    assert.equal(count("/api/market/series"), 0, "no series read while the price is absent");
  } finally { await v.close(); }
});

test("market on: the price every 2 min and the daily series every 10 min while the page is open", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", series: true });
  const v = await open("/explorer", 1280, () => !!document.querySelector("#csd-mkt .mkt-fig"), { clock: true });
  const count = (p: string) => v.asked.filter((x) => x === p).length;
  try {
    assert.deepEqual([count("/api/market/csd"), count("/api/market/series")], [1, 1]);
    await minutes(v.page, 10);
    assert.deepEqual([count("/api/market/csd"), count("/api/market/series")], [6, 2], "price at 2, 4, 6, 8, 10 min; series at 10 min");
    assert.equal((await figures(v.page))[0].value, "0.0455 USD", "the figures still shown after the re-reads");
  } finally { await v.close(); }
});

test("leaving and re-opening the home view destroys the charts it replaces: live canvases do not grow", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", thin: false, series: true });
  const v = await open("/explorer", 1280, withMarket);
  try {
    const before = await strayCanvases(v.page);
    for (let i = 0; i < 3; i++) {
      await v.page.evaluate(() => { location.hash = "#/address/0x" + "11".repeat(20); });
      await until(v.page, () => !document.querySelector("#emchart"));
      await v.page.evaluate(() => { location.hash = "#/"; });
      await until(v.page, withMarket);
    }
    assert.equal(await strayCanvases(v.page), before, "no chart of a replaced view left alive");
  } finally { await v.close(); }
});

test("the market going from fresh to 503 while the page is open hides the CSD/USD block and destroys its chart", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", thin: false, partial: false, series: true });
  const v = await open("/explorer", 1280, withMarket, { clock: true });
  try {
    assert.equal(await v.page.isVisible("#csd-mkt"), true);
    const before = await strayCanvases(v.page);
    S.market = "off";
    await minutes(v.page, 3); // past the 2 min re-read
    assert.ok(v.failed.includes(OFF), "the re-read answered 503");
    assert.equal(await v.page.isVisible("#csd-mkt"), false, "the block hidden");
    assert.equal(await v.page.locator("#csdusd-chart").count(), 0, "the chart's host gone");
    assert.doesNotMatch(await v.page.evaluate(() => document.body.innerText), /USD/, "no USD text left");
    assert.equal(await strayCanvases(v.page), before, "the CSD/USD chart destroyed, not left alive detached");
  } finally { await v.close(); S.market = "fresh"; }
});

// Verdicts (Plan 85 12.2d): the records a view shows are asked of /cairnx/records, 100 txids a read; a front door or
// resolver without that route (404) or one that refuses the read (400) falls back to the applied-event log. The log is
// not read when the route answers.
for (const records of ["on", "404", "400"] as const) {
  test(`domain page, /cairnx/records ${records === "on" ? "answering: two reads for 130 records, no log read" : `${records}: one log read`}; the refused mint shows no effect`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, records });
    INDEXER["/domain/cairnx:v1/proposals"] = PROPS;
    RECORD_READS.length = 0;
    try {
      const v = await open("/explorer#/domain/cairnx%3Av1", 1280, () => !!document.querySelector(".cx-noeffect") || /\d proposals?\./.test(document.body.innerText));
      try {
        assert.deepEqual(v.errors, []);
        const row: string = await v.page.evaluate((id: string) => [...document.querySelectorAll("tr")].find((r: any) => r.innerHTML.includes(id))?.textContent ?? "", REFUSED);
        assert.match(row, /No effect/);
        assert.match(row, /No effect: mint past supply/);
        const logReads = v.asked.filter((x) => x === "/trade/api/cairnx/log").length;
        if (records === "on") {
          assert.deepEqual(RECORD_READS.sort((a, b) => b - a), [100, 30]);
          assert.equal(logReads, 0);
        } else {
          assert.equal(logReads, 1);
        }
        assert.equal(await v.page.locator(".cx-noeffect").count(), 1, "only the refused record");
      } finally { await v.close(); }
    } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; S.records = "on"; }
  });
}

test("home page: the activity feed's records are asked of /cairnx/records (130 txids, two reads), no log read; the refused mint shows no effect", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, records: "on" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS;
  RECORD_READS.length = 0;
  try {
    const v = await open("/explorer", 1280, () => !!document.querySelector("#actfeed .cx-noeffect"));
    try {
      assert.deepEqual(v.errors, []);
      assert.deepEqual(RECORD_READS.sort((a, b) => b - a), [100, 30]);
      assert.equal(v.asked.filter((x) => x === "/trade/api/cairnx/log").length, 0);
      assert.match(await v.page.textContent("#actfeed .cx-noeffect"), /mint past supply/);
      assert.equal(await v.page.locator("#actfeed .cx-noeffect").count(), 1, "only the refused record");
    } finally { await v.close(); }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
});

test("address page: each page of txs asks /cairnx/records for its own Propose txids; the refused mint on the second page shows no effect", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, records: "on" });
  RECORD_READS.length = 0;
  const v = await open(`/explorer#/address/${WALLET}`, 1280, () => !!document.querySelector("#txloadmore") && !!document.querySelector("#act-24 .what"));
  try {
    assert.deepEqual(RECORD_READS, [25], "the first page's 25");
    assert.equal(await v.page.locator(".cx-noeffect").count(), 0);
    await v.page.click("#txloadmore");
    await until(v.page, () => !!document.querySelector("#act-25 .what") && !!document.querySelector("#act-49 .what"));
    assert.deepEqual(RECORD_READS, [25, 25], "the second page's 25, not the first again");
    assert.equal(v.asked.filter((x) => x === "/trade/api/cairnx/log").length, 0);
    assert.match(await v.page.textContent("#act-25"), /No effect: mint past supply/);
    assert.equal(await v.page.locator(".cx-noeffect").count(), 1);
    assert.deepEqual(v.errors, []);
  } finally { await v.close(); }
});

// An Attest on an offer reads by the resolver's verdict for its txid (/cairnx/record on the tx page, /cairnx/records
// on the address page): the words for an effect only when CairnX applied it, a refused one struck with its reason, and
// one without a verdict as the request it made. The chain mines a paid fill whose delivery CairnX refuses.
const sh = (h: string) => h.slice(0, 10) + "\u2026" + h.slice(-6);
const RESERVED_NOTE = "(open offer, claimed; the purchase completes after a short reorg-safe wait)";
const ATTEST_LINES: Record<keyof typeof ATTESTS, string> = {
  refusedFill: `Market Fill request on CAIRN: paid 1.255 CSD, offer ${sh(OFFER.txid)} No effect: offer filled`,
  fill: `Market Bought CAIRN for 1.255 CSD, offer ${sh(OFFER.txid)}`,
  refusedCancel: `Market Cancel request on an offer: ${sh(OFFER.txid)} No effect: offer cancelled`,
  cancel: `Market Cancelled an offer: ${sh(OFFER.txid)}`,
  claim: `Market Reserved CAIRN ${RESERVED_NOTE}, offer ${sh(OFFER.txid)}`,
  swap: `Market Token swap fill: took the offer ${sh(SWAP.txid)} (100 base units CAIRN for 123.45 QTOK, paid in tokens; no CSD moves)`,
  unread: `Market Fill request on CAIRN: paid 1.255 CSD, offer ${sh(OFFER.txid)}`,
};
const decoded = () => !/decoding/.test(document.querySelector("#txaction")?.textContent ?? "decoding");
for (const [which, width] of [...Object.keys(ATTESTS).map((k) => [k, 1280] as const), ["refusedFill", 390] as const]) {
  test(`transaction page, Attest ${which} at ${width} px: "${ATTEST_LINES[which as keyof typeof ATTESTS]}"`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, records: "on" });
    const a = ATTESTS[which as keyof typeof ATTESTS];
    const v = await open(`/explorer#/tx/${a.txid}`, width, decoded);
    try {
      assert.deepEqual(v.errors, []);
      const line: string = await v.page.textContent("#txaction");
      assert.equal(line, ATTEST_LINES[which as keyof typeof ATTESTS]);
      assert.equal(await v.page.locator("#txaction .cx-void").count(), a.verdict?.applied === false ? 1 : 0, "struck only when refused");
      if (a.verdict?.applied !== true) assert.doesNotMatch(line, /Bought|Cancelled|Reserved|took the offer/, "no effect words without an applied verdict");
      assert.doesNotMatch(await v.page.evaluate(() => document.body.innerText), /atomic/i);
      assert.equal(v.asked.filter((x) => x === `/trade/api/cairnx/record/${a.txid}`).length, 1, "the resolver asked for this txid's verdict");
      assert.equal(v.overflow, 0, "horizontal overflow");
      // an amount cut at its scroll box's edge reads as a smaller amount
      const cut: string[] = await v.page.evaluate(() => [...document.querySelectorAll(".scroll-x td.num")].filter((c: any) =>
        c.getBoundingClientRect().right > c.closest(".scroll-x").getBoundingClientRect().right + 0.5).map((c: any) => c.textContent));
      assert.deepEqual(cut, [], "every amount whole inside its box");
    } finally { await v.close(); }
  });
}

test("address page: Attest rows ask /cairnx/records with the page's txids and read like the tx page", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, records: "on" });
  RECORD_READS.length = 0;
  const keys = Object.keys(ATTESTS) as (keyof typeof ATTESTS)[];
  const v = await open(`/explorer#/address/${BUYER}`, 1280, () => [...document.querySelectorAll("td.act")].every((c: any) => !/^Attest$/.test(c.textContent)) && document.querySelectorAll("td.act").length > 0);
  try {
    assert.deepEqual(v.errors, []);
    assert.deepEqual(RECORD_READS, [keys.length], "one read for the page's Attest txids");
    const acts: string[] = await v.page.evaluate(() => [...document.querySelectorAll("td.act")].map((c: any) => c.textContent));
    assert.deepEqual(acts, keys.map((k) => ATTEST_LINES[k]));
  } finally { await v.close(); }
});

for (const width of [390, 1280]) {
  test(`name page at ${width} px: the primary badge is the resolver's pick for the owner; a token price in the token's decimals; a refused fill in the history shows no effect`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, records: "on" });
    const twin = await open("/explorer#/name/twin", width, () => /history \(/i.test(document.body.innerText));
    try {
      assert.deepEqual(twin.errors, []);
      assert.equal(await twin.page.locator(".namehdr .badge").count(), 0, "a self-pointing name the resolver did not pick: no badge");
      assert.equal(await twin.page.textContent(".panel:has(h2:text-is('For sale')) .action"), "Market Listed for 123.45 QTOK \u00b7 open offer");
      const hist: string[] = await twin.page.evaluate(() => [...document.querySelectorAll(".panel:has(h2) tbody tr td:first-child")].map((c: any) => c.textContent));
      assert.deepEqual(hist, ["Market Bought / sold (fill) No effect: offer filled", "Market Bought / sold (fill)"]);
      assert.equal(twin.overflow, 0, "horizontal overflow");
    } finally { await twin.close(); }
    const solo = await open("/explorer#/name/solo", width, () => /resolves to/i.test(document.body.innerText));
    try {
      assert.deepEqual(solo.errors, []);
      assert.equal(await solo.page.textContent(".namehdr .badge"), "Primary", "the resolver's pick carries the badge");
      assert.equal(solo.overflow, 0, "horizontal overflow");
    } finally { await solo.close(); }
  });
}

// The proposal page's content check reads cairn's /content (same origin), hashes the bytes as received and calls
// them verified only when they hash to the on-chain payload hash.
const CONTENT_CASES = [
  ["good", "/explorer", "Content integrity verified", "ok"],
  ["binary", "/explorer", "Content integrity verified", "ok"],
  ["tampered", "/explorer", "Content mismatch", "bad"],
  ["absent", "/explorer", "Content not held by this front door", "pend"],
  ["edgeHtml", "/explorer", "Content unavailable", "pend"],
  ["otherHash", "/explorer", "Content unavailable", "pend"],
  ["noHeader", "/explorer", "Content integrity verified", "ok"],
  ["upperCase", "/explorer", "Content integrity verified", "ok"],
  ["e502", "/explorer", "Content unavailable", "pend"],
  ["dropped", "/explorer", "Content unavailable", "pend"],
  ["noHash", "/explorer", "No content hash", "pend"],
  ["good", "/", "Content check needs the cairn front door", "pend"],
] as const;
for (const [which, at, text, cls] of CONTENT_CASES) {
  test(`proposal page, ${which} content${at === "/" ? ", standalone" : ""}: "${text}"`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true });
    const prop = CONTENT_PROPS[which];
    const v = await open(`${at}#/proposal/${prop.txid}`, 1280, () => !!document.querySelector("#cibadge") && document.querySelector("#cibadge").textContent !== "Checking content\u2026");
    try {
      assert.deepEqual(v.errors, []);
      assert.equal(await v.page.textContent("#cibadge"), text);
      assert.equal(await v.page.getAttribute("#cibadge", "class"), `badge ${cls}`);
      assert.deepEqual(v.asked.filter((x) => /\/content\//.test(x)), at === "/" || which === "noHash" ? [] : [`/content/${prop.payload_hash.toLowerCase()}`], "cairn's /content, never the indexer's");
    } finally { await v.close(); }
  });
}

for (const gates of [true, false]) {
  test(`domain page: a reveal reads as ${gates ? "reserved from the resolver's V25 height on and claimed below it" : "revealed without the gate height"}; a direct claim as claimed; nfinalize as finalized`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, records: "on", gates });
    const salt = "0x" + "5a".repeat(16);
    INDEXER["/domain/cairnx:v1/proposals"] = [
      cxProp(901, { v: 1, t: "name", name: "alpha", salt }),     // height TIP - 901, at or above the gate
      cxProp(902, { v: 1, t: "name", name: "beta" }),
      cxProp(903, { v: 1, t: "nfinalize", name: "alpha", salt }),
      cxProp(960, { v: 1, t: "name", name: "gamma", salt }),     // height TIP - 960, below the gate
    ];
    applied(...INDEXER["/domain/cairnx:v1/proposals"] as any[]);
    try {
      const v = await open("/explorer#/domain/cairnx%3Av1", 1280, () => /\d proposals?\./.test(document.body.innerText));
      try {
        assert.deepEqual(v.errors, []);
        const acts: string[] = await v.page.evaluate(() => [...document.querySelectorAll("td.act")].map((c: any) => c.textContent));
        assert.deepEqual(acts, [`Name ${gates ? "Reserved" : "Revealed"} name alpha.csd`, "Name Claimed name beta.csd",
          "Name Finalized name alpha.csd: registration paid, the lease starts", `Name ${gates ? "Claimed" : "Revealed"} name gamma.csd`]);
      } finally { await v.close(); }
    } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; S.gates = true; }
  });
}

test("name page: an offer without a price reads \"Listed for sale\", no dash in place of the price", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true });
  const v = await open("/explorer#/name/onsale", 1280, () => /for sale/.test(document.body.innerText));
  try {
    assert.deepEqual(v.errors, []);
    assert.equal(await v.page.textContent(".panel:has(h2:text-is('For sale')) .action"), "Market Listed for sale \u00b7 open offer");
  } finally { await v.close(); }
});

test("proposal page at 390 px: the attestations table scrolls inside its own box, the page does not widen", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true });
  const prop = CONTENT_PROPS.good;
  const saved = prop.attestations;
  prop.attestations = Array.from({ length: 3 }, (_, i) => ({ attester: MINER, score: 100, confidence: 1000000, fee: 2500000000 + i, txid: "0x" + "ab".repeat(31) + String(i).padStart(2, "0") }));
  try {
    const v = await open(`/explorer#/proposal/${prop.txid}`, 390, () => document.querySelectorAll("tbody tr td").length > 3);
    try {
      const m = await v.page.evaluate(() => {
        const t = [...document.querySelectorAll("h2")].find((h: any) => /^Attestations/.test(h.textContent))!.parentElement.querySelector("table");
        const box = t.closest(".scroll-x");
        return { boxed: !!box, boxRight: box ? box.getBoundingClientRect().right : Infinity, width: innerWidth, body: document.body.scrollWidth,
          scrolls: box ? box.scrollWidth > box.clientWidth : false };
      });
      assert.ok(m.boxed, "the table sits in a .scroll-x box");
      assert.ok(m.boxRight <= m.width, `the box ends inside the viewport (${m.boxRight} > ${m.width})`);
      assert.ok(m.scrolls, "the wide table scrolls inside the box");
      assert.ok(m.body <= m.width, `the page does not widen (body ${m.body} px at ${m.width} px)`);
    } finally { await v.close(); }
  } finally { prop.attestations = saved; }
});

test("domain page: record lines separate their parts with a colon or comma, never a spaced hyphen", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, records: "on" });
  INDEXER["/domain/cairnx:v1/proposals"] = [
    cxProp(911, { v: 1, t: "deploy", ticker: "ZED", supply: "1000", decimals: 0, mint: "issuer" }),
    cxProp(912, { v: 1, t: "mint", ticker: "ZED", amount: "5" }),
    cxProp(913, { v: 1, t: "offer", give: { name: "zed" }, want: { value: 100000000 } }),
    cxProp(914, { v: 1, t: "bid", give: { value: 100000000 }, want: { name: "zed" } }),
    cxProp(915, { v: 1, t: "ncommit", commit: "0x" + "11".repeat(32) }),
    cxProp(916, { v: 1, t: "nrenew", name: "zed" }),
    cxProp(917, { v: 1, t: "offer", give: { name: "zed" }, want: { ticker: "QTOK", amount: "12345" } }),
    cxProp(918, { v: 1, t: "offer", give: { name: "zed" }, want: { ticker: "ZED", amount: "500" } }),
  ];
  applied(...INDEXER["/domain/cairnx:v1/proposals"] as any[]);
  try {
    const v = await open("/explorer#/domain/cairnx%3Av1", 1280, () => /\d proposals?\./.test(document.body.innerText));
    try {
      assert.deepEqual(v.errors, []);
      const acts: string[] = await v.page.evaluate(() => [...document.querySelectorAll("td.act")].map((c: any) => c.textContent));
      assert.deepEqual(acts, [
        "Token Deployed token ZED: supply 1,000, issuer-mint (fixed)",
        "Token Minted ZED: 5 base units",
        "Market Listed name zed.csd for 1 CSD, open offer",
        "Market Bid 1 CSD for name zed.csd: non-binding; a seller answers with a reserved offer",
        "Name Sealed a name commitment: the name is revealed later (front-run defense)",
        "Name Renewed the lease on zed.csd for one more year",
        "Market Listed name zed.csd for 123.45 QTOK, open offer",
        "Market Listed name zed.csd for 500 base units ZED, open offer",
      ]);
      assert.equal(acts.filter((a) => / - /.test(a)).length, 0);
    } finally { await v.close(); }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
});

// A Propose line names an effect (Minted, Finalized name, Pointed...) only when the resolver applied the record. With
// the page standalone, or the verdict read failing, it reads as the request it is, as an Attest on an offer does.
test("domain page: a Propose reads as a request unless the resolver applied it", { skip: why || false }, async () => {
  const props = [
    cxProp(921, { v: 1, t: "mint", ticker: "ZED", amount: "5" }),
    cxProp(922, { v: 1, t: "nfinalize", name: "alpha" }),
    cxProp(923, { v: 1, t: "nset", name: "alpha", addr: MINER }),
    cxProp(924, { v: 1, t: "transfer", ticker: "ZED", amount: "5", to: MINER }),
    cxProp(925, { v: 1, t: "name", name: "gamma", salt: "0x" + "5a".repeat(16) }),
  ];
  const EFFECT = /Minted|Finalized|Pointed|Transferred|Reserved|Claimed|Revealed/;
  const REQUEST = ["Mint request for ZED", "Finalize request for name alpha.csd", "Point request", "Transfer request", "Reveal request for name gamma.csd"];
  const read = async (path: string, ready: () => boolean) => {
    const v = await open(path, 1280, ready);
    try {
      assert.deepEqual(v.errors, []);
      return { acts: await v.page.evaluate(() => [...document.querySelectorAll("td.act")].map((c: any) => c.textContent)) as string[],
        struck: await v.page.locator(".cx-void").count() };
    } finally { await v.close(); }
  };
  const loaded = () => /\d proposals?\./.test(document.body.innerText);
  INDEXER["/domain/cairnx:v1/proposals"] = props;
  try {
    Object.assign(S, { market: "off", series: true, gates: true, records: "on" });
    // standalone: there is no resolver to ask
    const alone = await read("/#/domain/cairnx%3Av1", loaded);
    assert.equal(alone.acts.length, 5);
    for (const [i, want] of REQUEST.entries()) assert.ok(alone.acts[i]!.includes(want), `standalone: ${alone.acts[i]}`);
    for (const a of alone.acts) assert.doesNotMatch(a, EFFECT);
    // the front door with the resolver failing both reads
    S.records = "500";
    const down = await read("/explorer#/domain/cairnx%3Av1", loaded);
    assert.deepEqual(down.acts, alone.acts);
    // the resolver applied them: the effect words stand
    S.records = "on";
    applied(...props);
    const done = await read("/explorer#/domain/cairnx%3Av1", loaded);
    assert.deepEqual(done.acts.map((a) => a.match(EFFECT)?.[0]), ["Minted", "Finalized", "Pointed", "Transferred", "Reserved"]);
    assert.equal(done.struck, 0);
    // one of them refused: struck, with the request wording
    VERDICTS[props[0]!.txid] = { kind: "mint", applied: false, note: "mint past supply", height: props[0]!.height };
    const refused = await read("/explorer#/domain/cairnx%3Av1", loaded);
    assert.ok(refused.acts[0]!.includes("Mint request for ZED") && /No effect: mint past supply/.test(refused.acts[0]!), refused.acts[0]);
    assert.deepEqual(refused.acts.slice(1), done.acts.slice(1));
    assert.equal(refused.struck, 1);
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; S.records = "on"; for (const p of props) delete VERDICTS[p.txid]; }
});

// The name page's history and a domain's proposals are ledgers like the address page's: on a phone each row stacks, the
// transaction (and its block) on one line and the record under them at full width, instead of a record squeezed between
// two columns; on a desktop each row is one line. Each transaction or proposal id dims its 0x as every hash does.
test("name history and a domain's proposals: one line per row at 1280 px, the record under its transaction at 390 px; ids with their 0x dimmed", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, records: "on" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 3);
  const stacked = (page: any) => page.evaluate(() => [...document.querySelectorAll("table.stack tbody tr")].map((r: any) => {
    const rec = r.querySelector("td.act").getBoundingClientRect(), id = r.querySelector("td:not(.act) a.mono"), tx = id.getBoundingClientRect();
    return [rec.top >= tx.bottom - 1, /^0x0*$/.test(id.querySelector(".lz")?.textContent ?? "")]; }));
  try {
    for (const width of [1280, 390]) {
      for (const [path, ready, rows] of [["/explorer#/name/twin", () => /history \(/i.test(document.body.innerText), 2],
        ["/explorer#/domain/cairnx%3Av1", () => /\d proposals?\./.test(document.body.innerText), 3]] as const) {
        const v = await open(path, width, ready);
        try {
          assert.deepEqual(v.errors, []);
          assert.equal(v.overflow, 0, "horizontal overflow");
          assert.deepEqual(await stacked(v.page), Array(rows).fill([width < 720, true]), `${path} at ${width} px`);
        } finally { await v.close(); }
      }
    }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
});

test("token page: the metadata hash is described as what it is, with no claim about a content swarm", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true });
  const v = await open("/explorer#/token/ZED", 1280, () => /metadata/.test(document.body.innerText));
  try {
    assert.deepEqual(v.errors, []);
    const row: string = await v.page.evaluate(() => [...document.querySelectorAll(".kv > div")].find((d: any) => d.textContent === "metadata")!.nextElementSibling.textContent);
    assert.equal(row, `0x${"4d".repeat(32)} (the sha256 of the issuer's metadata document; this page does not fetch it)`);
  } finally { await v.close(); }
});

// Cairn's shell set (Plan 89 P6): the page links /ui/theme-init.js first in <head>, cairn's tokens, fonts, theme and
// component sheets, and /ui/theme.js before /header.js, all from the cairn origin. Through the front door the page
// follows the theme those set; on a direct indexer hit they 404 and the page renders on its own fallback tokens.
const look = (page: any) => page.evaluate(() => ({
  theme: document.documentElement.getAttribute("data-theme"), initSheets: document.documentElement.dataset.initSheets ?? null,
  bg: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color,
  sawTheme: document.querySelector("#site-header")?.dataset.sawTheme ?? null,
  brand: document.querySelector("#site-header .ex-brand") ? document.querySelector("#site-header .ex-brand").getBoundingClientRect().height > 0 : null,
  // the page's trust statement, shown on the page itself (not folded into a footer)
  trust: (() => { const n = document.querySelector("#trust-note"); return n && !n.closest("footer") ? Math.round(n.getBoundingClientRect().height) : 0; })(),
  note: document.querySelector("#site-footer")?.getAttribute("data-note") ?? null,
}));
for (const scheme of ["light", "dark"] as const) {
  test(`through the front door, ${scheme}: theme-init.js runs before every style sheet, cairn's tokens win over the fallback, theme.js loads before header.js`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true });
    const v = await open("/explorer", 1280, () => !!document.querySelector("#pu-hr"), { scheme });
    try {
      assert.deepEqual(v.errors, []);
      assert.deepEqual(v.failed, ["503 /api/market/csd"]);
      const l = await look(v.page);
      assert.ok(l.trust > 0, "the trust statement on the page");
      assert.deepEqual(l, { theme: scheme, initSheets: "0", bg: scheme === "dark" ? "rgb(16, 16, 20)" : "rgb(250, 250, 240)",
        ink: scheme === "dark" ? "rgb(238, 238, 238)" : "rgb(17, 17, 17)", sawTheme: "true", brand: null, trust: l.trust, note: null });
    } finally { await v.close(); }
  });
}

test("a direct indexer hit, cairn's files absent: the page renders on its fallback tokens with its own brand line and its trust statement", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", series: true, shell: false });
  try {
    for (const width of [390, 1280]) {
      const v = await open("/", width, () => !!document.querySelector("#pu-hr") && !!document.querySelector("#blkfeed tr"));
      try {
        // the browser reports each absent file it refuses as text/html (the indexer's 404 page); nothing else
        assert.deepEqual(v.errors.filter((e) => !/^Refused to (apply style|execute script) from '[^']+\/(ui\/[a-z-]+\.(css|js)|header\.js|footer\.js)[?']/.test(e)), []);
        assert.deepEqual(v.failed.filter((f) => !/^404 \/(ui\/[a-z-]+\.(css|js)|header\.js|footer\.js)$/.test(f)), [], "no read failed but the shell files");
        assert.ok(v.failed.includes("404 /ui/theme-init.js"), "the shell files were asked for");
        const l = await look(v.page);
        assert.equal(l.theme, null, "no theme-init.js");
        assert.equal(l.bg, "rgb(244, 244, 241)", "the fallback ground");
        assert.equal(l.ink, "rgb(12, 12, 11)", "the fallback ink");
        assert.equal(l.brand, true, "the page's own brand line shown");
        assert.ok(l.trust > 0, "the trust statement on the page");
        assert.equal(l.note, null, "said once: no footer copy of it");
        assert.equal(await v.page.textContent("#pu-hr .n"), "3.15 TH/s");
        const dot = await v.page.evaluate(() => { const r = document.querySelector("#livepill .ui-dot").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        assert.deepEqual(dot, [7, 7], "the live marker's dot, drawn by the page's own sheet");
        assert.equal(v.overflow, 0, "horizontal overflow");
      } finally { await v.close(); }
    }
  } finally { S.shell = true; }
});

test("a theme switch mounts every chart again in the new theme's colours and leaves none behind", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", thin: false, partial: false, series: true, shell: true });
  const v = await open("/explorer", 1280, withMarket, { scheme: "light" });
  const lines = () => v.page.evaluate(() => ["#emchart", "#hrchart", "#btchart", "#csdusd-chart"].map((s) => document.querySelector(`${s} canvas`)?.dataset.line ?? ""));
  try {
    assert.deepEqual(await lines(), Array(4).fill("#111111"), "light ink at mount");
    const before = await strayCanvases(v.page);
    await v.page.evaluate(() => (globalThis as any).CairnTheme.set("dark"));
    await until(v.page, () => ["#emchart", "#hrchart", "#btchart", "#csdusd-chart"].every((s) => document.querySelector(`${s} canvas`)?.dataset.line === "#EEEEEE"));
    assert.equal(await v.page.evaluate(() => (globalThis as any).__chartStubLive), 4, "one live mount per chart host");
    assert.equal(await strayCanvases(v.page), before, "the light charts destroyed");
    assert.deepEqual(v.errors, []);
  } finally { await v.close(); }
});

// The inclusion check folds the served branch in the browser and compares it with the served block's merkle root.
const dsha = (b: Buffer) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const hx = (h: string) => Buffer.from(h.slice(2), "hex");
const PROVEN = "0x" + "e1".repeat(32), UNPROVEN = "0x" + "e2".repeat(32), BRANCH = ["0x" + "12".repeat(32), "0x" + "34".repeat(32)];
// position 2: the tx is the left child at the first level and the right child at the second
const ROOT = "0x" + dsha(Buffer.concat([hx(BRANCH[1]!), dsha(Buffer.concat([hx(PROVEN), hx(BRANCH[0]!)]))])).toString("hex");
for (const [txid, h, merkle] of [[PROVEN, TIP - 3, ROOT], [UNPROVEN, TIP - 4, "0x" + "ab".repeat(32)]] as const) {
  const b = { ...block(h), merkle };
  Object.assign(INDEXER, { [`/tx/${txid}`]: { txid, height: h, pos: 2, app_type: "Transfer", signer: MINER, fee: 1000, n_in: 1, n_out: 1, coinbase: false, outputs: [] },
    [`/tx/${txid}/status`]: { confirmed: true, block_height: h, confirmations: 4, final: false },
    [`/tx/${txid}/merkle-proof`]: { block_height: h, pos: 2, merkle: BRANCH, merkle_root: merkle }, [`/block-height/${h}`]: b.hash, [`/block/${b.hash}`]: b });
}
for (const [which, txid, badge, cls] of [["matching", PROVEN, "Consistent with indexer header (not PoW-verified)", "badge ok"],
  ["another", UNPROVEN, "Inclusion failed", "badge bad"]] as const) {
  test(`transaction page, a branch folding to ${which} root: "${badge}"; each branch hash shown from its start`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true });
    const v = await open(`/explorer#/tx/${txid}`, 1280, () => !/Verifying/.test(document.querySelector("#inclbadge")?.textContent ?? "Verifying"));
    try {
      assert.deepEqual(v.errors, []);
      assert.equal(await v.page.textContent("#inclbadge"), badge);
      assert.equal(await v.page.getAttribute("#inclbadge", "class"), cls);
      const branch: string = await v.page.evaluate(() => [...document.querySelectorAll(".kv > div")].find((d: any) => /^branch/.test(d.textContent))!.nextElementSibling.textContent);
      assert.equal(branch, BRANCH.map((b) => sh(b)).join(" \u00b7 "));
    } finally { await v.close(); }
  });
}

// Numbers read the same under every browser locale, line up in their columns, and a block hash dims its leading zeros
// by colour only.
test("a German-locale browser: amounts grouped with commas, numbers right-aligned in tabular figures, one UTC date format, a block hash whole with its zeros dimmed, no emoji", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, records: "on" });
  INDEXER["/domain/cairnx:v1/proposals"] = [cxProp(931, { v: 1, t: "deploy", ticker: "ZED", supply: "1000000", decimals: 0, mint: "issuer" }),
    cxProp(932, { v: 1, t: "nrenew", name: "zed" }), cxProp(933, { v: 1, t: "offer", give: { name: "zed" }, want: { value: 100000000 } })];
  try {
    const home = await open("/explorer", 1280, () => !!document.querySelector("#actfeed .actrow") && !!document.querySelector("#pu-hr"), { locale: "de-DE" });
    try {
      assert.deepEqual(home.errors, []);
      const cell = await home.page.evaluate(() => { const td = [...document.querySelectorAll("td")].find((c: any) => / CSD$/.test(c.textContent))!;
        const s = getComputedStyle(td); return { text: td.textContent, align: s.textAlign, nums: s.fontVariantNumeric }; });
      assert.deepEqual(cell, { text: "3,750,627.06850941 CSD", align: "right", nums: "tabular-nums" });
      assert.equal(await home.page.textContent(".pu.hot .n"), "121,800");
      const text: string = await home.page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
      assert.deepEqual(await home.page.evaluate(() => [...document.querySelectorAll("#actfeed .kind")].map((k: any) => k.textContent)), ["Token", "Name", "Market"]);
    } finally { await home.close(); }
    const hash = block(TIP).hash;
    Object.assign(INDEXER, { [`/block/${hash}`]: block(TIP), [`/block/${hash}/txids`]: [] });
    const blk = await open(`/explorer#/block/${hash}`, 390, () => /hash/.test(document.querySelector(".kv")?.textContent ?? ""), { locale: "de-DE" });
    try {
      const h = await blk.page.evaluate(() => { const v = document.querySelector(".kv > div:nth-child(2)") as any, z = v.querySelector(".lz");
        return { text: v.textContent, zeros: z.textContent, dim: getComputedStyle(z).color !== getComputedStyle(v).color,
          time: [...document.querySelectorAll(".kv > div")].find((d: any) => d.textContent === "time")!.nextElementSibling.textContent }; });
      assert.equal(h.text, hash, "the hash whole");
      assert.equal(h.zeros, hash.match(/^0x0+/)![0]);
      assert.ok(h.dim, "the zeros dimmed");
      assert.match(h.time, /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}, \d\d:\d\d:\d\d UTC · (now|\d+ (min|h|d) ago)$/);
      assert.equal(await blk.page.textContent("#blkconfs"), "1 confirmation", "the indexer's tip is this block");
      assert.equal(blk.overflow, 0, "horizontal overflow");
    } finally { await blk.close(); }
    // at the indexer's final depth (6 in the fixture's /health) the badge turns to "up"
    const deep = block(TIP - 10);
    Object.assign(INDEXER, { [`/block/${deep.hash}`]: deep, [`/block/${deep.hash}/txids`]: [] });
    const old = await open(`/explorer#/block/${deep.hash}`, 1280, () => !!document.querySelector("#blkconfs"));
    try {
      assert.equal(await old.page.textContent("#blkconfs"), "11 confirmations");
      assert.equal(await old.page.getAttribute("#blkconfs", "class"), "badge ok");
    } finally { await old.close(); }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
});

// The preview's search: "/" outside a field puts the cursor in it; inside a field "/" is a character.
test("\"/\" focuses the search from anywhere on the page and types normally inside a field", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true });
  const v = await open("/explorer", 1280, () => !!document.querySelector("#pu-hr"));
  try {
    await v.page.keyboard.press("/");
    assert.equal(await v.page.evaluate(() => document.activeElement?.id), "q");
    assert.equal(await v.page.inputValue("#q"), "", "the key itself is not typed");
    await v.page.keyboard.type("a/b");
    assert.equal(await v.page.inputValue("#q"), "a/b");
  } finally { await v.close(); }
});

// An address in a detail view is grouped in fours by spacing only: what a reader copies, by selection or the button, is
// the address itself.
test("address page: the address grouped in fours on screen, copied whole by selection and by the copy button", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true });
  const v = await open(`/explorer#/address/${WALLET}`, 1280, () => !!document.querySelector(".kv .g4"));
  try {
    await v.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    const shown = await v.page.evaluate(() => { const val = document.querySelector(".kv > div:nth-child(2)") as any;
      return { groups: val.querySelectorAll(".g4").length, text: val.textContent, inner: val.innerText }; });
    assert.equal(shown.groups, 10, "0x plus nine more groups of four");
    assert.equal(shown.text, WALLET, "the text carries no spaces");
    assert.equal(shown.inner.replace(/\s+$/, ""), WALLET, "nor does the rendered text a selection copies");
    await v.page.click(".kv > div:nth-child(2) button.copy");
    await until(v.page, () => !!document.querySelector("button.copy.done"));
    assert.equal(await v.page.evaluate(() => navigator.clipboard.readText()), WALLET);
    assert.deepEqual(v.errors, []);
  } finally { await v.close(); }
});

// The indexer's state, read from /health: live, the latest-blocks heading says so and the search has its row to itself;
// otherwise one badge beside the search says what is wrong and the heading's "Live" is gone, so the two never disagree.
// The dots are drawn by CSS beside their words: inline they need a box of their own.
const state = (page: any) => page.evaluate(() => {
  const s = document.querySelector("#stats"), lp = document.querySelector("#livepill"), b = s.querySelector(".badge");
  const [sd, ld] = [s, lp].map((e: any) => e.querySelector(".ui-dot")?.getBoundingClientRect()).map((r: any) => r ? r.width > 0 && r.height > 0 : null);
  return { stats: s.hidden ? null : { text: s.textContent, cls: b?.className ?? "", dot: sd }, live: lp.hidden ? null : { text: lp.textContent, dot: ld } };
});
for (const [health, stats] of [["live", null], ["old", { text: "Last block 21 min ago", cls: "badge caution", dot: true }],
  ["behind", { text: "7 blocks behind", cls: "badge caution", dot: true }], ["down", { text: "Indexer offline", cls: "badge bad", dot: true }]] as const) {
  test(`indexer ${health}: ${stats ? `"${stats.text}" beside the search, no "Live" in the latest-blocks heading` : "\"Live\" in the latest-blocks heading, nothing beside the search"}`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true, health: "live" });
    // the home view renders on a live /health; the state is then read again on the page's 15 s timer
    const v = await open("/explorer", 1280, () => !!document.querySelector("#livepill"), { clock: true });
    try {
      assert.deepEqual(await state(v.page), { stats: null, live: { text: "Live", dot: true } });
      S.health = health;
      await v.page.clock.runFor(15_000);
      await until(v.page, () => !!document.querySelector("#livepill") && (document.querySelector("#stats").hidden === !document.querySelector("#livepill").hidden));
      await sleep(300);
      assert.deepEqual(await state(v.page), { stats, live: stats ? null : { text: "Live", dot: true } });
      const row = await v.page.evaluate(() => { const s = document.querySelector("form.ex-search").getBoundingClientRect(), top = document.querySelector(".ex-top").getBoundingClientRect();
        return { inRow: s.top >= top.top && s.bottom <= top.bottom, fills: s.width > 0.8 * top.width }; });
      assert.deepEqual(row, { inRow: true, fills: true }, "the search keeps its row");
    } finally { await v.close(); S.health = "live"; }
  });
}

// The latest-blocks list: ages in the preview's form, and each hash with its leading zeros and eight digits after them.
test("latest blocks: ages read \"now\" and \"1 min\"; a hash shows its zeros dimmed and eight digits, the whole hash in its link", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true });
  for (const width of [390, 1280]) {
    // the page's clock at the fixture's NOW, however long the earlier tests took
    const v = await open("/explorer", width, () => document.querySelectorAll("#blkfeed tr").length > 2, { at: NOW * 1000 });
    try {
      const rows = await v.page.evaluate(() => [...document.querySelectorAll("#blkfeed tr")].slice(0, 2).map((r: any) => {
        const a = r.children[2].querySelector("a"), z = a.querySelector(".lz");
        return { age: r.children[1].textContent, zeros: z.textContent, digits: a.textContent.slice(z.textContent.length).replace(/…$/, ""),
          href: a.getAttribute("href"), title: a.title, cut: a.getBoundingClientRect().right > r.closest(".scroll-x").getBoundingClientRect().right + 0.5 }; }));
      assert.deepEqual(rows.map((r: { age: string }) => r.age), ["now", "1 min"], "the fixture's newest blocks are 30 s and 91 s old");
      for (const [i, r] of rows.entries()) {
        const hash = bhash(TIP - i);
        assert.equal(r.zeros, "0x000000000000");
        assert.equal(r.digits, hash.slice(14, 22), "eight significant digits");
        assert.equal(r.href, `#/block/${hash}`);
        assert.equal(r.title, hash);
        assert.equal(r.cut, false, `the hash inside its box at ${width} px`);
      }
      // every cell of the list inside its box, with the fixture's older rows (ages up to "22 min") setting the widths
      const cut: string[] = await v.page.evaluate(() => [...document.querySelectorAll("#blkfeed td")].filter((c: any) =>
        c.getBoundingClientRect().right > c.closest(".scroll-x").getBoundingClientRect().right + 0.5).map((c: any) => c.textContent));
      assert.deepEqual(cut, [], `no cell past the box at ${width} px`);
      // on a phone the list drops its tx count rather than squeeze the hash
      assert.equal(await v.page.evaluate(() => getComputedStyle(document.querySelector("#blkfeed td:last-child")).display), width < 400 ? "none" : "table-cell");
      assert.equal(v.overflow, 0);
    } finally { await v.close(); }
  }
});

// The home's CairnX activity is a ledger as the preview's latest transactions: the family label, the record in words, the
// transaction. The label moves out of the record into its own column, out of a refused record's strike; the refusal stays
// on the record with its reason. On a phone each row stacks: the label and the transaction, the record under them.
test("home activity: a ledger of kind, record and transaction; a refused record struck with its reason, its label not; stacked at 390 px", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, records: "on" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 3);
  try {
    for (const width of [1280, 390]) {
      const v = await open("/explorer", width, () => document.querySelectorAll("#actfeed tr.actrow").length === 3);
      try {
        assert.deepEqual(v.errors, []);
        assert.equal(v.overflow, 0, "horizontal overflow");
        const rows = await v.page.evaluate(() => [...document.querySelectorAll("#actfeed tr.actrow")].map((r: any) => {
          const [k, rec, tx] = [...r.children] as any[], a = tx.querySelector("a");
          return { kind: k.textContent, struckKind: !!k.closest(".cx-void") || getComputedStyle(k.querySelector(".kind")).textDecorationLine !== "none",
            labelsInRecord: rec.querySelectorAll(".kind").length, struck: !!rec.querySelector(".cx-void"), tag: rec.querySelector(".cx-noeffect")?.textContent ?? null,
            href: a.getAttribute("href"), zeros: /^0x0*$/.test(a.querySelector(".lz")?.textContent ?? ""), stacked: rec.getBoundingClientRect().top >= k.getBoundingClientRect().bottom - 1 };
        }));
        assert.deepEqual(rows.map((r: any) => [r.kind, r.struckKind, r.labelsInRecord, r.href, r.zeros]), PROPS.slice(0, 3).map((p) => ["Token", false, 0, `#/tx/${p.txid}`, true]));
        assert.deepEqual(rows.map((r: any) => [r.struck, r.tag]), [[true, "No effect: mint past supply"], [false, null], [false, null]], "only the refused mint struck, with its reason");
        assert.deepEqual(rows.map((r: any) => r.stacked), Array(3).fill(width < 720), width < 720 ? "the record under the label" : "one line of three cells");
        if (width > 720) assert.deepEqual(await v.page.evaluate(() => [...document.querySelectorAll("#actcol thead th")].map((c: any) => c.textContent)), ["Kind", "Record", "Transaction"]);
      } finally { await v.close(); }
    }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
});

// A read that fails is not a miss. The indexer's 404 means it holds no such record: "Nothing found", naming the value. A
// 500 or a dropped connection says nothing about the record: "Could not load this view" with a way to ask again.
test("a 404 reads \"Nothing found\" with the value; a 500 reads \"Could not load this view\", and Try again loads the view once the indexer answers", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, fail: "" });
  const h = TIP - 100, b = block(h);
  try {
    const miss = await open(`/explorer#/block/${h}`, 1280, () => /Nothing found|Could not load/.test(document.body.innerText));
    try {
      assert.equal(await miss.page.textContent("h2.ex-title"), "Nothing found");
      assert.match(await miss.page.textContent("main"), new RegExp(`no record at ${h}\\.`));
      assert.equal(await miss.page.locator("#retry").count(), 0);
    } finally { await miss.close(); }
    // a pasted value with a malformed escape: still a miss, named as typed, never a view left loading
    const odd = await open("/explorer#/block/0x%E0%A4%A", 1280, () => /Nothing found|Could not load/.test(document.body.innerText));
    try {
      assert.deepEqual(odd.errors, []);
      assert.equal(await odd.page.textContent("h2.ex-title"), "Nothing found");
      assert.match(await odd.page.textContent("main"), /no record at 0x%E0%A4%A\./);
    } finally { await odd.close(); }
    S.fail = "/block-height/";
    const v = await open(`/explorer#/block/${h}`, 1280, () => /Nothing found|Could not load/.test(document.body.innerText));
    try {
      assert.equal(await v.page.textContent("h2.ex-title"), "Could not load this view");
      assert.match(await v.page.textContent("main"), /A read from the indexer failed \(\/block-height\/\d+ answered 500\)/);
      Object.assign(INDEXER, { [`/block-height/${h}`]: b.hash, [`/block/${b.hash}`]: b, [`/block/${b.hash}/txids`]: [] });
      S.fail = "";
      await v.page.click("#retry");
      await until(v.page, () => /^Block /.test(document.querySelector("h2.ex-title")?.textContent ?? ""));
      assert.match(await v.page.textContent("h2.ex-title"), new RegExp(`^Block ${h.toLocaleString("en-US")}`));
    } finally { await v.close(); }
  } finally { S.fail = ""; for (const k of [`/block-height/${h}`, `/block/${b.hash}`, `/block/${b.hash}/txids`]) delete INDEXER[k]; }
});

// The design direction's colour rule, on every view: the neutral ramp, and colour only for up, down and caution (the
// tokens --ui-up, --ui-down, --ui-warn at any alpha). A name's identity avatar is the one other colour, a background image
// this rule does not read; the neutral disc without it is neutral (identity colour belongs to cairn's
// avatar module). A hash's leading zeros are the faint step, below the muted text around them.
const OFF_PALETTE = fileURLToPath(new URL("./fixtures/off-palette.js", import.meta.url));
const offPalette = async (page: any) => page.evaluate(await readFile(OFF_PALETTE, "utf8"));
test("colour on every view: the neutral ramp and the up, down and caution tokens only; a hash's leading zeros in the faint step", { skip: why || false }, async () => {
  Object.assign(S, { market: "fresh", series: true, shell: true, records: "on" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 3);
  const deep = block(TIP - 10);
  Object.assign(INDEXER, { [`/block/${deep.hash}`]: deep, [`/block/${deep.hash}/txids`]: [] });
  const views: [string, () => boolean][] = [
    ["/explorer", () => !!document.querySelector("#actfeed tr.actrow") && !!document.querySelector("#csd-mkt:not([hidden])")],
    [`/explorer#/block/${deep.hash}`, () => !!document.querySelector("#blkconfs")],
    [`/explorer#/tx/${ATTESTS.refusedFill.txid}`, () => !!document.querySelector("#txaction .cx-noeffect")],
    [`/explorer#/address/${BUYER}`, () => !!document.querySelector("#txrows .cx-noeffect")],
    ["/explorer#/name/solo", () => !!document.querySelector(".namehdr .badge")],
    ["/explorer#/name/nobody", () => /Not registered/.test(document.body.innerText)],
    ["/explorer#/token/ZED", () => /metadata/.test(document.body.innerText)],
    [`/explorer#/proposal/${CONTENT_PROPS.good.txid}`, () => /verified/.test(document.querySelector("#cibadge")?.textContent ?? "")],
  ];
  try {
    for (const scheme of ["light", "dark"] as const) for (const [path, ready] of views) {
      const v = await open(path, 1280, ready, { scheme });
      try {
        assert.deepEqual(await offPalette(v.page), [], `${path} ${scheme}`);
      } finally { await v.close(); }
    }
    const v = await open(`/explorer#/block/${deep.hash}`, 1280, () => !!document.querySelector(".kv .lz"), { scheme: "light" });
    try {
      const c = await v.page.evaluate(() => { const p = document.createElement("span"); document.body.append(p);
        const [faint, muted] = ["--ui-faint", "--ui-muted"].map((n) => { p.style.color = `var(${n})`; return getComputedStyle(p).color; });
        return { zeros: getComputedStyle(document.querySelector(".kv .lz")).color, faint, muted }; });
      assert.equal(c.zeros, c.faint, "the zeros in the faint step");
      assert.notEqual(c.faint, c.muted);
    } finally { await v.close(); }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; delete INDEXER[`/block/${deep.hash}`]; delete INDEXER[`/block/${deep.hash}/txids`]; }
});

// A block mined while the page is open enters the latest blocks at the top, once, as the preview's does: it fades in and
// drops 14 px into place over 460 ms on the shared curve; the rows under it move down without an animation of their own,
// and a poll that finds nothing new starts none. With reduced motion the page's own sheet asks for a fade with no
// movement; cairn's real components.css (not this file's stand-in) cuts every animation to 1 ms under reduced motion, so
// through the front door the row appears at once, as the preview's does.
const arrival = (page: any) => page.evaluate(() => [...document.querySelectorAll("#blkfeed tr")].map((r: any) => r.getAnimations().map((a: any) => {
  const t = a.effect.getTiming(), k = a.effect.getKeyframes();
  return { h: r.dataset.h, name: a.animationName, ms: t.duration, ease: t.easing, from: k[0] ? { opacity: k[0].opacity, transform: k[0].transform ?? null } : null };
})).flat());
for (const reduced of [false, true]) {
  test(`a new block enters the latest blocks once${reduced ? ", with reduced motion the page's sheet asking for a fade only" : ": a fade and a 14 px drop over 460 ms; the rows under it take no animation"}`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true, newer: 0 });
    const v = await open("/explorer", 1280, () => document.querySelectorAll("#blkfeed tr").length === 12, { clock: true, reduced });
    try {
      assert.deepEqual(await arrival(v.page), [], "the first paint enters nothing");
      S.newer = 1;
      await v.page.clock.runFor(12_000);
      await until(v.page, () => document.querySelector("#blkfeed tr")?.getAttribute("data-h") === String(121_801));
      const first = await arrival(v.page);
      assert.deepEqual(first.map((a: any) => [a.h, a.name, a.ms]), [["121801", reduced ? "ex-fade-in" : "ex-row-in", 460]]);
      assert.equal(first[0].from.opacity, "0");
      if (reduced) assert.equal(first[0].from.transform, null, "no movement");
      else assert.match(first[0].from.transform, /translateY\(-14px\)/);
      assert.equal(await v.page.textContent(".pu.hot .n"), "121,801", "the height in the strip follows");
      await v.page.clock.runFor(12_000);
      await sleep(300);
      assert.deepEqual((await arrival(v.page)).map((a: any) => a.h), ["121801"], "a poll with nothing new starts no animation");
    } finally { await v.close(); S.newer = 0; }
  });
}

// One gutter: a heading, the table or list under it and the panel's other content start at the same x, at every width. A
// "box:" selector is measured at its border edge (a field or a pill lines up by its outline), the others at their text.
const gutter = (page: any, pairs: [string, string][]) => page.evaluate((pairs: [string, string][]) => pairs.map(([a, b]) => ({ a, b,
  at: [a, b].map((sel) => { const e = document.querySelector(sel.replace(/^box:/, "")); if (!e) return null;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return Math.round(r.left + (sel.startsWith("box:") ? 0 : parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth))); }) }))
  .filter((x) => x.at[0] === null || x.at[0] !== x.at[1]), pairs);
for (const width of [390, 1280]) {
  test(`one gutter at ${width} px: headings line up with the rows, lists and fields under them; a block's two key columns start level; keys 16 px under a detail title`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true, records: "on" });
    INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 3);
    try {
      const home = await open("/explorer", width, () => !!document.querySelector("#actfeed .actrow") && !!document.querySelector("#blkfeed tr"));
      try {
        assert.deepEqual(await gutter(home.page, [
          [".ex-col:first-child > h2", "#blkfeed tr:first-child td:first-child"],
          ["#actcol > h2", "#actfeed .actrow:first-child td:first-child"],
          [".ex-col:first-child > h2", ".pulse > .pu:first-child"],
          [".ex-col:first-child > h2", "box:form.ex-search"],
          [".row .panel:has(table) > h2", ".row .panel:has(table) tbody tr:first-child td:first-child"],
          ["#csd-mkt ~ .muted, .panel:has(#emchart) > h2", ".panel:has(#emchart) .facts"],
        ]), []);
      } finally { await home.close(); }
      const hash = block(TIP - 2).hash;
      Object.assign(INDEXER, { [`/block/${hash}`]: block(TIP - 2), [`/block/${hash}/txids`]: ["0x" + "e1".repeat(32)] });
      const blk = await open(`/explorer#/block/${hash}`, width, () => !!document.querySelector("#blkconfs") && document.querySelectorAll("tbody tr").length > 0);
      try {
        assert.deepEqual(await gutter(blk.page, [["h2.ex-title", ".kv > div:first-child"], ["main > .panel:nth-child(2) > h2", "main > .panel:nth-child(2) tbody tr:first-child td:first-child"]]), []);
        const [a, b] = await blk.page.evaluate(() => [...document.querySelectorAll(".ex-detail > .kv")].map((k: any) => { const r = k.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), end: Math.round(r.bottom) }; }));
        if (width > 860) assert.equal(b.top, a.top, "side by side, the second key column starts level with the first");
        else assert.ok(b.left === a.left && b.top > a.end, "stacked, the second key list follows the first");
      } finally { await blk.close(); }
      // a detail page's keys start 16 px under its title, as the preview's block, whatever follows the title
      const gaps: number[] = [];
      for (const path of [`/explorer#/block/${hash}`, "/explorer#/token/ZED", `/explorer#/address/${BUYER}`]) {
        const d = await open(path, width, () => !!document.querySelector("h2.ex-title + .kv, h2.ex-title + .ex-detail"));
        try {
          gaps.push(await d.page.evaluate(() => { const h = document.querySelector("h2.ex-title"); return Math.round(h.nextElementSibling.getBoundingClientRect().top - h.getBoundingClientRect().bottom); }));
        } finally { await d.close(); }
      }
      assert.deepEqual(gaps, [16, 16, 16], "title to keys on the block, token and address pages");
    } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
  });
}

// The search's placeholder fits its field, measured in the field's own font: the short form on a phone, the long one on a desktop.
for (const width of [360, 390, 1280]) {
  test(`the search placeholder fits its field at ${width} px`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true });
    const v = await open("/explorer", width, () => !!document.querySelector("#pu-hr"));
    try {
      const m = await v.page.evaluate(() => { const q = document.querySelector("#q") as any, s = getComputedStyle(q), c = document.createElement("canvas").getContext("2d") as any;
        c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
        return { text: q.placeholder, need: Math.ceil(c.measureText(q.placeholder).width), room: q.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) }; });
      assert.ok(m.need <= m.room, `"${m.text}" needs ${m.need} px, the field has ${m.room}`);
      assert.equal(m.text, width < 480 ? "Block, tx, address or name.csd" : "Search a block, transaction, address or name.csd");
    } finally { await v.close(); }
  });
}

// ── Wave R10 fix round: a sibling read in three states, the activity's verdicts, the name page, the search, the domain
// ledger, motion, the trust statement, the charts' reference lines and the block page. ──
const text = (v: View) => v.page.evaluate(() => document.querySelector("main").innerText as string);

// A name's page asks the resolver. Its 404 for a valid name is its answer that nobody holds it: "Not registered". A read
// that fails (the front door's 502, the resolver's 503 before its first scan) says nothing: "Could not check", never a
// verdict, with Try again. Standalone there is no resolver to ask; a label outside the name rule is never asked.
for (const cx of ["503", "502"] as const) {
  test(`name page, the resolver answering ${cx}: "Could not check", never "Not registered"; Try again shows the name once it answers`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true, cx });
    try {
      for (const name of ["solo", "nobody"]) {
        const v = await open(`/explorer#/name/${name}`, 1280, () => !document.querySelector("main .skel"));
        try {
          assert.deepEqual(v.errors, []);
          const t = await text(v);
          assert.match(t, /Could not check this name right now, so it is not shown as available\. Try again/);
          assert.equal(await v.page.textContent(".namehdr .badge"), "Could not check");
          assert.doesNotMatch(t, /Not registered|Register it|Available/);
          if (name === "solo") {
            S.cx = "up";
            await v.page.click("[data-again]");
            await until(v.page, () => /resolves to/i.test(document.body.innerText));
            S.cx = cx;
          }
        } finally { await v.close(); }
      }
    } finally { S.cx = "up"; }
  });
}
test("name page: the resolver's 404 reads \"Not registered\"; standalone needs the front door; a label outside the name rule is not asked; the resolver up shows the name", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up" });
  const miss = await open("/explorer#/name/nobody", 1280, () => !document.querySelector("main .skel"));
  try {
    assert.match(await text(miss), /^N\s+nobody\.csd\s+Not registered\. Register it on \/names$/, "the initial on its disc, the name, the miss");
    assert.equal(await miss.page.locator("[data-again]").count(), 0);
  } finally { await miss.close(); }
  const alone = await open("/#/name/solo", 1280, () => !document.querySelector("main .skel"));
  try { assert.match(await text(alone), /need the cairn front door/); } finally { await alone.close(); }
  const bad = await open("/explorer#/name/bad-", 1280, () => !document.querySelector("main .skel"));
  try {
    assert.match(await text(bad), /Not a \.csd name/);
    assert.deepEqual(bad.asked.filter((x) => x.startsWith("/trade/api/cairnx/name/")), [], "never asked");
  } finally { await bad.close(); }
  const up = await open("/explorer#/name/solo", 1280, () => /resolves to/i.test(document.body.innerText));
  try { assert.deepEqual(up.errors, []); assert.doesNotMatch(await text(up), /Could not check|Not registered/); } finally { await up.close(); }
});

// The token page and the home's tokens panel read the resolver the same way.
test("token page: 404 \"No token with that ticker\"; 503 \"Could not check this token\" with Try again; standalone needs the front door; up shows the token", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up" });
  try {
    const miss = await open("/explorer#/token/NOPE", 1280, () => !document.querySelector("main .skel"));
    try { assert.match(await text(miss), /^Token\s+NOPE\s+No token with that ticker on CairnX\./); } finally { await miss.close(); }
    S.cx = "503";
    const down = await open("/explorer#/token/ZED", 1280, () => !document.querySelector("main .skel"));
    try {
      const t = await text(down);
      assert.match(t, /^Token\s+ZED\s+Could not check this token right now\. Try again$/);
      assert.doesNotMatch(t, /front door|No token/);
      S.cx = "up";
      await down.page.click("[data-again]");
      await until(down.page, () => /metadata/.test(document.body.innerText));
    } finally { await down.close(); }
    const alone = await open("/#/token/ZED", 1280, () => !document.querySelector("main .skel"));
    try { assert.match(await text(alone), /Token data needs the cairn front door/); } finally { await alone.close(); }
  } finally { S.cx = "up"; }
});
test("home tokens panel: the resolver down reads \"Could not check the CairnX tokens\", never the standalone line; standalone says it has no resolver; up lists them", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true });
  const note = (v: View) => v.page.evaluate(() => [...document.querySelectorAll(".panel")].find((p: any) => /^Tokens on CairnX/.test(p.querySelector("h2")?.textContent ?? ""))!.innerText as string);
  try {
    for (const [cx, at, want, not] of [["503", "/explorer", /Could not check the CairnX tokens right now\. Try again/, /standalone/],
      ["up", "/", /this standalone view has no token resolver/, /Could not check/], ["up", "/explorer", /Every token is CairnX/, /Could not check|standalone/]] as const) {
      S.cx = cx;
      const v = await open(at, 1280, () => !!document.querySelector("#pu-hr") && /Tokens on CairnX[\s\S]+\S/.test(document.body.innerText) && !!document.querySelector("#tok-note, .ex-unread"));
      try {
        await until(v.page, () => /Could not check the CairnX|standalone view has no token|Every token is/.test(document.body.innerText));
        const t = await note(v);
        assert.match(t, want, `${cx} ${at}`);
        assert.doesNotMatch(t, not, `${cx} ${at}`);
      } finally { await v.close(); }
    }
  } finally { S.cx = "up"; }
});

// With the verdicts unread, a record reads as the request it makes and the ledger says why, in one quiet line; with them
// read there is no such line. On a transaction's page the same for its one record.
test("verdicts unread: one quiet line on the home ledger and the domain page, every record a request and none struck; read, no line; standalone says so", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 3);
  const LINE = "Could not check these records with the CairnX resolver right now, so none is shown as applied. Try again";
  try {
    for (const [records, at, path, line] of [["500", "/explorer", "", LINE], ["on", "/explorer", "", null],
      ["500", "/explorer", "#/domain/cairnx%3Av1", LINE], ["on", "/", "", "This standalone view has no CairnX resolver to ask, so each record reads as the request it makes."]] as const) {
      S.records = records;
      const v = await open(at + path, 1280, () => document.querySelectorAll("td.act").length >= 3);
      try {
        assert.deepEqual(v.errors, []);
        assert.equal(await v.page.evaluate(() => document.querySelector("#verdict-line")?.textContent ?? null), line, `${records} ${at}${path}`);
        const struck = await v.page.locator(".cx-void").count();
        assert.equal(struck, records === "on" && at === "/explorer" ? 1 : 0, "struck only with a read verdict");
        if (line) for (const a of await v.page.evaluate(() => [...document.querySelectorAll("td.act")].map((c: any) => c.textContent))) assert.match(a, /Mint request for/);
      } finally { await v.close(); }
    }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; S.records = "on"; }
});
test("transaction page, the resolver failing: an Attest on an offer reads as its request with the record's quiet line, never \"Bought\"", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "503" });
  try {
    const v = await open(`/explorer#/tx/${ATTESTS.fill.txid}`, 1280, decoded);
    try {
      assert.equal(await v.page.textContent("#txaction"), `${ATTEST_LINES.unread}Could not check this record with the CairnX resolver right now, so it is not shown as applied. Try again`);
      assert.equal(await v.page.locator("#txaction .cx-void").count(), 0);
    } finally { await v.close(); }
  } finally { S.cx = "up"; }
});

// On a name's own page the owner and the address it resolves to are addresses, in groups of four; the owner's primary
// name stands beside it only when it is another name.
test("name page: owner and resolves-to as grouped addresses, the primary name beside them only when it is another name", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up" });
  const rows = (v: View) => v.page.evaluate(() => [...document.querySelectorAll(".ex-detail .kv > div")].filter((d: any) => /^(owner|resolves to)$/.test(d.textContent))
    .map((d: any) => { const v = d.nextElementSibling, a = v.querySelector("a.addrl");
      return { link: a.textContent, groups: a.querySelectorAll(".g4").length, named: a.classList.contains("hasname"), chip: v.querySelector(".chip")?.textContent ?? null }; }));
  // the detail form of an address: 0x and its first eight digits, an ellipsis, its last eight, in four groups
  const grouped = `${MINER.slice(0, 10)}\u2026${MINER.slice(34)}`;
  PRIMARIES[MINER] = "solo";   // so the page's address labelling would name these rows, were they left to it
  try {
    for (const [name, chip] of [["twin", "primary name solo.csd"], ["solo", null]] as const) {
      const v = await open(`/explorer#/name/${name}`, 1280, () => /resolves to/i.test(document.body.innerText));
      try {
        await sleep(400); // past the page's name labelling, which must leave these two alone
        assert.deepEqual(v.errors, []);
        assert.deepEqual(await rows(v), Array(2).fill({ link: grouped, groups: 4, named: false, chip }), name);
      } finally { await v.close(); }
    }
  } finally { delete PRIMARIES[MINER]; }
});

// The search: a number, a hash or an address as pasted (spaces, separators, no 0x), a name in one word, and anything else
// a domain only when the indexer knows it; otherwise "Nothing found" naming what was searched.
test("search: each kind of query lands on its page; \"hello world\" and 40 x's are \"Nothing found\" naming the query; a known domain is its page", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 3);
  const h = TIP - 3;
  try {
    const v = await open("/explorer", 1280, () => !!document.querySelector("#pu-hr"));
    try {
      const go = async (q: string, want: string) => {
        await v.page.fill("#q", q); await v.page.press("#q", "Enter");
        for (const end = Date.now() + 5000; (await v.page.evaluate(() => location.hash)) !== want && Date.now() < end;) await sleep(50);
        await until(v.page, () => !document.querySelector("main .skel"));
        return v.page.evaluate(() => location.hash as string);
      };
      for (const [q, want] of [[h.toLocaleString("en-US"), `#/block/${h}`], [` ${String(h).slice(0, 3)} ${String(h).slice(3)} `, `#/block/${h}`],
        [MINER.slice(2), `#/address/${MINER}`], ["0x" + MINER.slice(2).toUpperCase(), `#/address/${MINER}`], ["solo.csd", "#/name/solo"], ["Solo", "#/name/solo"],
        [PROVEN, `#/tx/${PROVEN}`], ["0x" + "ab".repeat(32), "#/tx/0x" + "ab".repeat(32)], ["999999", "#/block/999999"], ["twin.CSD", "#/name/twin"],
        ["cairnx:v1", "#/domain/cairnx%3Av1"]] as const) {
        assert.equal(await go(q, want), want, JSON.stringify(q));
      }
      for (const q of ["hello world", "x".repeat(40)]) {
        assert.equal(await go(q, "#/search/" + encodeURIComponent(q)), "#/search/" + encodeURIComponent(q), q);
        // this query's miss, not the one before it
        for (const end = Date.now() + 5000; !(await v.page.evaluate((q: string) => document.body.innerText.includes(`matches \u201c${q}\u201d.`), q)) && Date.now() < end;) await sleep(50);
        assert.equal(await v.page.textContent("h2.ex-title"), "Nothing found");
        assert.match(await text(v), new RegExp(`domain on this indexer matches \u201c${q}\u201d\\.`));
      }
      assert.deepEqual(v.errors, []);
    } finally { await v.close(); }
    // a link to a domain with no proposals: the same miss
    const d = await open("/explorer#/domain/hello%20world", 1280, () => /Nothing found/.test(document.body.innerText));
    try { assert.match(await text(d), /no proposals in the domain \u201chello world\u201d\./); } finally { await d.close(); }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
});

// A domain's ledger: the indexer's newest 100, its total from /domains, then 100 more a read.
test("domain page: the total from /domains over the newest 100, Load more to the end; without the total \"Latest 100\"", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up", records: "on", paged: true, fail: "" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS;
  PAGED_TOTAL = PROPS.length;
  const state = (v: View) => v.page.evaluate(() => ({ count: (document.querySelector("#domcount")?.textContent ?? "").split(".")[0], rows: document.querySelectorAll("#domrows tr").length,
    more: document.querySelector("#domloadmore")?.textContent ?? null }));
  try {
    for (const [fail, head, more] of [["", "130 proposals", "Load more (100 of 130)"], ["/domains", "Latest 100", "Load more (100)"]] as const) {
      S.fail = fail;
      const v = await open("/explorer#/domain/cairnx%3Av1", 1280, () => document.querySelectorAll("#domrows tr").length > 0);
      try {
        assert.deepEqual(await state(v), { count: head, rows: 100, more });
        await v.page.click("#domloadmore");
        await until(v.page, () => document.querySelectorAll("#domrows tr").length === 130);
        assert.deepEqual(await state(v), { count: fail ? "Latest 130" : head, rows: 130, more: null });
        assert.equal(await v.page.locator(".cx-noeffect").count(), 1, "the refused mint among them, once");
      } finally { await v.close(); }
    }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; S.paged = false; S.fail = ""; PAGED_TOTAL = null; }
});

// The activity is read again on every new block, by the same poll; a record not shown before enters as a new block does.
test("home activity: a record that lands with a new block enters at the top with the block's row-in; the rows under it and a poll with nothing new move nothing", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up", records: "on", newer: 0 });
  const later = cxProp(140, { v: 1, t: "mint", ticker: "CAIRN", amount: "100" });
  later.height = TIP + 1;
  applied(later);
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(1, 4);
  const moving = (page: any) => page.evaluate(() => [...document.querySelectorAll("#actfeed tr")].flatMap((r: any) => r.getAnimations().map((a: any) =>
    [r.querySelector("td.r a").getAttribute("href").slice(5), a.animationName, a.effect.getTiming().duration])));
  try {
    const v = await open("/explorer", 1280, () => document.querySelectorAll("#actfeed tr.actrow").length === 3, { clock: true });
    try {
      assert.deepEqual(await moving(v.page), [], "the first paint enters nothing");
      INDEXER["/domain/cairnx:v1/proposals"] = [later, ...PROPS.slice(1, 4)];
      S.newer = 1;
      await v.page.clock.runFor(12_000);
      await until(v.page, () => document.querySelectorAll("#actfeed tr.actrow").length === 4);
      assert.deepEqual(await moving(v.page), [[later.txid, "ex-row-in", 460]]);
      assert.match(await v.page.textContent("#actfeed tr:first-child td.act"), /^\s*Minted CAIRN/);
      await v.page.clock.runFor(12_000);
      await sleep(300);
      assert.deepEqual((await moving(v.page)).map((m: any) => m[0]), [later.txid], "nothing new: no second entrance");
    } finally { await v.close(); }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; S.newer = 0; delete VERDICTS[later.txid]; }
});

// A route change crossfades the two views on the shared curve: the page's view transition, 320 ms; with reduced motion
// the same crossfade. The first paint runs none. Without the API the new view fades in.
const VT_PROBE = () => { const o = (document as any).startViewTransition; if (o) (document as any).startViewTransition = function (cb: any) { (window as any).__vt = ((window as any).__vt || 0) + 1; return o.call(document, cb); }; };
const NO_VT = () => { delete (Document.prototype as any).startViewTransition; };
// polled from here: a function named inside a page callback would need a helper the page lacks
async function crossfade(page: any): Promise<any[]> {
  for (const end = Date.now() + 3000; Date.now() < end; await sleep(10)) {
    // a CSS animation's curve is on its keyframes (its own timing easing is linear)
    const a = await page.evaluate(() => document.getAnimations().map((x: any) => ({ el: x.effect?.pseudoElement ?? x.effect?.target?.id ?? "", ms: x.effect?.getTiming().duration,
      ease: x.effect?.getTiming().easing !== "linear" ? x.effect?.getTiming().easing : x.effect?.getKeyframes()[0]?.easing, op: !!x.effect?.getKeyframes().some((k: any) => "opacity" in k) }))
      .filter((x: any) => /view-transition-(old|new)\(root\)/.test(x.el) || (x.el === "view" && x.op)));
    if (a.length) return a;
  }
  return [];
}
for (const [mode, init, reduced] of [["view transition", VT_PROBE, false], ["view transition, reduced motion", VT_PROBE, true], ["no view transition API", NO_VT, false]] as const) {
  test(`a route change crossfades the views (${mode})`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, shell: true, cx: "up" });
    const v = await open("/explorer", 1280, () => !!document.querySelector("#blkfeed tr"), { init, reduced });
    try {
      assert.equal(await v.page.evaluate(() => (window as any).__vt ?? 0), 0, "the first paint swaps at once");
      const hash = bhash(TIP - 3);
      await v.page.evaluate((h: string) => { location.hash = "#/block/" + h; }, hash);
      const seen = await crossfade(v.page);
      if (init === NO_VT) assert.deepEqual(seen.map((a) => [a.el, a.ms, a.ease]), [["view", 200, "cubic-bezier(0.16, 1, 0.3, 1)"]]);
      else {
        assert.equal(await v.page.evaluate(() => (window as any).__vt), 1);
        // the old view out and the new one in (Chromium runs a fade and a blend on each), all 320 ms on the shared curve
        assert.deepEqual([...new Set(seen.map((a) => JSON.stringify([a.el, a.ms, a.ease])))].sort(), [["::view-transition-new(root)", 320, "cubic-bezier(0.16, 1, 0.3, 1)"],
          ["::view-transition-old(root)", 320, "cubic-bezier(0.16, 1, 0.3, 1)"]].map((x) => JSON.stringify(x)));
      }
      await until(v.page, () => !document.querySelector("main .skel") && !!document.querySelector("h2.ex-title"));
      assert.deepEqual(v.errors, []);
    } finally { await v.close(); }
  });
}

// The charts' reference levels (the 120 s target, the emission so far) are dashed lines without an axis label, which
// would cover a tick; the block-times scale has its top half a 50 s step above a tick, so no label sits cut at the edge.
test("charts: the target and the emission so far as dashed lines with no axis label; the block-times domain puts the padded top half a 50 s step above a tick", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true });
  const v = await open("/explorer", 1280, charted);
  try {
    const c = await v.page.evaluate(() => Object.fromEntries(["#btchart", "#emchart"].map((s) => { const d = document.querySelector(`${s} canvas`).dataset; return [s, { lines: d.priceLines, extra: d.extra, hi: Number(d.domainHi) }]; })));
    assert.deepEqual([c["#btchart"].lines, c["#btchart"].extra], ["0", "120/120 dashed"]);
    assert.equal(c["#emchart"].lines, "0");
    assert.match(c["#emchart"].extra, /^(\d+(\.\d+)?)\/\1 dashed$/, "one level across the schedule");
    const top = c["#btchart"].hi * (1 + 0.18 / 0.7);
    assert.ok(c["#btchart"].hi >= 240, "room for the target");
    assert.ok(Math.abs((top % 50) - 25) < 1e-6, `the padded top ${top} half a step above a tick`);
  } finally { await v.close(); }
});

// A registered name draws cairn's identity avatar, seeded as /names seeds a name; without the module, or for a name
// nobody holds, its initial on the neutral disc.
test("name page: cairn's identity avatar for a registered name, seeded by the name; the neutral disc without the module and for a name nobody holds", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up" });
  const av = (v: View) => v.page.evaluate(() => { const a = document.querySelector(".namehdr > :first-child") as any;
    return { avatar: a.classList.contains("ui-avatar"), seed: a.dataset.seed ?? null, letter: a.textContent, painted: /gradient/.test(a.style.background) }; });
  try {
    for (const [avatar, name, want] of [[true, "solo", { avatar: true, seed: "solo", letter: "", painted: true }], [false, "solo", { avatar: false, seed: null, letter: "S", painted: false }],
      [true, "nobody", { avatar: false, seed: null, letter: "N", painted: false }]] as const) {
      S.avatar = avatar;
      const v = await open(`/explorer#/name/${name}`, 1280, () => !!document.querySelector(".namehdr"));
      try {
        assert.deepEqual(await av(v), want, `${name}, module ${avatar ? "present" : "absent"}`);
        assert.deepEqual(v.errors, []);
      } finally { await v.close(); }
    }
  } finally { S.avatar = true; }
});

// every element.animate() the page asks for, on the element it moves
const SLIDES = () => { const o = (Element as any).prototype.animate; (Element as any).prototype.animate = function (k: any[], t: any) {
  ((window as any).__slides ??= []).push({ n: this, what: `${k[0].transform} ${k[0].opacity} to ${k[1].opacity} over ${t.duration} ms` }); return o.call(this, k, t); }; };
// A CSD/USD figure that moved on a re-read updates as the preview's price: it slides in from the side it moved to with a
// short tint (reduced motion: the tint only); one that did not move stays still.
for (const reduced of [false, true]) {
  test(`market: a price that moved slides in and flashes up${reduced ? " (reduced motion: the flash only)" : ""}; the figures that did not move stay still`, { skip: why || false }, async () => {
    Object.assign(S, { market: "fresh", thin: false, partial: false, series: true, shell: true });
    const v = await open("/explorer", 1280, () => !!document.querySelector("#csd-mkt .mkt-fig"), { clock: true, reduced, init: SLIDES });
    const moving = () => v.page.evaluate(() => [...document.querySelectorAll("#csd-mkt .mkt-fig")].map((f: any) => { const n = f.querySelector(".mkt-n");
      return [f.dataset.label, [...n.classList].filter((c: string) => /^ex-flash/.test(c)).concat(((window as any).__slides ?? []).filter((x: any) => x.n === n).map((x: any) => x.what))]; })
      .filter((x: any) => x[1].length));
    try {
      assert.deepEqual(await moving(), [], "the first paint moves nothing");
      PRICE.last = 0.0466;
      await minutes(v.page, 3); // past the 2 min re-read
      await until(v.page, () => !!document.querySelector("#csd-mkt .mkt-n.ex-flash-up, #csd-mkt .mkt-n.ex-flash-down"));
      assert.deepEqual(await moving(), [["price", reduced ? ["ex-flash-up"] : ["ex-flash-up", "translateY(60%) 0 to 1 over 320 ms"]]]);
      assert.equal((await figures(v.page))[0].value, "0.0466 USD");
    } finally { await v.close(); PRICE.last = 0.0455; }
  });
}

// The block page: a Next link to the block above it, the indexer's tip says so; difficulty as a grouped integer.
test("block page: Next links the block above, the indexer's tip has none yet; difficulty as a grouped integer", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true });
  const at = (h: number) => ({ [`/block-height/${h}`]: bhash(h), [`/block/${bhash(h)}`]: block(h), [`/block/${bhash(h)}/txids`]: [] });
  Object.assign(INDEXER, at(TIP - 2), at(TIP - 1), at(TIP));
  const key = (v: View, k: string) => v.page.evaluate((k: string) => [...document.querySelectorAll(".kv > div")].find((d: any) => d.textContent === k)!.nextElementSibling.textContent as string, k);
  try {
    const mid = await open(`/explorer#/block/${bhash(TIP - 2)}`, 1280, () => !!document.querySelector("#blknext"));
    try {
      assert.equal(await mid.page.getAttribute("#blknext a", "href"), `#/block/${bhash(TIP - 1)}`);
      // bits 0x1b00c636: the target is 0xc636 << 192, so the difficulty is 0xffff·2^208 over it
      const d = Number((0xffffn * 2n ** 208n * 1000n) / (0xc636n << 192n)) / 1000;
      assert.equal(await key(mid, "difficulty"), `${Math.round(d).toLocaleString("en-US")} · bits 0x1b00c636`);
    } finally { await mid.close(); }
    const top = await open(`/explorer#/block/${bhash(TIP)}`, 1280, () => !!document.querySelector("#blknext"));
    try { assert.equal(await top.page.textContent("#blknext"), "None yet: this is the indexer's tip"); } finally { await top.close(); }
  } finally { for (const h of [TIP - 2, TIP - 1, TIP]) for (const k of Object.keys(at(h))) delete INDEXER[k]; }
});

// Every negative figure carries the one minus sign, U+2212.
test("address ledger: an amount paid out reads with the minus sign U+2212, never a hyphen", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true });
  const v = await open(`/explorer#/address/${WALLET}`, 1280, () => !document.querySelector("#txrows td[id^=dir-]") && document.querySelectorAll("#txrows tr").length === 25);
  try {
    const amounts: string[] = await v.page.evaluate(() => [...document.querySelectorAll("#txrows td.num:last-child")].map((c: any) => c.textContent));
    assert.deepEqual([...new Set(amounts)], ["−0.25 CSD"]);
  } finally { await v.close(); }
});

// Side by side the two home lists end level: as many rows each, the same row height, the block list capped at what it
// shows; the activity's View all opens the domain's ledger.
test("home at 1280 px: latest blocks and the activity show 12 rows each of one height and end level, also after a new block; View all opens the domain", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up", records: "on", newer: 0 });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 30);
  const cols = (page: any) => page.evaluate(() => {
    const [blocks, acts] = ["#blkfeed tr", "#actfeed tr"].map((sel) => { const rs = [...document.querySelectorAll(sel)].map((r: any) => r.getBoundingClientRect());
      return { n: rs.length, heights: [...new Set(rs.map((r) => Math.round(r.height)))], end: Math.round(rs.at(-1)!.bottom) }; });
    return { blocks, acts, more: !!document.querySelector("#actshowmore"), all: document.querySelector("#actcol h2 .h-side > a")?.getAttribute("href") ?? null };
  });
  try {
    const v = await open("/explorer", 1280, () => document.querySelectorAll("#actfeed tr.actrow").length > 0, { clock: true });
    try {
      for (const when of ["first paint", "after a new block"]) {
        const c = await cols(v.page);
        assert.equal(c.blocks.n, 12, when); assert.equal(c.acts.n, 12, when);
        assert.equal(c.blocks.heights.length, 1, `${when}: one block row height`);
        assert.deepEqual(c.acts.heights, c.blocks.heights, `${when}: the same row height in both lists`);
        assert.equal(c.acts.end, c.blocks.end, `${when}: the two lists end level`);
        assert.deepEqual([c.more, c.all], [false, "#/domain/cairnx%3Av1"]);
        S.newer = 1;
        await v.page.clock.runFor(12_000);
        await until(v.page, () => document.querySelector("#blkfeed tr")?.getAttribute("data-h") === String(121_801));
        await sleep(300);
      }
      // the record cut to its line keeps its whole text in its title, and a refusal's tag whole after it
      const cut = await v.page.evaluate(() => { const t = document.querySelector("#actfeed tr:first-child .act-t") as any, tag = t.parentElement.querySelector(".cx-noeffect");
        return { title: t.title, tag: tag ? tag.getBoundingClientRect().right <= t.closest("td").getBoundingClientRect().right + 0.5 : null }; });
      assert.match(cut.title, /^Mint request for CAIRN: 100 base units$/);
      assert.equal(cut.tag, true, "the refusal's tag inside its cell");
    } finally { await v.close(); }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; S.newer = 0; }
});

// A stacked ledger (390 px) keeps its heads on one line: the row's id, the record under it, the figure at the right.
test("at 390 px the stacked ledgers' heads sit on one line", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up", records: "on" });
  INDEXER["/domain/cairnx:v1/proposals"] = PROPS.slice(0, 3);
  const heads = (v: View) => v.page.evaluate(() => { const ths = [...document.querySelectorAll("table.stack thead th")].filter((t: any) => t.getBoundingClientRect().width > 0) as any[];
    return { tops: [...new Set(ths.map((t) => Math.round(t.getBoundingClientRect().top)))].length, text: ths.map((t) => t.textContent) }; });
  try {
    for (const [path, ready, text] of [[`/explorer#/address/${WALLET}`, () => document.querySelectorAll("#txrows tr").length > 0, ["Txid", "Record", "Amount"]],
      ["/explorer#/name/twin", () => /history \(/i.test(document.body.innerText), ["Tx", "Record", "Block"]],
      ["/explorer#/domain/cairnx%3Av1", () => document.querySelectorAll("#domrows tr").length > 0, ["Proposal", "Record", "Height"]]] as const) {
      const v = await open(path, 390, ready);
      try {
        const h = await heads(v);
        assert.equal(h.tops, 1, `${path}: ${h.text.join(", ")}`);
        assert.deepEqual(await v.page.evaluate(() => [...document.querySelectorAll("table.stack thead th")].filter((t: any) => t.getBoundingClientRect().width > 0)
          .sort((a: any, b: any) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map((t: any) => t.textContent)), text);
      } finally { await v.close(); }
    }
  } finally { INDEXER["/domain/cairnx:v1/proposals"] = []; }
});

// A token's trust badge, the design direction's three, from cairn's list of the tokens it lists (bound to their deploys)
// judged by /trade's rule; with the list unread, no badge rather than a verdict.
test("token page: Verified for a listed deploy, Look-alike for another deploy of a listed ticker, Unverified when not listed, no badge with the list unread", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up", trust: true });
  const ZED_DEPLOY = "0x" + "de".repeat(32);
  const look = (v: View) => v.page.evaluate(() => { const b = document.querySelector("h2.ex-title .badge") as any;
    const row = [...document.querySelectorAll(".kv > div")].find((d: any) => d.textContent === "listing") as any;
    return { badge: b ? b.textContent : null, cls: b ? b.className : null, said: row ? row.nextElementSibling.textContent : null }; });
  try {
    for (const [list, trust, want] of [
      [{ ZED: { deployId: ZED_DEPLOY } }, true, { badge: "Verified", cls: "badge ok", said: "Listed by Cairn for this deploy. A display convenience, not a consensus claim." }],
      [{ ZED: { deployId: "0x" + "01".repeat(32) } }, true, { badge: "Look-alike", cls: "badge caution", said: "Same ticker as a listed token, different deploy. Anyone can deploy any ticker." }],
      [{}, true, { badge: "Unverified", cls: "badge", said: "Not listed. Check the deployer before you buy." }],
      [{ ZED: { deployId: ZED_DEPLOY } }, false, { badge: null, cls: null, said: null }]] as const) {
      TRUST_LIST.verified = list as any; S.trust = trust;
      const v = await open("/explorer#/token/ZED", 1280, () => /metadata/.test(document.body.innerText));
      try {
        assert.deepEqual(await look(v), want, JSON.stringify([list, trust]));
        assert.deepEqual(v.errors, []);
        assert.deepEqual(await offPalette(v.page), []);
      } finally { await v.close(); }
    }
  } finally { TRUST_LIST.verified = {}; S.trust = true; }
});

// A sibling read that failed is not kept for the session: the next view asks again. Here the resolver is down while the
// home opens (no decimals, no address names) and answers by the time a name is opened.
test("a failed resolver read is asked again by the next view: a token price in its decimals and an address under its name", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "503" });
  PRIMARIES[MINER] = "solo";
  try {
    const v = await open("/explorer", 1280, () => !!document.querySelector("#pu-hr") && !!document.querySelector(".row a.addrl[data-named]"));
    try {
      assert.equal(await v.page.evaluate(() => document.querySelector(".row a.addrl").textContent), `${MINER.slice(0, 8)}…${MINER.slice(-6)}`, "hex while the resolver is down");
      S.cx = "up";
      await v.page.evaluate(() => { location.hash = "#/name/twin"; });
      await until(v.page, () => /for sale/i.test(document.body.innerText) && /history \(/i.test(document.body.innerText));
      assert.equal(await v.page.textContent(".panel:has(h2:text-is('For sale')) .action"), "Market Listed for 123.45 QTOK · open offer", "the decimals read again");
      await v.page.evaluate(() => { location.hash = "#/token/ZED"; });
      await until(v.page, () => /metadata/.test(document.body.innerText) && !!document.querySelector(".kv a.addrl[data-named]"));
      assert.equal(await v.page.evaluate(() => document.querySelector(".kv a.addrl").textContent), "solo.csd", "the name read again");
      assert.deepEqual(v.errors, []);
    } finally { await v.close(); }
  } finally { S.cx = "up"; delete PRIMARIES[MINER]; }
});

// An address's CairnX holdings in the token's decimals; with the decimals unread, labelled base units, never base units
// shown as whole tokens.
test("address page: CairnX holdings in the token's decimals; with the decimals unread, labelled base units", { skip: why || false }, async () => {
  Object.assign(S, { market: "off", series: true, shell: true, cx: "up", cxFail: "" });
  const held = (v: View) => v.page.evaluate(() => [...document.querySelectorAll("#cxpanel > div")].map((d: any) => d.textContent));
  try {
    for (const [fail, tokens] of [["", "123.45 QTOK (+1 locked in offers)"], ["/tokens", "12,345 base units QTOK (+100 base units locked in offers)"]] as const) {
      S.cxFail = fail;
      const v = await open(`/explorer#/address/${WALLET}`, 1280, () => !!document.querySelector("#cxpanel:not([hidden])"));
      try {
        assert.deepEqual(await held(v), ["tokens", tokens, "names", "twin.csd"], fail || "decimals read");
        assert.deepEqual(v.errors, []);
      } finally { await v.close(); }
    }
  } finally { S.cxFail = ""; }
});
