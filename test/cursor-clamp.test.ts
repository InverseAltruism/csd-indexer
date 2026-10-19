// I5 (O-4): the two public height cursors clamp instead of breaking.
//
// `/domain/:d/proposals?from=` and `/proposal/:id/attestations?after_height=` are PUBLIC GETs, reachable
// through cairn's EXPLORER_READ allowlist. Both guarded with Number.isFinite rather than the heightOk
// helper this file already carries, which produced two defects:
//   * `?from=1e21` / `?after_height=1e21` bound 1e21 as an int8 param, which Postgres REJECTS (measured
//     HTTP 500 on production), while sqlite answered 200-empty. A public read that disagrees across the
//     two backends contradicts this repo's byte-identical-rows claim.
//   * `?from=abc` fell THROUGH to the legacy DESCENDING window while `?from=0` is ASCENDING, so one
//     malformed cursor silently flipped the ordering contract and a consumer applying the short-page rule
//     truncated its feed.
// The hard constraint on the fix is NO NEW 4xx on a currently-200 public GET (D-27): clamp and widen, never
// reject. An unusable `from` clamps to 0 and still takes the ASCENDING branch; an unusable `after_height`
// drops the cursor and serves the uncursored ascending page, which is a superset, never a truncation.
//
// Driven through buildApp() so the assertions run against production's exact route + query handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB = `/tmp/csd-idx-cursor-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_cursor";
process.env.CSD_INDEX_FROM = "0";

const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");
await resetStoreForTests();

const DOMAIN = "csd:test";
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const PROP = id(7);
for (let h = 0; h < 5; h++) {
  await store().run("INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time) VALUES(?,?,?,?,?,?,?,?,?)",
    id(100 + h), DOMAIN, id(1), "u", 9999, id(2), 0, h, 1_700_000_000 + h);
  await store().run("INSERT INTO attestations(txid,proposal_id,attester,score,confidence,fee,height,time) VALUES(?,?,?,?,?,?,?,?)",
    id(200 + h), PROP, id(3), 100, 100, 0, h, 1_700_000_000 + h);
}

const app = buildApp();
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const P = (srv.address() as { port: number }).port;
const get = async (path: string): Promise<{ status: number; body: any[] }> => {
  const r = await fetch(`http://127.0.0.1:${P}${path}`);
  return { status: r.status, body: (await r.json()) as any[] };
};
const props = (path: string) => get(`/domain/${encodeURIComponent(DOMAIN)}/proposals${path}`);
const atts = (path: string) => get(`/proposal/${PROP}/attestations${path}`);
const heights = (rows: any[]) => rows.map((r) => Number(r.height));

test.after(async () => { srv.close(); await closeDb(); });

// ── PAIRED HAPPY-PATH FIRST: production's exact call shape is cairnx/src/scan.ts:313, always an integer ──
test("HAPPY PATH: cairnx's integer cursor (?from=maxH) is unchanged", async () => {
  const zero = await props("?from=0");
  assert.equal(zero.status, 200);
  assert.deepEqual(heights(zero.body), [0, 1, 2, 3, 4], "ascending, complete");
  const mid = await props("?from=3");
  assert.equal(mid.status, 200);
  assert.deepEqual(heights(mid.body), [3, 4], "rows at height >= from, ascending: the resolver's paging contract");
  const past = await props("?from=99");
  assert.equal(past.status, 200);
  assert.deepEqual(heights(past.body), [], "a cursor past the tip is still an empty page, not an error");
});

test("HAPPY PATH: no cursor keeps the legacy newest-first window", async () => {
  const r = await props("");
  assert.equal(r.status, 200);
  assert.deepEqual(heights(r.body), [4, 3, 2, 1, 0], "the wholly-absent-cursor DESC window is preserved");
});

test("HAPPY PATH: a real attestation keyset cursor pages exactly as today", async () => {
  const first = await atts("?limit=2");
  assert.equal(first.status, 200);
  assert.deepEqual(heights(first.body), [0, 1]);
  const last = first.body[first.body.length - 1];
  const next = await atts(`?limit=2&after_height=${last.height}&after_txid=${last.txid}`);
  assert.equal(next.status, 200);
  assert.deepEqual(heights(next.body), [2, 3], "the keyset cursor still advances");
});

// ── I5 RED-FIRST ──
test("I5: ?from=1e21 answers 200 with the clamped ascending page (pg 500'd, sqlite went 200-empty)", async () => {
  const r = await props("?from=1e21");
  assert.equal(r.status, 200, "no 500, and no new 4xx on a public GET");
  assert.deepEqual(heights(r.body), [0, 1, 2, 3, 4], "an unusable cursor clamps to 0: a superset, never a truncation");
});

test("I5: ?from=abc keeps the ASCENDING ordering contract (it used to flip to DESC)", async () => {
  const bad = await props("?from=abc");
  const zero = await props("?from=0");
  assert.equal(bad.status, 200);
  assert.deepEqual(heights(bad.body), heights(zero.body), "same order and same rows as ?from=0");
  assert.deepEqual(heights(bad.body), [0, 1, 2, 3, 4], "ascending, not the legacy descending window");
});

test("I5: other unusable `from` shapes clamp the same way (one idiom, no drift)", async () => {
  for (const v of ["-1", "2.5", "NaN", "Infinity", "9007199254740993"]) {
    const r = await props(`?from=${encodeURIComponent(v)}`);
    assert.equal(r.status, 200, `?from=${v} stays 200`);
    assert.deepEqual(heights(r.body), [0, 1, 2, 3, 4], `?from=${v} clamps to the full ascending page`);
  }
});

test("I5: ?after_height=1e21 drops the cursor and serves the uncursored ascending page", async () => {
  const r = await atts(`?after_height=1e21&after_txid=${id(200)}`);
  assert.equal(r.status, 200, "no 500, and no new 4xx");
  assert.deepEqual(heights(r.body), [0, 1, 2, 3, 4], "a superset of the requested page, never a truncation");
});
