// A Postgres session that ends while its client is checked out of the pool (a database restart, pg_terminate_backend):
// in the writer's transaction, in a reader's snapshot and in the start. pg-pool removes its own 'error' listener at
// checkout, so the client's 'error' event had no listener and ended the process: the sync loop, the API and its
// streams went down with it. The call fails, the next ones are served, and the process lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("clientloss");
process.env.CSD_INDEX_PG_SCHEMA = "t_clientloss";
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const PG = store().backend === "postgres";
const SKIP = !PG && "Postgres only: SQLite has no server session to lose";
const repo = fileURLToPath(new URL("..", import.meta.url));
const pg = (await import("pg")).default;
test.after(async () => { await closeDb(); });

// Runs `body` in a child process on the suite's database with `app` as application_name, and ends that name's sessions
// once the child is in it (after `delay` ms). Returns the child's exit code and what it printed.
async function run(app: string, body: string, delay: number, before?: () => Promise<() => Promise<void>>) {
  const CHILD = `
    const { store, tx, snapshot, asWriter, closeDb } = await import("./src/db.ts");
    const out = {};
    ${app.endsWith("start") ? "" : `await store().get("SELECT 1"); await asWriter(() => store().get("SELECT 1"));`}
    console.log("in");
    try { ${body} out.call = "ok"; } catch (e) { out.call = "failed"; }
    const next = async (f) => { try { await f(); return "ok"; } catch (e) { return String(e.message); } };
    out.read = await next(() => store().get("SELECT COUNT(*) AS n FROM blocks"));
    out.write = await next(() => asWriter(() => tx(async (d) => { await d.run("DELETE FROM meta WHERE key = 'none'"); })));
    out.write2 = await next(() => asWriter(() => tx(async (d) => { await d.run("DELETE FROM meta WHERE key = 'none'"); })));
    console.log(JSON.stringify(out));
    await closeDb();
  `;
  const dsn = `${process.env.CSD_INDEX_PG}${process.env.CSD_INDEX_PG!.includes("?") ? "&" : "?"}application_name=${app}`;
  const release = before ? await before() : async () => { /* nothing held */ };
  const child = spawn("./node_modules/.bin/tsx", ["--input-type=module", "-e", CHILD],
    { cwd: repo, env: { ...process.env, CSD_INDEX_PG: dsn, CSD_INDEX_PG_POOL: "2" } });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const admin = new pg.Client({ connectionString: process.env.CSD_INDEX_PG });
  await admin.connect();
  try {
    await new Promise<void>((r) => { const i = setInterval(() => { if (out.includes("in")) { clearInterval(i); r(); } }, 20); });
    await new Promise((r) => setTimeout(r, delay));
    const k = await admin.query("SELECT count(pg_terminate_backend(pid)) AS n FROM pg_stat_activity WHERE application_name = $1", [app]);
    await release();
    const code: number = await new Promise((r) => child.on("exit", (c) => r(c ?? -1)));
    const last = out.trim().split("\n").pop() ?? "";
    return { code, ended: Number(k.rows[0].n), res: last.startsWith("{") ? JSON.parse(last) : null, err };
  } finally { await admin.end(); }
}
const served = { call: "failed", read: "ok", write: "ok", write2: "ok" };

test("Postgres: a session ended in the middle of the writer's transaction fails the transaction only", { skip: SKIP }, async () => {
  await resetStoreForTests();
  const r = await run("idx_loss_tx", `await asWriter(() => tx(async (d) => { await d.run("SELECT pg_sleep(5)"); }));`, 400);
  assert.ok(r.ended >= 1, "a session was ended");
  assert.equal(r.code, 0, `the process lives: ${r.err.split("\n").find((l) => /error/i.test(l)) ?? ""}`);
  assert.deepEqual(r.res, served, "the next read and writes are served on new connections");
});

test("Postgres: a session ended between two statements of a reader's snapshot fails the snapshot only", { skip: SKIP }, async () => {
  await resetStoreForTests();
  const r = await run("idx_loss_snap",
    `await snapshot(async () => { await store().get("SELECT 1"); await new Promise((r) => setTimeout(r, 1500)); await store().get("SELECT 1"); });`, 400);
  assert.ok(r.ended >= 1);
  assert.equal(r.code, 0, `the process lives: ${r.err.split("\n").find((l) => /error/i.test(l)) ?? ""}`);
  assert.deepEqual(r.res, served);
});

test("Postgres: a session ended while the start waits fails that start, and the next store call starts again", { skip: SKIP }, async () => {
  await resetStoreForTests();
  // Another session holds the totals tables, so the start's rebuild waits on the lock (up to BOOT_LOCK_TIMEOUT_MS).
  const hold = async () => {
    const c = new pg.Client({ connectionString: process.env.CSD_INDEX_PG });
    await c.connect();
    await c.query("BEGIN");
    await c.query("LOCK TABLE t_clientloss.coinbase_totals IN ACCESS EXCLUSIVE MODE");
    return async () => { await c.query("ROLLBACK"); await c.end(); };
  };
  const r = await run("idx_loss_start", `await store().get("SELECT 1");`, 400, hold);
  assert.ok(r.ended >= 1);
  assert.equal(r.code, 0, `the process lives: ${r.err.split("\n").find((l) => /error/i.test(l)) ?? ""}`);
  assert.deepEqual(r.res, served);
});
