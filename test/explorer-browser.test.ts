// The explorer in a real browser, served the way cairn's front door serves it (at /explorer, a nonce on its inline
// script, the explorer CSP of cairn src/server.ts), every read stubbed: the indexer's reads, the resolver's lists and
// verdicts, cairn's /content, and /api/market/* fresh, stale and off as 503. At 390 and 1280 px: no page error, the
// failed requests named, no horizontal overflow, a canvas in every chart, a source line beside every USD figure,
// "stale" in the stale state, no USD text with the market off, never NaN or a 0 USD; the hashrate window named from
// the series; the request cadence; no chart of a replaced view left alive; the verdict reads and their fallback; the
// proposal page's content check.
// Needs playwright-core (PLAYWRIGHT_CORE or the devDependency) and a Chromium (PLAYWRIGHT_CHROMIUM or the build that
// playwright-core installs); without either the file skips by name, and with EXPLORER_BROWSER_REQUIRED=1 (CI) it
// fails instead. The chart tests also need cairn's chart module, read from CAIRN_PUBLIC_DIR (charts/, vendor/,
// trade/spark.js, header.js, footer.js); without it they skip by name and the rest run, since no test reads across
// the repos unless asked to.
// Run with the charts (the devDependency's Chromium is chromium_headless_shell-1243):
//   CAIRN_PUBLIC_DIR=<cairn>/public npx tsx --test test/explorer-browser.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const EXPLORER = fileURLToPath(new URL("../public/explorer.html", import.meta.url));
const CAIRN = process.env.CAIRN_PUBLIC_DIR ?? "";
const MIME: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

// playwright-core is loaded untyped, and the page callbacks below run in the browser (this file has no DOM lib):
// `any` at those two boundaries only.
declare const document: any, location: any;
let chromium: any = null, why = "";
try { chromium = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core").chromium; }
catch { why = "playwright-core not found (set PLAYWRIGHT_CORE to its path)"; }
let browser: any = null;
if (!why) {
  try { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined, args: ["--no-sandbox"] }); }
  catch (e) { why = `no Chromium for playwright-core (set PLAYWRIGHT_CHROMIUM): ${String((e as Error).message).split("\n")[0]}`; }
}
const noCharts = why || (CAIRN && existsSync(join(CAIRN, "charts/chart.js")) ? "" : "CAIRN_PUBLIC_DIR unset or without charts/chart.js (the chart module lives in cairn)");

test("a browser is present when EXPLORER_BROWSER_REQUIRED=1", { skip: process.env.EXPLORER_BROWSER_REQUIRED !== "1" }, () => {
  assert.equal(why, "", "the browser tests would skip");
});

// ── fixtures: a 121 s chain with a little jitter, the shapes of the live reads ──
const NOW = Math.floor(Date.now() / 1000), TIP = 121_800, MINER = "0x40379fb123bec901080bb94deeda2f457062b7bd";
const bt = (h: number) => NOW - (TIP - h) * 121 + ((h % 7) - 3) * 10;
const iso = (s: number) => new Date(s * 1000).toISOString();
const block = (h: number) => ({ height: h, hash: "0x" + h.toString(16).padStart(64, "0"), prev: "0x" + (h - 1).toString(16).padStart(64, "0"),
  merkle: "0x" + "ab".repeat(32), time: bt(h), bits: 453035574, nonce: 1, version: 1, tx_count: 1, chainwork: String(BigInt(h) * 10n ** 15n), orphaned: 0 });
