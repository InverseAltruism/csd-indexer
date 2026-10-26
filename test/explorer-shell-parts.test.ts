// Through the front door the explorer is one of the site's pages, so it takes the site's shell parts by name, never a
// copy: the tab icons (the Cairn mark, cairn's /favicon*.png|svg) and the one column (cairn's components.css
// --page-max wide with --page-pad inside it). Before Plan 89 wave R11 it drew its own green icon and a 1200 px column
// while the site moved to 1280, so its edges sat 40 px inside the header's. On a direct indexer hit the names fall back
// to 1280 px and 24 px. Run: npx tsx --test test/explorer-shell-parts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML = readFileSync(fileURLToPath(new URL("../public/explorer.html", import.meta.url)), "utf8");

test("the explorer links the site's three tab icons and draws none of its own", () => {
  const icons = HTML.match(/<link rel="(icon|shortcut icon|apple-touch-icon|mask-icon)"[^>]*>/g) || [];
  assert.deepEqual(icons, [
    '<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  ]);
});

test("the content sits in the site's column: --page-max wide, every edge padded by --page-pad", () => {
  const wrap = /\.ex-wrap \{([^}]*)\}/.exec(HTML)?.[1] ?? "";
  assert.match(wrap, /max-width: var\(--page-max, 1280px\)/);
  assert.match(wrap, /--ex-pad: var\(--page-pad, var\(--ui-space-5\)\)/);
  // the rules that draw the column's left edge (the search row, the panels, the figure strip, the columns' heads and
  // notes, the table cells, the skeleton, the trust line) pad it with --ex-pad, never a fixed step
  for (const sel of [".ex-top", ".panel", ".pu", ".ex-col > h2", ".ex-col > #actnote > .ex-unread", ":where(.ex-wrap) th", ":where(.ex-wrap) td", ".sk-rows", ".ex-trust"]) {
    const body = new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(HTML)?.[1] ?? "";
    const pad = /padding: ([^;]+);/.exec(body)?.[1] ?? "";
    const parts = pad.trim().split(/\s+(?![^(]*\))/);
    assert.ok(parts.length >= 2 && parts[1] === "var(--ex-pad)", `${sel}: padding ${pad || "(none)"}`);
  }
});
