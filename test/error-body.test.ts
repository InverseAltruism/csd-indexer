// A request Express refuses before any route handler runs (a path parameter that does not percent-decode) is answered
// by the app's final error handler in the routes' error shape. Express's default handler answers it with an HTML page
// carrying the stack, which names the absolute install path, when NODE_ENV is not "production" (the Dockerfile and
// the README set none). The routes' own error bodies are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("error-body");
process.env.CSD_INDEX_PG_SCHEMA = "t_error_body";

const { buildApp } = await import("../src/server.js");
const { closeDb } = await import("../src/db.js");
const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
test.after(async () => { srv.close(); await closeDb(); });

const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, type: r.headers.get("content-type") ?? "", body: await r.text() };
};

test("a path parameter that does not percent-decode answers 400 JSON without a stack or a path", async () => {
  for (const path of ["/block/%E0%A4%A", "/tx/%zz/status", "/domain/%/proposals", "/address/%zz", "/proposal/%E0%A4%A/attestations"]) {
    const r = await get(path);
    assert.equal(r.status, 400, path);
    assert.match(r.type, /^application\/json/, path);
    assert.equal(r.body, '{"error":"bad request"}', path);
    assert.ok(!r.body.includes(process.cwd()) && !/node_modules|URIError|at /.test(r.body), path);
  }
});

test("HAPPY PATH: the routes' own error bodies and statuses are unchanged", async () => {
  const cases: [string, number, string][] = [
    ["/tx/0xzz", 400, '{"error":"want /tx/0x<64-hex>"}'],
    ["/tx/0xzz/merkle-proof", 400, '{"error":"want /tx/0x<64-hex>/merkle-proof"}'],
    ["/address/nope", 400, '{"error":"want /address/0x<40-hex>"}'],
    ["/blocks/at-or-after/x", 400, '{"error":"want /blocks/at-or-after/<unix seconds>"}'],
    [`/tx/0x${"ab".repeat(32)}`, 404, '{"error":"unknown tx"}'],
    [`/proposal/0x${"ab".repeat(32)}`, 404, '{"error":"unknown proposal"}'],
  ];
  for (const [path, status, body] of cases) {
    const r = await get(path);
    assert.deepEqual([r.status, r.body], [status, body], path);
  }
  // a well-formed percent-encoding still reaches its route
  assert.equal((await get("/domain/cairn%3Awall/proposals")).status, 200);
  // a path no route serves keeps Express's 404
  assert.equal((await get("/no/such/route")).status, 404);
});
