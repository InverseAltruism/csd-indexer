// /health surface test (Phase B): the endpoint was the one unmemoized full-scan route (counts()
// = four COUNT(*) per hit while being the failover-LB poll target) and carried no version tell.
// Pins: (1) field shape incl. the additive version/backend fields, (2) counts() behind memoByTip
// runs once per tip and re-runs on a new block, (3) freshness fields stay live (not memoized).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("health");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_health";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "123456";

const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { memoByTip } = await import("../src/analytics.js");
const { counts } = await import("../src/queries.js");
const { buildApp, readCommit } = await import("../src/server.js");
await resetStoreForTests();

const A = "0x" + "aa".repeat(20);
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const SQL_BLOCK = "INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES (?,?,?,?,?,?,?,?,?,?,0)";
const SQL_TX = "INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES (?,?,?,?,?,?,?,?,?,?)";

async function addBlock(h: number): Promise<void> {
  const s = store();
  await s.run(SQL_BLOCK, h, id(1000 + h), id(999 + h), id(2000 + h), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, 1, String(h * 1000));
  await s.run(SQL_TX, id(10_000 + h), h, 0, "Coinbase", A, 0, 1_700_000_000 + h * 120, 1, 1, 1);
}

await addBlock(0);
await addBlock(1);

const app = buildApp();
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const port = (srv.address() as { port: number }).port;
const health = async () => (await fetch(`http://127.0.0.1:${port}/health`)).json() as Promise<Record<string, unknown>>;

test.after(async () => { srv.close(); await closeDb(); });

test("health: field shape incl. additive version/backend", async () => {
  const j = await health();
  assert.equal(j.ok, true);
  assert.match(String(j.version), /^\d+\.\d+\.\d+/);        // package version, not "unknown"
  assert.ok(j.backend === "sqlite" || j.backend === "postgres");
  assert.equal(j.tip_height, 1);
  assert.equal(j.blocks, 2);                                 // counts() spread is preserved
  assert.equal(j.txs, 2);
  assert.equal(typeof j.seconds_since_tip, "number");
  assert.equal(typeof j.stale, "boolean");
});

test("health counts: memoByTip runs the scans once per tip, re-runs on a new block", async () => {
  let calls = 0;
  const counted = memoByTip(async () => { calls++; return counts(); });
  const a = await counted();
  const b = await counted();
  assert.equal(calls, 1, "second same-tip call must hit the memo");
  assert.equal(a, b, "reference identity = cache hit");
  await addBlock(2);
  const c = (await counted()) as Awaited<ReturnType<typeof counts>>;
  assert.equal(calls, 2, "tip change must bust the memo");
  assert.equal(c.blocks, 3);
});

test("health freshness: seconds_since_tip tracks the NEW tip immediately (not memoized)", async () => {
  const before = await health();
  await addBlock(3); // tip time advances 120s per block → age drops by ~120s vs the old tip
  const after = await health();
  assert.equal(after.tip_height, 3);
  assert.equal(after.blocks, 4, "served counts refresh with the tip");
  assert.ok(Number(after.seconds_since_tip) <= Number(before.seconds_since_tip) - 100,
    "freshness must be computed from the live tip row, not a cached one");
});

// What the process loaded: the tree's HEAD read once at start, so a pull without a restart shows as a mismatch, and the
// checkpoint floor in force. The live unit runs as another user than the tree's owner, where git refuses the tree
// unless safe.directory names it; GIT_TEST_ASSUME_DIFFERENT_OWNER makes git treat this tree that way.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HEAD = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().slice(0, 7);

test("health: build.commit is the tree's HEAD and checkpoint_floor the floor in force", async () => {
  const before = Date.now();
  const j = await health();
  const build = j.build as { commit: string; startedAt: number };
  assert.equal(build.commit, HEAD);
  assert.ok(Number.isSafeInteger(build.startedAt) && build.startedAt <= before, "startedAt is the start, not this read");
  assert.equal(j.checkpoint_floor, 123456);
});

// The host's own git config is left out (no global or system file), so a safe.directory entry there (actions/checkout
// adds the workspace to the global config) can neither make the refusal vanish nor stand in for readCommit's own.
const OTHER_OWNER = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null" };
test("readCommit: the HEAD on a tree another user owns; \"unknown\" outside a checkout", () => {
  const saved = Object.fromEntries(Object.keys(OTHER_OWNER).map((k) => [k, process.env[k]]));
  Object.assign(process.env, OTHER_OWNER);
  try {
    assert.throws(() => execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] }),
      (e: { stderr?: Buffer }) => /dubious ownership/.test(String(e.stderr)), "plain git refuses the tree");
    assert.equal(readCommit(ROOT), HEAD);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const bare = mkdtempSync(join(tmpdir(), "csd-idx-nogit-"));
  try { assert.equal(readCommit(bare), "unknown"); } finally { rmSync(bare, { recursive: true, force: true }); }
});

// cairn's /api/health gives 7 characters; git's --short follows the host's core.abbrev, which may be longer.
test("readCommit: 7 characters whatever core.abbrev the host sets", () => {
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.abbrev", GIT_CONFIG_VALUE_0: "12" });
  try {
    assert.equal(execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim().length, 12, "the setting reaches git");
    assert.equal(readCommit(ROOT), HEAD);
  } finally { for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[k]; }
});
