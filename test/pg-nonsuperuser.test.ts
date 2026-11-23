// A start on Postgres as a role that owns its database and is not a superuser, as a service's role usually is. The
// start read pg_statistic_ext_data, which only a superuser may read, so every start of such a role failed with
// "permission denied" and no route answered. The role here creates its schema, the index and the statistics object,
// fills the statistics with ANALYZE at a start, and starts again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PG = process.env.CSD_INDEX_PG ?? "";
const ROLE = "csdidx_t_owner", DB = "csdidx_t_owner";
const repo = fileURLToPath(new URL("..", import.meta.url));
const pg = (await import("pg")).default;

// Whether the suite's role may create the test's role and database; the CI Postgres job runs the whole suite as a
// non-superuser owner instead, which may not.
const canCreate = await (async () => {
  if (!PG) return false;
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  try {
    const r = await c.query("SELECT rolsuper OR (rolcreaterole AND rolcreatedb) AS ok FROM pg_roles WHERE rolname = current_user");
    return r.rows[0]?.ok === true;
  } finally { await c.end(); }
})();
const SKIP = !PG ? "Postgres only" : !canCreate ? "the suite's role cannot create a role and a database; the CI Postgres job runs every file as a non-superuser owner" : false;

async function admin(sql: string[]): Promise<void> {
  const c = new pg.Client({ connectionString: PG });
  await c.connect();
  try { for (const q of sql) await c.query(q); } finally { await c.end(); }
}
const ownerDsn = (() => {
  if (!PG) return "";
  const u = new URL(PG);
  u.username = ROLE; u.password = "t-owner"; u.pathname = `/${DB}`; u.search = "";
  return u.toString();
})();

// One start as the service does it, then `then` on the started store; prints the start's result and then's.
const child = (then: string) => `
  const { store, closeDb } = await import("./src/db.ts");
  const out = {};
  try { await store().get("SELECT 1"); out.start = "ok"; } catch (e) { out.start = String(e.message); }
  if (out.start === "ok") out.then = await (async (s) => { ${then} })(store());
  console.log(JSON.stringify(out));
  await closeDb();
`;
async function start(then = "return null;"): Promise<{ start: string; then: unknown }> {
  const { stdout } = await promisify(execFile)("./node_modules/.bin/tsx", ["--input-type=module", "-e", child(then)], {
    cwd: repo, env: { ...process.env, CSD_INDEX_PG: ownerDsn, CSD_INDEX_PG_SCHEMA: "t_nonsuper", CSD_INDEX_PG_POOL: "2" } });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

test("Postgres: a non-superuser owner starts, fills the statistics at a start, and starts again", { skip: SKIP }, async () => {
  await admin([`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, `DROP ROLE IF EXISTS ${ROLE}`,
    `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 't-owner'`, `CREATE DATABASE ${DB} OWNER ${ROLE}`]);
  try {
    const first = await start(`
      await s.run("INSERT INTO outputs(txid,vout,addr,value,height) SELECT 'tx' || g, 0, 'a' || (g % 7), 5, g FROM generate_series(1, 200) AS g");
      const r = await s.get("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
      return r.rolsuper;`);
    assert.equal(first.start, "ok", "the first start, which creates the schema, the index and the statistics object");
    assert.equal(first.then, false, "the store ran as a role that is not a superuser");
    const second = await start(`
      const r = await s.get("SELECT COUNT(*) AS n FROM pg_stats_ext WHERE statistics_schemaname = current_schema() AND statistics_name = 'st_out_addr_unspent'");
      return Number(r.n);`);
    assert.equal(second.start, "ok");
    assert.equal(second.then, 1, "the start ran ANALYZE as the owner, so the statistics object holds data");
    assert.equal((await start()).start, "ok", "a start with the statistics filled");
  } finally {
    await admin([`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, `DROP ROLE IF EXISTS ${ROLE}`]);
  }
});
