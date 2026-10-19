// The explorer reaches cairn's market routes and chart module only through the front door (Plan 88 P5b, D-88-9):
// the page's own SIB builder, run against a stub location, yields them under /explorer and nothing standalone, and
// no other line of the page names either path. The page's own SVG charts are gone (D88-5). The browser behaviour
// is test/explorer-browser.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../public/explorer.html", import.meta.url)), "utf8");
const SIB_SRC = /const SIB = \(\(\) => \{[\s\S]*?\n\}\)\(\);/.exec(html)?.[0] ?? "";

type Sib = { node: string | null; cairnx: string | null; market: string | null; charts: string | null; content: string | null };
const sibAt = (origin: string, pathname: string): Sib =>
  new Function("location", `${SIB_SRC}\nreturn SIB;`)({ origin, pathname }) as Sib;

test("through the front door the page builds the node, cairnx, market, chart-module and content bases under its prefix", () => {
  assert.ok(SIB_SRC, "the SIB builder is in the page");
  assert.deepEqual(sibAt("https://cairn-substrate.com", "/explorer"), {
    node: "https://cairn-substrate.com/api/rpc", cairnx: "https://cairn-substrate.com/trade/api/cairnx",
    market: "https://cairn-substrate.com/api/market", charts: "https://cairn-substrate.com/charts/chart.js",
    content: "https://cairn-substrate.com/content/",
  });
  assert.equal(sibAt("https://h.example", "/mirror/explorer/").market, "https://h.example/mirror/api/market");
});

test("standalone (the indexer serving the page at /) there is no market base, no chart module and no content base", () => {
  assert.deepEqual(sibAt("http://127.0.0.1:8793", "/"), { node: null, cairnx: null, market: null, charts: null, content: null });
});

test("no code outside the SIB builder names /api/market or /charts/", () => {
  const code = html.replace(SIB_SRC, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\/api\/market/);
  assert.doesNotMatch(code, /\/charts\//);
  assert.match(html, /jx\(SIB\.market,'\/csd'\)/, "the price is read through SIB.market");
});

test("the page's own SVG chart and sparkline are gone (D88-5)", () => {
  assert.equal((html.match(/function (chart|sparkline)\(/g) ?? []).length, 0);
});
