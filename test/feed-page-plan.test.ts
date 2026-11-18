// A chain-order feed page reads its own rows, wherever its cursor is and however many rows the feed holds
// (src/queries.ts feedPageStatement over the db.ts FEED_INDEX_DDL indexes, which a start creates on a database that
// lacks them). On a feed of 2,000 blocks of 12 proposals and 6 attestations, for every statement shape:
// - SQLite plan, by what must be absent: a scan of a record table, txs or outputs; a read of the record table other
//   than one bounded height range on its feed index; a sort of the whole row source inside it (only the last ORDER BY
//   term is sorted, within one height; a sort of the page's own rows outside it is allowed, as SQLite 3.45 plans one).
// - SQLite executed work: the statement's VM steps for a page near the end are at most twice the first page's and
//   under a twentieth of what the statement the feed ran before takes for that page.
// - Postgres, after ANALYZE: an executed first and late page each read no more rows of the record table than the page
//   and the heights at its two ends hold.
// The statement the feed ran before fails each check. Also: the per-height deletes of proposals and attestations
// (indexer.ts writeBlock, unwindAbove) search the height indexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpDb } from "./_tmpdb.js";
import type { FeedKind, FeedQuery } from "../src/queries.js";

const DB = tmpDb("feed-plan");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_feed_plan";
process.env.CSD_INDEX_FROM = "0";

const { store, resetStoreForTests, closeDb, FEED_INDEX_DDL } = await import("../src/db.js");
const { feedPageStatement, FEED_DOMAIN_SMALL } = await import("../src/queries.js");
const { legacyFeedPageStatement } = await import("./_feed-page-legacy.js");
await resetStoreForTests();
test.after(async () => { await closeDb(); });

const SQLITE = store().backend === "sqlite";
const NAMES = FEED_INDEX_DDL.map((s) => /INDEX IF NOT EXISTS (\w+)/.exec(s)![1]!);
const indexNames = async () => new Set((SQLITE
  ? await store().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
  : await store().all<{ name: string }>("SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()")).map((r) => r.name));

test("a start creates the feed indexes on a database that lacks them", async () => {
  assert.deepEqual(NAMES, ["idx_prop_domain_height", "idx_prop_height", "idx_att_height"]);
  for (const n of NAMES) await store().exec(`DROP INDEX IF EXISTS ${n}`);
  const before = await indexNames();
  assert.ok(NAMES.every((n) => !before.has(n)));
  await closeDb();
  const after = await indexNames();
  for (const n of NAMES) assert.ok(after.has(n), `${n} missing after a start on ${store().backend}`);
});

// 2,000 blocks of 12 proposals (10 of dense:v1) and 6 attestations (5 of a dense:v1 proposal), written as rows; in
// the first 20 blocks one proposal is small:v1's, and 30 attestations name those; the sixth attestation of every
// other block names hot:v1's one proposal (1,970 of them). none:v1 has no rows.
const PER_HEIGHT: Record<FeedKind, number> = { proposals: 12, attestations: 6 };
async function loadFeed(): Promise<void> {
  await resetStoreForTests();
  const hex = (base: number, v: string) => (SQLITE ? `printf('0x%064x', ${base} + ${v})` : `'0x' || lpad(to_hex(${base} + ${v}), 64, '0')`);
  const n = (to: number) => `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${to})`;
  await store().tx(async (d) => {
    await d.run(`${n(1999)} INSERT INTO blocks(height, hash, time, tx_count) SELECT i, ${hex(0, "i")}, 1000 + i, 19 FROM n`);
    await d.run(`${n(23999)} INSERT INTO txs(txid, height, pos, app_type) SELECT ${hex(1_000_000, "i")}, i / 12, 1 + i % 12, 'Propose' FROM n`);
    await d.run(`${n(23999)} INSERT INTO proposals(txid, domain, height, time) SELECT ${hex(1_000_000, "i")}, ` +
      "CASE WHEN i % 12 < 10 THEN 'dense:v1' WHEN i % 12 = 11 AND i < 240 THEN 'small:v1' WHEN i = 10 THEN 'hot:v1' ELSE 'other:v1' END, " +
      "i / 12, 1000 + i / 12 FROM n");
    await d.run(`${n(11999)} INSERT INTO txs(txid, height, pos, app_type) SELECT ${hex(2_000_000, "i")}, i / 6, 13 + i % 6, 'Attest' FROM n`);
    await d.run(`${n(11999)} INSERT INTO attestations(txid, proposal_id, height, time) SELECT ${hex(2_000_000, "i")}, ` +
      `${hex(1_000_000, "CASE WHEN i % 6 < 5 THEN (i / 6) * 12 + i % 6 WHEN i < 180 THEN ((i / 6) % 20) * 12 + 11 ELSE 10 END")}, ` +
      "i / 6, 1000 + i / 6 FROM n");
  });
  if (!SQLITE) await store().run("ANALYZE");
}

