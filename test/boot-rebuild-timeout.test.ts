// The start rebuilds coinbase_totals and address_totals from every outputs and address_history row (src/db.ts), and
// that grows with rows anyone can add. Under the pool's statement timeout a slow rebuild failed every start; the
// rebuild lifts the timeout for its own transaction only, and every other statement on the connection keeps it.
// A store opened with a DSN that sets a 100 ms timeout stands in for a database where the rebuild outgrows 30 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("boot-timeout");
process.env.CSD_INDEX_PG_SCHEMA = "t_boot_timeout";

const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
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