const recent = (n: number) => Array.from({ length: n }, (_, i) => block(TIP - i));
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
  "/domains": [{ domain: "cairnx:v1", proposals: 3 }],
  "/analytics/supply": { ok: true, height: TIP, emitted_supply: "609005000000000", max_supply: "10511999988436800", pct_emitted: 5.79, block_reward: "5000000000",
    halving: { era: 0, interval: 1051200, next_height: 1051200, blocks_remaining: 929400, est_seconds_remaining: 111528000, next_reward: "2500000000" } },
  "/analytics/miners": MINERS,
  "/analytics/richlist": { ok: true, height: TIP, holders: [{ rank: 1, addr: MINER, balance: "375062706850941", utxos: 9, pct_of_emitted: 61.5 }] },
  "/analytics/series": SERIES,
  "/domain/cairnx:v1/proposals": [],
};
const VWAP = 0.0594, EMITTED = 6_090_050, MAX = 105_119_999.884368;
function csdBody(): unknown {
  const age = S.market === "stale" ? 40 * 60 : 60;
  const base = { ok: true, pair: "CSD/USD", quote: "USDT", price: { last: 0.0455, at: iso(NOW - age), source: "safetrade" }, range24h: { low: 0.023, high: 0.0899 },
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

const S = { market: "fresh" as "fresh" | "stale" | "off", thin: false, partial: false, series: true, records: "on" as "on" | "404" };
// CairnX proposals in the shapes of /domain/:d/proposals, and the resolver's verdicts for them: one refused mint
const cxProp = (n: number, uri: object) => ({ txid: "0x" + n.toString(16).padStart(64, "0"), height: TIP - n, proposer: MINER, fee: 25000000, domain: "cairnx:v1", uri: JSON.stringify(uri) });
const PROPS = Array.from({ length: 130 }, (_, i) => cxProp(i + 1, { v: 1, t: "mint", ticker: "CAIRN", amount: "100" }));
const REFUSED = PROPS[0]!.txid;
const VERDICTS: Record<string, { kind: string; applied: boolean; note: string; height: number }> = Object.fromEntries(PROPS.map((p, i) =>
  [p.txid, { kind: "mint", applied: i !== 0, note: i === 0 ? "mint past supply" : "", height: p.height }]));
const RECORD_READS: number[] = [];
// An address whose Propose txs are cairnx records: 25 on the first page, 25 more behind "load more", the refused
// mint on the second page.
const WALLET = "0x" + "77".repeat(20);
const txRow = (p: { txid: string; height: number }) => ({ txid: p.txid, height: p.height, pos: 1, app_type: "Propose", signer: WALLET, fee: 25000000,
  time: bt(p.height), n_in: 1, n_out: 1, coinbase: false, outputs: [] });
const PAGE1 = PROPS.slice(1, 26), PAGE2 = [PROPS[0]!, ...PROPS.slice(26, 50)];
function ADDRESS(k: string, _q: URLSearchParams): unknown {
  if (k === `/address/${WALLET}`) return { address: WALLET, chain_stats: { balance: 0, funded: 0, spent: 0, tx_count: 50 } };
  if (k === `/address/${WALLET}/utxo`) return [];
  if (k === `/address/${WALLET}/txs`) return PAGE1.map(txRow);
  if (k === `/address/${WALLET}/txs/chain/${PAGE1[PAGE1.length - 1]!.txid}`) return PAGE2.map(txRow);
  const prop = k.startsWith("/proposal/") ? PROPS.find((p) => p.txid === k.slice(10)) : undefined;
  return prop ?? undefined;
}
const REQS: string[] = [];
const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(body));
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x"), p = decodeURIComponent(url.pathname);
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
  if (api !== null || ["/health", "/domains", "/blocks/recent"].includes(p) || p.startsWith("/analytics/") || p.startsWith("/domain/")) {
    const k = api ?? p;
    if (k === "/blocks/recent") return json(res, 200, recent(Number(url.searchParams.get("limit") || 12)));
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
  if (p.startsWith("/trade/api/cairnx/")) {
    const k = p.slice(17);
    if (k === "/records") {
      if (S.records === "404") return json(res, 404, { ok: false, error: "not a cairnx read endpoint" });
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      RECORD_READS.push(ids.length);
      return json(res, 200, { ok: true, tipHeight: TIP, records: Object.fromEntries(ids.filter((id) => id in VERDICTS).map((id) => [id, VERDICTS[id]])) });
    }
    if (k === "/log") return json(res, 200, Object.entries(VERDICTS).map(([id, v]) => ({ id, ok: v.applied, note: v.note, height: v.height })));
    return json(res, 200, k === "/primaries" ? { ok: true, primaries: {} } : []);
  }
  if (p === "/api/health") return json(res, 200, { ok: true, tipHeight: TIP });
  try {
    if (!CAIRN) throw new Error("no cairn public dir");
    const file = join(CAIRN, normalize(p).replace(/^(\.\.[/\\])+/, ""));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
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
async function open(path: string, width: number, ready: () => boolean, { clock = false, response = "" } = {}): Promise<View> {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, isMobile: width < 500, hasTouch: width < 500, colorScheme: "dark", serviceWorkers: "block" });
  await ctx.addInitScript(() => { try { localStorage.setItem("cairn:terms:v4", "2026-10-12T00:00:00.000Z"); } catch { /* no storage */ } });
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
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
  test(`${market}, ${width} px: no error, no overflow, every chart drawn, the hashrate window named, the CSD/USD figures sourced or hidden`, { skip: noCharts || false }, async () => {
    Object.assign(S, { market, thin: false, series: true });
    const v = await open("/explorer", width, market === "off" ? charted : withMarket, { response: market === "off" ? OFF : "" });
    try {
      assert.deepEqual(v.errors, []);
      assert.deepEqual(v.failed, market === "off" ? ["503 /api/market/csd"] : []);
      assert.equal(v.overflow, 0, "horizontal overflow");
      assert.equal(await v.page.textContent("#pu-hr .n"), "3.15 TH/s", "the indexer's figure over the window");
      assert.equal(await v.page.textContent("#pu-hr .l"), "hashrate · last 24.2\u00a0h", "the window's real span, from the series");
      assert.equal(await v.page.textContent(".panel:has(#hrchart) .pill"), "last 24.2\u00a0h", "the same window on the chart");
      for (const id of ["#emchart", "#hrchart", "#btchart"]) assert.equal(await v.page.locator(`${id} .cc-attr`).count(), 1, `the attribution under ${id}`);
      // the library lays its pane out in the first row of a table, whose cells this page's own td rules once capped
      const narrow = await v.page.evaluate(() => ["#emchart", "#hrchart", "#btchart", "#csdusd-chart"].filter((s) => document.querySelector(`${s} canvas`)).map((s) => ({
        s, plot: Math.round(document.querySelector(`${s} .cc-plot`).getBoundingClientRect().width),
        pane: Math.round(Math.max(...[...document.querySelectorAll(`${s} .cc-plot tr:first-child > td`)].map((c: any) => c.getBoundingClientRect().width))) })).filter((x) => x.pane < 0.65 * x.plot));
      assert.deepEqual(narrow, [], "each chart's pane fills its plot");
      const text: string = await v.page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(text, bad);
      if (market === "off") {
        assert.equal(await v.page.isVisible("#csd-mkt"), false, "the CSD/USD block hidden");
        assert.doesNotMatch(text, /USD/, "no USD text with the market off");
      } else {
        const figs = await figures(v.page);
        assert.deepEqual(figs.map((f: { label: string }) => f.label), ["price", "24h VWAP", "market cap", "fully diluted", "24h volume"]);
        for (const f of figs) {
          assert.match(f.value, / USD$/, `${f.label} in USD`);
          assert.match(f.source, /SafeTrade · \d\d:\d\d UTC/, `the venue and time beside ${f.label}: ${f.source}`);
          if (market === "stale") assert.match(f.source, /stale, 40 min ago$/, `stale beside ${f.label}`);
        }
        assert.equal(figs[0].value, "0.0455 USD");
        assert.match(await v.page.textContent("#csd-mkt .mkt-sub"), /CSD prices from SafeTrade, an exchange we do not operate/);
        assert.equal(await v.page.getAttribute("#csd-mkt .mkt-sub a", "href"), "https://safetrade.com/exchange/CSD-USDT");
        assert.equal(await v.page.textContent("#csd-mkt > .muted"), "CSD/USD · last 30 days · daily closes · CoinPaprika");
        const note: string = await v.page.textContent("#csdusd-chart .cc-note");
        if (market === "stale") assert.equal(note, "stale, 40 min ago");
        else assert.doesNotMatch(await v.page.textContent("#csd-mkt"), /stale/);
      }
      console.log(`      ${market} ${width}: ${v.reqs} requests, ${Math.round(v.bytes() / 1024)} KB`);
    } finally { await v.close(); }
  });
}

test("a body without a VWAP, supply or volume: dashes for those figures, never a 0 USD", { skip: noCharts || false }, async () => {
  Object.assign(S, { market: "fresh", thin: true, series: true });
  const v = await open("/explorer", 1280, withMarket);
  try {
    const figs = await figures(v.page);
    assert.deepEqual(figs.map((f: { value: string }) => f.value), ["0.0455 USD", "-", "-", "-", "-"]);
    assert.doesNotMatch(await v.page.textContent("#csd-mkt"), bad);
  } finally { await v.close(); S.thin = false; }
});

test("a range without its low and a supply without its emitted figure: no range line, a dash, never a 0", { skip: noCharts || false }, async () => {
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

test("the indexer without /analytics/series (404): the tile names the blocks, the hashrate chart says it has no series", { skip: noCharts || false }, async () => {
  Object.assign(S, { market: "off", series: false });
  const v = await open("/explorer", 1280, () => !!document.querySelector("#emchart canvas") && !!document.querySelector("#hrchart .cc-empty"));
  try {
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.failed.sort(), ["404 /explorer/api/analytics/series", "503 /api/market/csd"]);
    assert.equal(await v.page.textContent("#pu-hr .l"), "hashrate · last 720 blocks");
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
    assert.equal(await v.page.textContent("#pu-hr .l"), "hashrate");
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

test("market on: the price every 2 min and the daily series every 10 min while the page is open", { skip: noCharts || false }, async () => {
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

test("leaving and re-opening the home view destroys the charts it replaces: live canvases do not grow", { skip: noCharts || false }, async () => {
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

test("the market going from fresh to 503 while the page is open hides the CSD/USD block and destroys its chart", { skip: noCharts || false }, async () => {
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
// resolver without that route (404) falls back to the applied-event log. The log is not read when the route answers.
for (const records of ["on", "404"] as const) {
  test(`domain page, /cairnx/records ${records === "on" ? "answering: two reads for 130 records, no log read" : "404: one log read"}; the refused mint shows no effect`, { skip: why || false }, async () => {
    Object.assign(S, { market: "off", series: true, records });
    INDEXER["/domain/cairnx:v1/proposals"] = PROPS;
    RECORD_READS.length = 0;
    try {
      const v = await open("/explorer#/domain/cairnx%3Av1", 1280, () => !!document.querySelector(".cx-noeffect") || /proposal\(s\)/.test(document.body.innerText));
      try {
        assert.deepEqual(v.errors, []);
        const row: string = await v.page.evaluate((id: string) => [...document.querySelectorAll("tr")].find((r: any) => r.innerHTML.includes(id))?.textContent ?? "", REFUSED);
        assert.match(row, /no effect/);
        assert.match(row, /mint past supply/);
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
    assert.match(await v.page.textContent("#act-25"), /no effect.*mint past supply/s);
    assert.equal(await v.page.locator(".cx-noeffect").count(), 1);
    assert.deepEqual(v.errors, []);
  } finally { await v.close(); }
});