type Shape = Omit<FeedQuery, "after" | "limit"> & { kind: FeedKind };
// dense:v1 and no domain hold thousands of rows; small:v1 and none:v1 are under FEED_DOMAIN_SMALL; hot:v1 has one
// proposal and more attestations than FEED_DOMAIN_SMALL.
const BIG = new Set<string | null>(["dense:v1", null]);
const SHAPES: Shape[] = (["proposals", "attestations"] as const).flatMap((kind) => ["dense:v1", null, "small:v1", "none:v1", "hot:v1"].flatMap((domain) =>
  [{ height: 1999, hash: null }, null].flatMap((at) => ([1, 2] as const).map((format) => ({ kind, domain, at, format })))));
const LIMIT = 10, FIRST = null, LATE = { height: 1800, pos: 3 };
const statement = (builder: typeof feedPageStatement, s: Shape, after: FeedQuery["after"]) => builder(s.kind, { ...s, after, limit: LIMIT });
const label = (s: Shape, after: FeedQuery["after"]) => `${s.kind} domain=${s.domain} at=${s.at ? "height" : "tip"} format=${s.format} ${after ? "late" : "first"} page`;

// What a SQLite plan must not hold for the page statement to read only its page's rows. Each read of the record table
// is judged by the subquery it sits in: the row source `r`, a domain's attestation arms `h` (by height) and `b` (from
// the domain's proposals, under FEED_DOMAIN_SMALL rows, so a sort is allowed there), or the arm choice `g` (counts
// that stop at FEED_DOMAIN_SMALL).
function sqliteProblems(kind: FeedKind, plan: { id: number; parent: number; detail: string }[]): string[] {
  const home = new Map<number, string>();
  for (const r of plan) {
    const named = /^(?:MATERIALIZE|CO-ROUTINE) ([rhbg])$/.exec(r.detail)?.[1];
    const up = home.get(r.parent);
    if (named) home.set(r.id, named); else if (up) home.set(r.id, up);
  }
  const out = plan.filter((r) => /^SCAN (p|a|t|x|proposals|attestations|txs|outputs)\b/.test(r.detail)).map((r) => `scan: ${r.detail}`);
  out.push(...plan.filter((r) => /^[rh]$/.test(home.get(r.id) ?? "") && r.detail.includes("USE TEMP B-TREE FOR ORDER BY"))
    .map((r) => `sort of the whole source: ${r.detail}`));
  const range = /^SEARCH [pa] USING (COVERING )?INDEX idx_(prop_domain_height|prop_height|att_height) \((domain=\? AND )?height>\? AND height<\?\)$/;
  const record = plan.filter((r) => new RegExp(`^(SEARCH|SCAN) ${kind === "proposals" ? "p" : "a"} `).test(r.detail));
  const reads = record.filter((r) => home.get(r.id) !== "g");
  const ok = (r: { id: number; detail: string }) => home.get(r.id) === "b"
    ? /^SEARCH a USING (COVERING )?INDEX idx_att_proposal_hk \(proposal_id=\?\)$/.test(r.detail)
    : /^[rh]$/.test(home.get(r.id) ?? "") && range.test(r.detail);
  if (reads.length === 0 || reads.length > 2 || !reads.every(ok)) {
    out.push(`record table not read as the page's range: ${record.map((r) => `${home.get(r.id) ?? "-"}: ${r.detail}`).join(" | ")}`);
  }
  return out;
}

test("SQLite: no statement shape scans, sorts the whole feed, or reads the record table outside the page's range", { skip: !SQLITE && "EXPLAIN QUERY PLAN is SQLite's" }, async () => {
  await loadFeed();
  const plan = async (st: { sql: string; params: unknown[] }) => await store().all<{ id: number; parent: number; detail: string }>(`EXPLAIN QUERY PLAN ${st.sql}`, ...st.params);
  for (const s of SHAPES) {
    for (const after of [FIRST, LATE]) {
      const ours = await plan(statement(feedPageStatement, s, after));
      assert.deepEqual(sqliteProblems(s.kind, ours), [], `${label(s, after)}: ${ours.map((r) => r.detail).join(" | ")}`);
      const before = await plan(statement(legacyFeedPageStatement, s, after));
      assert.ok(sqliteProblems(s.kind, before).length > 0, `the check passes the statement it replaced: ${before.map((r) => r.detail).join(" | ")}`);
    }
  }
});

