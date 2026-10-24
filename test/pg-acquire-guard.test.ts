// PgStore.acquireGuard: the second bound on the Postgres pool. connectionTimeoutMillis bounds how long one
// waiter waits; pg-pool has no bound on how many wait, so a flood of requests would park without limit
// (memory and latency grow with the queue). acquireGuard fails a store call fast once max(64, pool * 8)
// callers are already waiting; with list pages read one query at a time this takes dozens of concurrent
// requests, not four.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("acquire");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_acquire";
process.env.CSD_INDEX_PG_POOL = "2";   // wait-queue bound: max(64, 2 * 8) = 64

const { store, closeDb } = await import("../src/db.js");
const PG = store().backend === "postgres";
const SKIP = !PG && "the wait-queue bound exists only on the Postgres backend (sqlite has no pool); CI's postgres job runs it";

const burst = async (n: number) => {
  await store().get("SELECT 1");   // the schema is ready, so every call below goes straight to the guard
  const r = await Promise.allSettled([...Array(n)].map(() => store().get("SELECT pg_sleep(0.05)")));
  const failed = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
  return { ok: r.length - failed.length, failed: failed.map((x) => String(x.reason?.message ?? x.reason)) };
};

test("past the wait-queue bound a store call fails fast with the saturation error", { skip: SKIP }, async () => {
  const { ok, failed } = await burst(120);
  assert.ok(failed.length > 0, "the burst beyond 2 connections + 64 waiters is refused in part");
  assert.ok(failed.every((m) => m === "indexer db pool saturated (too many concurrent requests)"), `only the guard refuses: ${failed[0]}`);
  assert.ok(ok >= 64, `the bounded queue is still served (${ok} answered)`);
});

test("HAPPY PATH: a burst within the bound is served in full", { skip: SKIP }, async () => {
  const { ok, failed } = await burst(60);
  assert.deepEqual(failed, []);
  assert.equal(ok, 60);
});

test.after(async () => { await closeDb(); });
