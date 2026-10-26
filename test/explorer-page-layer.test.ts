// The explorer's own stylesheet sits in the `page` cascade layer, which outranks cairn's `components` layer whatever the
// specificity (an unlayered rule outranks every layer). Through the front door the page also carries cairn's shell (the
// header, the footer, the Terms dialog, toasts), drawn from components.css outside the explorer's content, so an element,
// attribute or pseudo-class rule there restyles the shell: on 2026-10-26 `button { color: inherit }` drew the Terms
// dialog's "Agree and continue" in ink on its ink button, `h2 {...}` shrank its title to 15 px and `:focus-visible`
// squared its corners. Every selector outside the tokens layer therefore starts from the explorer's content,
// `:where(.ex-wrap)` (no specificity change), or from one of its own classes or ids, except the document-wide defaults
// below. Rules stay flat (no nesting) so this reading is complete. Run: npx tsx --test test/explorer-page-layer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML = readFileSync(fileURLToPath(new URL("../public/explorer.html", import.meta.url)), "utf8");
// Document-wide defaults the explorer may set for the whole page: the box model, the root and body, hidden.
const GLOBAL = new Set(["[hidden]", "*", "*::before", "*::after", "html", "body"]);

type Rule = { layer: string; selector: string; nested: boolean };

/** Splits a selector list on its top-level commas (a comma inside :is(), :where() or :not() stays). */
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every style rule's selectors in every <style> block, with the layer it sits in ("" when unlayered). */
function styleRules(html: string): Rule[] {
  const out: Rule[] = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = (m[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    const stack: { kind: "layer" | "at" | "keyframes" | "step" | "rule"; name?: string }[] = [];
    let buf = "";
    for (const ch of css) {
      if (ch === "{") {
        const prelude = buf.trim();
        buf = "";
        if (prelude.startsWith("@layer")) stack.push({ kind: "layer", name: prelude.slice("@layer".length).trim() });
        else if (prelude.startsWith("@keyframes")) stack.push({ kind: "keyframes" });
        else if (prelude.startsWith("@")) stack.push({ kind: "at" });
        else if (stack.some((s) => s.kind === "keyframes")) stack.push({ kind: "step" });
        else {
          const nested = stack.some((s) => s.kind === "rule");
          const layer = [...stack].reverse().find((s) => s.kind === "layer")?.name ?? "";
          for (const selector of splitTop(prelude)) out.push({ layer, selector, nested });
          stack.push({ kind: "rule" });
        }
      } else if (ch === "}") { stack.pop(); buf = ""; }
      else if (ch === ";") buf = "";
      else buf += ch;
    }
  }
  return out;
}

const scoped = (s: string) => GLOBAL.has(s) || s.startsWith(":where(.ex-wrap)") || /^[.#]/.test(s) || s.startsWith(":root.ex-");

test("outside the tokens layer every rule starts from the explorer's content or its own names (the shell keeps its look)", () => {
  const rules = styleRules(HTML).filter((r) => r.layer !== "tokens");
  assert.ok(rules.length > 200, `read only ${rules.length} selectors: the reading stopped early`);
  assert.deepEqual(rules.filter((r) => r.nested).map((r) => r.selector), [], "nested rules");
  const leaks = rules.filter((r) => !scoped(r.selector)).map((r) => `${r.layer || "unlayered"}: ${r.selector}`);
  assert.deepEqual(leaks, [], `selectors that reach cairn's shell: ${leaks.join(" | ")}`);
});

test("the reading catches each shape that reaches the shell, and passes the scoped forms", () => {
  const page = (css: string) => `<style>@layer page { ${css} }</style>`;
  const leaks = (html: string) => styleRules(html).filter((r) => r.layer !== "tokens" && (r.nested || !scoped(r.selector))).length;
  for (const bad of ["button { color: inherit; }", "@media (max-width: 1px) { p { margin: 0; } }", ":is(h2, h3) { margin: 0; }",
    ":where(button) { color: red; }", "[role=dialog] button { color: red; }", ":focus-visible { outline: 0; }", ".x, h3 { margin: 0; }",
    ".ex-top { & button { color: red; } }"]) assert.equal(leaks(page(bad)) > 0, true, bad);
  assert.equal(leaks(`${page(".ex-a { margin: 0; }")}<style>@layer page { h2 { font-size: 15px; } }</style>`), 1, "a second page block is read");
  assert.equal(leaks("<style>h2 { font-size: 15px; }</style>"), 1, "an unlayered rule is read");
  assert.equal(leaks(page(":where(.ex-wrap) :is(td, .kv .v) .badge { margin: 0; } .ex-brand:hover { margin: 0; } @keyframes k { from { opacity: 0; } to { opacity: 1; } }")), 0);
  assert.equal(leaks("<style>@layer tokens { :root { --ui-ink: #000; } }</style>"), 0, "the fallback tokens");
});

test("honest path: the explorer's own element rules are present, scoped to .ex-wrap, and the brand keeps its link rules", () => {
  const all = styleRules(HTML).map((r) => r.selector);
  for (const s of [":where(.ex-wrap) a", ":where(.ex-wrap) button", ":where(.ex-wrap) h2", ":where(.ex-wrap) td", ":where(.ex-wrap) :focus-visible"]) {
    assert.ok(all.includes(s), `missing ${s}`);
  }
  // the standalone brand (a direct indexer hit, outside .ex-wrap) keeps the link, hover and focus rules
  for (const s of [".ex-brand", ".ex-brand:hover", ".ex-brand:focus-visible"]) assert.ok(all.includes(s), `missing ${s}`);
  // the content root wraps the search, the view, the figures and the trust line
  const wrap = HTML.slice(HTML.indexOf('<div class="ex-wrap">'), HTML.indexOf('<footer id="site-footer">'));
  for (const id of ['id="search-form"', 'id="view"', 'id="trust-note"', 'id="stats"']) assert.ok(wrap.includes(id), `${id} sits inside .ex-wrap`);
});
