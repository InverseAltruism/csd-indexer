// The explorer's own stylesheet sits in the `page` cascade layer, which outranks cairn's `components` layer whatever the
// specificity. Through the front door the page also carries cairn's shell (the header, the footer, the Terms dialog,
// toasts), drawn from components.css outside the explorer's content. So a bare element rule in the page layer (a, b,
// button, h2, table cells) restyles the shell: on 2026-10-26 `button { color: inherit }` drew the Terms dialog's
// "Agree and continue" in ink on its ink button, and `h2 {...}` shrank its title to 15 px. Every element selector in
// the page layer is therefore scoped to the explorer's content, `:where(.ex-wrap)` (no specificity change), except the
// document-wide defaults listed below. Run: npx tsx --test test/explorer-page-layer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML = readFileSync(fileURLToPath(new URL("../public/explorer.html", import.meta.url)), "utf8");
// Document-wide defaults the explorer may set for the whole page: the box model, the root and body, hidden, the focus ring.
const GLOBAL = new Set(["[hidden]", "*", "*::before", "*::after", "html", "body", ":focus-visible"]);
const ELEMENT = /^[a-z][a-z0-9]*(?=$|[\s.:#[>+~])/;

function pageLayer(html: string): string {
  const start = html.indexOf("@layer page {");
  assert.ok(start >= 0, "the explorer's stylesheet has a page layer");
  const end = html.indexOf("</style>", start);
  return html.slice(start + "@layer page {".length, end);
}

// Every selector of every style rule (comments, at-rule preludes and keyframe steps left out).
function selectors(css: string): string[] {
  const out: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{};]+)\{/g)) {
    const prelude = (m[1] ?? "").trim();
    if (!prelude || prelude.startsWith("@") || /^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(prelude)) continue;
    for (const s of prelude.split(",")) out.push(s.trim());
  }
  return out;
}

test("the page layer styles no bare element outside the explorer's content (the shell's dialogs keep their look)", () => {
  const leaks = selectors(pageLayer(HTML)).filter((s) => !GLOBAL.has(s) && ELEMENT.test(s));
  assert.deepEqual(leaks, [], `unscoped element selectors in the page layer: ${leaks.join(" | ")}`);
});

test("honest path: the explorer's own element rules are present, scoped to .ex-wrap", () => {
  const all = selectors(pageLayer(HTML));
  for (const s of [":where(.ex-wrap) a", ":where(.ex-wrap) button", ":where(.ex-wrap) h2", ":where(.ex-wrap) td"]) {
    assert.ok(all.includes(s), `missing ${s}`);
  }
  // the standalone brand (a direct indexer hit, outside .ex-wrap) keeps the link rule
  assert.ok(all.includes(".ex-brand"), "the standalone brand keeps the link rule");
  // and every element the scope names is the explorer's: the content root wraps the search, the view and the trust line
  const wrap = HTML.slice(HTML.indexOf('<div class="ex-wrap">'), HTML.indexOf('<footer id="site-footer">'));
  for (const id of ['id="search-form"', 'id="view"', 'id="trust-note"', 'id="stats"']) assert.ok(wrap.includes(id), `${id} sits inside .ex-wrap`);
});
