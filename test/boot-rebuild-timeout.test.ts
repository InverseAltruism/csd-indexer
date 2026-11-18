// A start's two transactions grow with the rows (src/db.ts bootTx): the schema DDL builds an index it adds over every
// row of the table, and the rebuild of coinbase_totals and address_totals reads every outputs and address_history row,
// which anyone can add. Under the pool's statement timeout either would fail every start once it outgrew it; each lifts
// the timeout for its own transaction only, and every other statement on the connection keeps it. A store opened with
// a DSN that sets a 100 ms or 50 ms timeout stands in for a database where they outgrow 30 s. A lock another session
// holds is waited for at most BOOT_LOCK_TIMEOUT_MS: the start then fails with that error, and the next one completes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("boot-timeout");
process.env.CSD_INDEX_PG_SCHEMA = "t_boot_timeout";

const { store, resetStoreForTests, closeDb, FEED_INDEX_DDL, BOOT_LOCK_TIMEOUT_MS } = await import("../src/db.js");
const PG = store().backend === "postgres";
test.after(async () => { await closeDb(); });
const repo = fileURLToPath(new URL("..", import.meta.url));

// Opens the store as the service does (one pooled connection, so the read below runs on the connection that ran the
// rebuild), with the DSN's timeout, and reports the start and a 300 ms read.
const CHILD = `
  const { store, closeDb } = await import("./src/db.ts");
  const out = {};
  try { await store().get("SELECT 1"); out.start = "ok"; } catch (e) { out.start = String(e.message); }
  try { await store().get("SELECT pg_sleep(0.3)"); out.read = "ok"; } catch (e) { out.read = String(e.message); }
  const n = await store().get("SELECT COUNT(*) AS n FROM address_totals").catch((e) => ({ n: String(e.message) }));
  out.rows = String(n?.n);
  console.log(JSON.stringify(out));
  await closeDb();
`;

test("Postgres: a start whose totals rebuild outlasts the statement timeout completes, and reads keep the timeout",
  { skip: !PG && "the statement timeout is Postgres's; SQLite has none" }, async () => {
    await resetStoreForTests();
    const N = 300_000;
    await store().run(`INSERT INTO outputs(txid,vout,addr,value,height) SELECT '0x' || lpad(to_hex(i), 64, '0'), 0,
      '0x' || lpad(to_hex(i % 5000), 40, '0'), i, i FROM generate_series(1::bigint, ${N}) AS g(i)`);
    await store().run(`INSERT INTO address_history(addr,txid,height,pos,direction,delta) SELECT '0x' || lpad(to_hex(i % 5000), 40, '0'),
      '0x' || lpad(to_hex(i), 64, '0'), i, 0, 'in', i FROM generate_series(1::bigint, ${N}) AS g(i)`);
    await closeDb();
    const dsn = `${process.env.CSD_INDEX_PG}${process.env.CSD_INDEX_PG!.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c statement_timeout=100")}`;
    const { stdout } = await promisify(execFile)("./node_modules/.bin/tsx", ["--input-type=module", "-e", CHILD], {
      cwd: repo, env: { ...process.env, CSD_INDEX_PG: dsn, CSD_INDEX_PG_POOL: "1" } });
    const out = JSON.parse(stdout.trim().split("\n").pop()!);
    assert.equal(out.start, "ok", "the start's rebuild ran past the 100 ms timeout and committed");
    assert.equal(out.rows, "5000", "address_totals holds every address");
    assert.match(out.read, /statement timeout/, "HAPPY PATH: an ordinary read on that connection still gets the timeout");
  });

// Opens the store as the service does and reports the start, the feed indexes it holds and a 300 ms read.
const CHILD_DDL = `
  const { store, closeDb } = await import("./src/db.ts");
  const out = {};
  try { await store().get("SELECT 1"); out.start = "ok"; } catch (e) { out.start = String(e.message); }
  if (out.start === "ok") {
    const ix = await store().all("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()");
    out.indexes = ix.map((r) => r.indexname);
    try { await store().get("SELECT pg_sleep(0.3)"); out.read = "ok"; } catch (e) { out.read = String(e.message); }
  }
  console.log(JSON.stringify(out));
  await closeDb();
`;
const FEED_INDEXES = FEED_INDEX_DDL.map((q) => /INDEX IF NOT EXISTS (\w+)/.exec(q)![1]!);
async function start(options: string | null): Promise<{ start: string; indexes?: string[]; read?: string }> {
  const base = process.env.CSD_INDEX_PG!;
  const dsn = options === null ? base : `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(options)}`;
  // A start that waits on a lock without a bound would hang here: the child is killed at 30 s and the test fails.
  const { stdout } = await promisify(execFile)("./node_modules/.bin/tsx", ["--input-type=module", "-e", CHILD_DDL], {
    cwd: repo, timeout: 30_000, env: { ...process.env, CSD_INDEX_PG: dsn, CSD_INDEX_PG_POOL: "1" } });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

test("Postgres: a start that builds the feed indexes past the statement timeout completes, and reads keep the timeout",
  { skip: !PG && "the statement timeout is Postgres's; SQLite has none" }, async () => {
    await resetStoreForTests();
    for (const n of FEED_INDEXES) await store().exec(`DROP INDEX IF EXISTS ${n}`);
    await store().run(`INSERT INTO proposals(txid, domain, height, time) SELECT '0x' || lpad(to_hex(i), 64, '0'),
      'domain:' || (i % 7), i / 30, i FROM generate_series(1::bigint, 400000) AS g(i)`);
    await store().run(`INSERT INTO attestations(txid, proposal_id, height, time) SELECT '0x' || lpad(to_hex(1000000 + i), 64, '0'),
      '0x' || lpad(to_hex(i), 64, '0'), i / 30, i FROM generate_series(1::bigint, 100000) AS g(i)`);
    await closeDb();
    const out = await start("-c statement_timeout=50");
    assert.equal(out.start, "ok", "the start built the three indexes past the 50 ms timeout and committed");
    for (const n of FEED_INDEXES) assert.ok(out.indexes!.includes(n), `${n} built by the start`);
    assert.match(out.read!, /statement timeout/, "HAPPY PATH: an ordinary read on that connection still gets the timeout");
  });

test("Postgres: a start behind another session's lock fails after the lock timeout, and the next start completes",
  { skip: !PG && "lock_timeout is Postgres's; SQLite waits busy_timeout for the write lock and the next store() opens again" }, async () => {
    await resetStoreForTests();
    let blocked: Awaited<ReturnType<typeof start>> | null = null;
    // SHARE ROW EXCLUSIVE conflicts with the SHARE lock the DDL's CREATE INDEX IF NOT EXISTS takes on proposals.
    await store().tx(async (d) => {
      await d.run("LOCK TABLE proposals IN SHARE ROW EXCLUSIVE MODE");
      blocked = await start(null);
    });
    assert.match(blocked!.start, new RegExp(`the start waited ${BOOT_LOCK_TIMEOUT_MS} ms for a lock another session holds`));
    assert.match(blocked!.start, /lock timeout/);
    const next = await start(null);
    assert.equal(next.start, "ok", "HAPPY PATH: with the lock released the next start completes");
  });
