// /analytics/series: bucketed hashrate / difficulty / interval over a window, from blocks(time, bits,
// chainwork). The expected vector below is derived by hand from the fixture chain (see seedChain),
// not computed by the code under test. Scenarios run in order against one store; each re-seeds the
// blocks table with a distinct hash namespace so a cached result from an earlier scenario is not reused.
//
// Backend-agnostic: sqlite by default; CSD_INDEX_PG runs the identical suite on Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB = `/tmp/csd-idx-series-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch { /* no stale file to remove */ } }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_series";

import type { Store } from "../src/db.js";
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { series } = await import("../src/analytics.js");
const { buildApp } = await import("../src/server.js");
await resetStoreForTests();

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const port = (srv.address() as { port: number }).port;
const get = async (qs: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/analytics/series${qs}`);
  return { status: res.status, body: (await res.json()) as Series };
};
test.after(async () => { srv.close(); await closeDb(); });

interface Point { t: number; height: number; ghs: number | null; difficulty: number | null; intervalSecs: number | null }
interface Series { window: string; from: number | null; to: number | null; points: Point[] }

const SQL_BLOCK = "INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES (?,?,?,?,?,?,?,?,?,?,0)";
const hash = (ns: number, h: number) => "0x" + (ns * 100_000 + h).toString(16).padStart(64, "0");
const BASE_WORK = 1n << 60n; // past 2^53: the chainwork delta must stay exact
const T0 = 1_700_000_000;

// Heights 10..30. Work per block and spacing change at 15/16 and 20/21 so the four buckets differ:
//   h 11..15: 1e12 work, 120s apart      h 16..20: 1e12 work, 240s apart (bits 0x1e00ffff)
//   h 21..30: 3e12 work,  60s apart (bits 0x1d00ffff)
function chainRow(h: number): { time: number; bits: number; work: bigint } {
  if (h <= 15) return { time: T0 + 120 * (h - 10), bits: 0x1e00ffff, work: BASE_WORK + 1_000_000_000_000n * BigInt(h - 10) };
  if (h <= 20) return { time: T0 + 600 + 240 * (h - 15), bits: 0x1e00ffff, work: BASE_WORK + 1_000_000_000_000n * BigInt(h - 10) };
  return { time: T0 + 1800 + 60 * (h - 20), bits: 0x1d00ffff, work: BASE_WORK + 10_000_000_000_000n + 3_000_000_000_000n * BigInt(h - 20) };
}
async function putBlock(ns: number, h: number, c: { time: number; bits: number; work: bigint }, s: Store = store()): Promise<void> {
  await s.run(SQL_BLOCK, h, hash(ns, h), hash(ns, h - 1), hash(ns + 50, h), c.time, c.bits, 0, 1, 1, c.work.toString());
}
async function seedChain(ns: number, lo: number, hi: number): Promise<void> {
  await store().tx(async (s) => {
    await s.run("DELETE FROM blocks");
    for (let h = lo; h <= hi; h++) await putBlock(ns, h, chainRow(h), s);
  });
}

// workForBits(0x1e00ffff) = 16777472, workForBits(0x1d00ffff) = 4295032833 (checked against csd-codec).
const EXPECTED: Point[] = [
  { t: T0 + 600, height: 15, ghs: 8.333333333333332, difficulty: 16777472, intervalSecs: 120 },
  { t: T0 + 1800, height: 20, ghs: 4.166666666666666, difficulty: 16777472, intervalSecs: 240 },
  { t: T0 + 2100, height: 25, ghs: 50, difficulty: 4295032833, intervalSecs: 60 },
  { t: T0 + 2400, height: 30, ghs: 50, difficulty: 4295032833, intervalSecs: 60 },
];

test("empty chain: no points, no throw, nulls for the range", async () => {
  const r = (await series("all", 56)) as Series;
  assert.deepEqual(r, { window: "all", from: null, to: null, points: [] });
});

test("one-block window: a single point with null ghs and interval, never NaN", async () => {
  await seedChain(1, 10, 10);
  const r = (await series("all", 56)) as Series;
  assert.deepEqual(r, { window: "all", from: 10, to: 10, points: [{ t: T0, height: 10, ghs: null, difficulty: 16777472, intervalSecs: null }] });
  assert.doesNotMatch(JSON.stringify(r), /NaN|Infinity/);
});

test("bucketed ghs / difficulty / interval equal the hand-derived vector", async () => {
  await seedChain(2, 10, 30);
  const r = (await series("all", 4)) as Series;
  assert.equal(r.window, "all");
  assert.equal(r.from, 10);
  assert.equal(r.to, 30);
  assert.deepEqual(r.points, EXPECTED);
});

test("route: honest call shape (window + points query) serves the same vector", async () => {
  const { status, body } = await get("?window=1d&points=4");
  assert.equal(status, 200);
  assert.deepEqual(body, { window: "1d", from: 10, to: 30, points: EXPECTED });
});

test("window narrower than the chain: from moves to tip - span, buckets restart there", async () => {
  // 1d = 720 blocks; shrink the span by seeding a longer chain: 10..800 uses the h>20 rule for every block above 20
  await seedChain(3, 10, 800);
  const r = (await series("1d", 5)) as Series;
  assert.equal(r.from, 800 - 720);
  assert.equal(r.to, 800);
  assert.equal(r.points.length, 5);
  assert.equal(r.points[4]!.height, 800);
  for (const p of r.points) {
    assert.equal(p.ghs, 50);
    assert.equal(p.intervalSecs, 60);
  }
});

test("points are clamped to 1..200 and default to 56; fractional floors", async () => {
  await seedChain(4, 10, 800);
  assert.equal(((await series("all", 1000)) as Series).points.length, 200);
  assert.equal(((await series("all", 0)) as Series).points.length, 56);
  assert.equal(((await series("all", Number.NaN)) as Series).points.length, 56);
  assert.equal(((await series("all", -3)) as Series).points.length, 1);
  assert.equal(((await series("all", 7.9)) as Series).points.length, 7);
  assert.equal(((await series("all")) as Series).points.length, 56);
  const one = ((await series("all", 1)) as Series).points;
  assert.equal(one.length, 1);
  assert.equal(one[0]!.height, 800);
  const route = await get("?window=all&points=99999");
  assert.equal(route.body.points.length, 200);
  const junk = await get("?window=all&points=abc");
  assert.equal(junk.body.points.length, 56);
});

test("unknown window folds to all, including Object.prototype names", async () => {
  await seedChain(5, 10, 30);
  const all = (await series("all", 4)) as Series;
  assert.equal(await series("bogus", 4), all, "folded to the same cached object");
  assert.equal(await series("constructor", 4), all);
  assert.equal(await series("toString", 4), all);
  assert.equal(all.window, "all");
  assert.equal(all.from, 10);
  const route = await get("?window=bogus&points=4");
  assert.equal(route.body.window, "all");
  assert.deepEqual(route.body.points, EXPECTED);
  const noArgs = await get("");
  assert.equal(noArgs.body.window, "1d");
});

test("flat chainwork or equal timestamps in a bucket give null, not 0 / NaN / Infinity", async () => {
  await seedChain(6, 10, 20);
  // two extra blocks: the first repeats the tip's chainwork 120s later, the second repeats the tip's time with more work
  await putBlock(6, 21, { time: T0 + 1800 + 120, bits: 0x1e00ffff, work: chainRow(20).work });
  await putBlock(6, 22, { time: T0 + 1800 + 120, bits: 0x1e00ffff, work: chainRow(20).work + 5n });
  const r = (await series("all", 12)) as Series;
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /NaN|Infinity/);
  const byH = new Map(r.points.map((p) => [p.height, p]));
  assert.equal(byH.get(21)!.ghs, null, "dw = 0 over the bucket");
  assert.equal(byH.get(21)!.intervalSecs, null);
  assert.equal(byH.get(22)!.ghs, null, "dt = 0 over the bucket");
  assert.equal(byH.get(22)!.intervalSecs, null);
  assert.ok(byH.get(15)!.ghs! > 0);
});

test("a missing canonical row omits its point and the next bucket spans the gap", async () => {
  await seedChain(8, 10, 30);
  await store().run("DELETE FROM blocks WHERE height=20");
  const r = (await series("all", 4)) as Series;
  assert.deepEqual(r.points.map((p) => p.height), [15, 25, 30]);
  // 15 -> 25: chainwork delta 2e13 over 1500s across 10 blocks
  assert.equal(r.points[1]!.ghs, 13.333333333333334);
  assert.equal(r.points[1]!.intervalSecs, 150);
});

test("memo per tip: same tip and canonical args return one object; a new block recomputes", async () => {
  await seedChain(7, 10, 30);
  const a = await series("all", 4);
  assert.equal(await series("all", 4), a, "same args, same tip: cached");
  assert.equal(await series("all", 4.5), a, "fractional points canonicalize to the same key");
  assert.equal(await series("nope", 4), a, "unknown window canonicalizes to all");
  assert.equal(await series("all", 5000), await series("all", 9999), "points above the cap share one key");
  assert.notEqual(await series("all", 5), a, "different points: different key");

  await putBlock(7, 31, { time: T0 + 2460, bits: 0x1d00ffff, work: chainRow(30).work + 3_000_000_000_000n });
  const b = (await series("all", 4)) as Series;
  assert.notEqual(b, a, "tip moved: recomputed");
  assert.equal(b.to, 31);
  assert.equal((a as Series).to, 30);
});