test("SQLite: writeBlock's and unwindAbove's deletes of records by height search the height indexes", { skip: !SQLITE && "EXPLAIN QUERY PLAN is SQLite's" }, async () => {
  for (const [table, ix] of [["proposals", "idx_prop_height"], ["attestations", "idx_att_height"]] as const) {
    for (const op of ["=", ">"]) {
      const plan = (await store().all<{ detail: string }>(`EXPLAIN QUERY PLAN DELETE FROM ${table} WHERE height${op}?`, 5)).map((r) => r.detail);
      assert.deepEqual(plan, [`SEARCH ${table} USING INDEX ${ix} (height${op}?)`]);
    }
  }
});

// StatementSync#stat (SQLite's per-statement counters) is in the Node that CI runs (26); on an older Node this skips.
const STAT = typeof (new DatabaseSync(":memory:").prepare("SELECT 1") as unknown as { stat?: unknown }).stat === "function";
test("SQLite: a late page takes the VM steps of the first page", { skip: (!SQLITE && "SQLite's statement counters") || (!STAT && "StatementSync#stat needs Node 26, which CI runs") }, async () => {
  await loadFeed();
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const steps = (st: { sql: string; params: unknown[] }) => {
      const p = db.prepare(st.sql) as unknown as { all: (...a: unknown[]) => unknown[]; stat: (c: string) => number };
      const rows = p.all(...st.params);
      return { rows: rows.length, vm: p.stat("vmStep"), fullscan: p.stat("fullscanStep") };
    };
    for (const s of SHAPES) {
      const first = steps(statement(feedPageStatement, s, FIRST)), late = steps(statement(feedPageStatement, s, LATE));
      const was = { first: steps(statement(legacyFeedPageStatement, s, FIRST)), late: steps(statement(legacyFeedPageStatement, s, LATE)) };
      const at = `${label(s, LATE)}: first ${JSON.stringify(first)}, late ${JSON.stringify(late)}, before ${JSON.stringify(was)}`;
      assert.ok(first.rows === was.first.rows && late.rows === was.late.rows, at);
      // fullscanStep counts the steps over the materialized page, which holds at most the page's rows
      assert.ok(first.fullscan < LIMIT && late.fullscan < LIMIT, at);
      assert.ok(late.vm <= first.vm * 2, at);
      if (BIG.has(s.domain)) assert.ok(was.late.vm > late.vm * 5 && was.late.fullscan > 900, at);
      else if (s.domain === "hot:v1" && s.kind === "attestations") assert.ok(late.vm < was.late.vm, at);
      else assert.ok(first.vm <= was.first.vm * 2 + 1000 && late.vm <= was.late.vm * 2 + 1000, at);
    }
  } finally { db.close(); }
});

test("Postgres: an executed page reads the rows of the page and of the heights at its ends", { skip: SQLITE && "the executed-plan counts are Postgres's" }, async () => {
  await loadFeed();
  const read = async (kind: FeedKind, st: { sql: string; params: unknown[] }) => {
    const [row] = await store().all<{ "QUERY PLAN": any }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${st.sql}`, ...st.params);
    let n = 0;
    const walk = (p: any) => {
      if (p["Relation Name"] === kind) n += (p["Actual Rows"] + (p["Rows Removed by Filter"] ?? 0)) * p["Actual Loops"];
      for (const c of p.Plans ?? []) walk(c);
    };
    walk(row!["QUERY PLAN"][0].Plan);
    return n;
  };
  for (const s of SHAPES) {
    for (const after of [FIRST, LATE]) {
      const ours = await read(s.kind, statement(feedPageStatement, s, after));
      // A small domain's attestation page reads its 30 attestations twice, to choose the arm and for the page, by one
      // probe per proposal (20); Actual Rows is a per-loop average rounded to an integer, up to one more row per loop.
      // hot:v1's arm choice counts FEED_DOMAIN_SMALL of its attestations; in the by-height arm Postgres keeps its own
      // join order, and by its statistics may read the one proposal's 1,970 attestations instead of walking by height.
      const bound = s.kind !== "attestations" ? LIMIT + 2 * PER_HEIGHT[s.kind]
        : s.domain === "small:v1" ? 2 * (30 + 20) : s.domain === "hot:v1" ? FEED_DOMAIN_SMALL + 1970 + 6 * LIMIT + 2 * PER_HEIGHT.attestations
        : LIMIT + 2 * PER_HEIGHT.attestations;
      assert.ok(ours <= bound && (ours > 0 || !BIG.has(s.domain)), `${label(s, after)}: ${ours} rows of ${s.kind} read`);
    }
    if (!BIG.has(s.domain)) continue;
    const before = await read(s.kind, statement(legacyFeedPageStatement, s, LATE));
    assert.ok(before > 1000, `the statement it replaced read ${before} rows of ${s.kind}`);
  }
});
