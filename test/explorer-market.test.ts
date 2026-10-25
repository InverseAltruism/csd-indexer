// The explorer reaches cairn's market routes, chart module, avatar module and token list only through the front door
// (Plan 88 P5b, D-88-9):
// the page's own SIB builder, run against a stub location, yields them under /explorer and nothing standalone, and
// no other line of the page names either path. The browser behaviour is test/explorer-browser.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../public/explorer.html", import.meta.url)), "utf8");
const SIB_SRC = /const SIB = \(\(\) => \{[\s\S]*?\n\}\)\(\);/.exec(html)?.[0] ?? "";

type Sib = { node: string | null; cairnx: string | null; market: string | null; charts: string | null; content: string | null;
  avatar: string | null; trust: { list: string; level: string } | null };
const sibAt = (origin: string, pathname: string): Sib =>
  new Function("location", `${SIB_SRC}\nreturn SIB;`)({ origin, pathname }) as Sib;

test("through the front door the page builds the node, cairnx, market, chart-module and content bases under its prefix", () => {
  assert.ok(SIB_SRC, "the SIB builder is in the page");
  assert.deepEqual(sibAt("https://cairn-substrate.com", "/explorer"), {
    node: "https://cairn-substrate.com/api/rpc", cairnx: "https://cairn-substrate.com/trade/api/cairnx",
    market: "https://cairn-substrate.com/api/market", charts: "https://cairn-substrate.com/charts/chart.js",
    content: "https://cairn-substrate.com/content/", avatar: "https://cairn-substrate.com/ui/avatar.js",
    trust: { list: "https://cairn-substrate.com/trade/verified-tokens.json", level: "https://cairn-substrate.com/trade/discover.js" },
  });
  assert.equal(sibAt("https://h.example", "/mirror/explorer/").market, "https://h.example/mirror/api/market");
});

test("standalone (the indexer serving the page at /) there is no market base, no chart module, no content base, no avatar module and no token list", () => {
  assert.deepEqual(sibAt("http://127.0.0.1:8793", "/"), { node: null, cairnx: null, market: null, charts: null, content: null, avatar: null, trust: null });
});

test("no code outside the SIB builder names /api/market, /charts/, cairn's avatar module or its token list", () => {
  const code = html.replace(SIB_SRC, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\/api\/market/);
  assert.doesNotMatch(code, /\/charts\//);
  assert.doesNotMatch(code, /\/ui\/avatar\.js|\/trade\/(verified-tokens|discover)/);
  assert.match(html, /sib\(SIB\.market,'\/csd'\)/, "the price is read through SIB.market");
});
