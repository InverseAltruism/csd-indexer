// A request Express refuses before any route handler runs (a path parameter that does not percent-decode) is answered
// by the app's final error handler in the routes' error shape. Express's default handler answers it with an HTML page
// carrying the stack, which names the absolute install path, when NODE_ENV is not "production" (the Dockerfile and
// the README set none). The routes' own error bodies are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("error-body");
process.env.CSD_INDEX_PG_SCHEMA = "t_error_body";

const { buildApp, finalErrorHandler } = await import("../src/server.js");
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

// send sets Content-Type for the file before it refuses a range or a precondition; the refusal still answers JSON.
test("GET / with an unsatisfiable Range (416) or a failing If-Match (412) answers JSON as JSON", async () => {
  for (const [headers, status, body] of [
    [{ range: "bytes=999999999-" }, 416, '{"error":"range not satisfiable"}'],
    [{ "if-match": '"no-such-etag"' }, 412, '{"error":"precondition failed"}'],
  ] as const) {
    const r = await fetch(base + "/", { headers });
    const text = await r.text();
    assert.deepEqual([r.status, text], [status, body], JSON.stringify(headers));
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/, JSON.stringify(headers));
  }
  // HAPPY PATH: the page itself and a satisfiable range
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal((await fetch(base + "/", { headers: { range: "bytes=0-9" } })).status, 206);
});

// The handler's other branches, mounted after routes that fail as no route of the app does today.
test("the final handler answers a 5xx status as fail() does and logs it, a 4xx without a log, and JSON over a type already set", async () => {
  const app = express();
  app.get("/unavailable", (_q: Request, _r: Response, next: NextFunction) => next(Object.assign(new Error("db down"), { status: 503 })));
  app.get("/refused", (_q: Request, _r: Response, next: NextFunction) => next(Object.assign(new Error("no"), { status: 403 })));
  // as the supply routes do: a type is set, then the handler fails
  app.get("/typed", (_q: Request, r: Response, next: NextFunction) => { r.type("text/plain"); next(new Error("after the type")); });
  app.use(finalErrorHandler);
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const r = await fetch(at + "/unavailable");
    assert.deepEqual([r.status, await r.text()], [500, '{"error":"internal error"}']);
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(logged.length, 1, "a 5xx is logged once");
    assert.equal((logged[0]![1] as Error).message, "db down");
    const f = await fetch(at + "/refused");
    assert.deepEqual([f.status, await f.text()], [403, '{"error":"forbidden"}']);
    assert.equal(logged.length, 1, "a 4xx is not logged");
    const t = await fetch(at + "/typed");
    assert.deepEqual([t.status, await t.text()], [500, '{"error":"internal error"}']);
    assert.match(t.headers.get("content-type") ?? "", /^application\/json/, "fail() answers JSON as JSON over a type already set");
    assert.equal(logged.length, 2);
  } finally {
    console.error = realError;
    s.close();
  }
});

test("an error after the head was sent ends that response; no second head is written", async () => {
  const app = express();
  app.get("/late", (_q: Request, r: Response, next: NextFunction) => { r.status(200).write("partial"); next(new Error("after the head")); });
  app.use(finalErrorHandler);
  const s = app.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const r = await fetch(at + "/late");
    assert.equal(r.status, 200, "the first head stands");
    let t: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      r.text().then(() => "ended", () => "ended"),
      new Promise<string>((res) => { t = setTimeout(() => res("still open after 3 s"), 3000); }),
    ]);
    clearTimeout(t);
    assert.equal(settled, "ended", "the started response is ended, not left open");
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

// Postgres refuses U+0000 in a text parameter (500 and a logged stack) where SQLite answered 404 or 200, so both now
// refuse it in h(), before a route reads the store. No stored text holds U+0000 (`storableText` stores U+0001).
test("a NUL byte in a path or query parameter answers 400 JSON on every route shape", async () => {
  for (const path of ["/tx/%00/status", "/block/%00", "/domain/a%00b/proposals", "/proposal/%00", "/address/%00/reputation",
    "/proposals?domain=%00&limit=1", "/attestations?domain=a%00", "/proposal/0x00/attestations?after_txid=%00", "/proposals?domain[x]=%00"]) {
    const r = await get(path);
    assert.equal(r.status, 400, path);
    assert.match(r.type, /^application\/json/, path);
    assert.deepEqual(JSON.parse(r.body), { error: "bad request" }, path);
  }
});

test("HAPPY PATH: printable escapes in path and query parameters answer as before", async () => {
  for (const [path, status] of [["/domain/a%20b/proposals", 200], ["/proposals?domain=a%2Fb%20c&limit=1", 503], ["/domains", 200],
    ["/proposal/%01/attestations", 200], ["/tx/0x%30/status", 404]] as const) {
    assert.equal((await get(path)).status, status, path);
  }
});

