// The explorer must not call the front door's removed /api/market route: each visit logged a 404
// and a console error. Pins the removal, and that the sibling proxies (node, cairnx) are still wired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../public/explorer.html", import.meta.url)), "utf8");

test("explorer.html carries no market row, market fetch or /api/market URL", () => {
  assert.doesNotMatch(html, /mktrow/);
  assert.doesNotMatch(html, /\/api\/market/);
  assert.doesNotMatch(html, /SIB\.market/);
});

test("explorer.html still builds the node and cairnx sibling proxies", () => {
  assert.match(html, /node: location\.origin \+ m\[1\] \+ "\/api\/rpc"/);
  assert.match(html, /cairnx: location\.origin \+ m\[1\] \+ "\/trade\/api\/cairnx"/);
});
