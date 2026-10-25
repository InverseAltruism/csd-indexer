// coinbase_totals is a second home for the coinbase-output aggregate (db.ts COINBASE_OUTPUTS), so it must equal
// that aggregate after every write the indexer can make. A seeded random walk of block writes, same-height
// re-writes and unwinds (deep ones included, and hostile shapes: a coinbase txid replayed at another height, a
// txid repeated within a block, a non-coinbase tx reusing a coinbase txid) compares the two after every step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("cbtotals");
process.env.CSD_INDEX_PG_SCHEMA = "t_coinbase_totals";
process.env.CSD_INDEX_FROM = "0";

const { writeBlock, unwindAbove, coinbaseRowsSql, COINBASE_WHERE } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb, COINBASE_OUTPUTS, coinbaseTotalsRebuildSql } = await import("../src/db.js");
await resetStoreForTests();
test.after(async () => { await closeDb(); });

const SQLITE = store().backend === "sqlite";

// mulberry32: deterministic, so a failure reproduces from the seed
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ADDRS = ["a1", "b2", "c3", "d4", "e5"].map((b) => b.repeat(20));
const hex32 = (n: number) => "0x" + n.toString(16).padStart(64, "0");

async function totals(): Promise<string[]> {
  const rows = await store().all<{ addr: string; outputs: unknown; value: unknown }>("SELECT addr, outputs, value FROM coinbase_totals ORDER BY addr");
  return rows.map((r) => `${r.addr}:${String(r.outputs)}:${String(r.value)}`);
}
async function aggregate(): Promise<string[]> {
  const rows = await store().all<{ addr: string; n: unknown; v: unknown }>(
    `SELECT o.addr AS addr, COUNT(*) AS n, SUM(o.value) AS v ${COINBASE_OUTPUTS} GROUP BY o.addr ORDER BY o.addr`);
  return rows.map((r) => `${r.addr}:${String(r.n)}:${String(r.v)}`);
}

// Returns how many steps compared a non-empty table, so a walk that never builds state cannot pass vacuously.
async function walk(seed: number, steps: number): Promise<number> {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  let tip = -1, nextId = 1, nonce = 0;
  const coinbases: { txid: string; outputs: any[] }[] = [];
  const outs = (k: number): any[] => Array.from({ length: k }, () => ({
    script_pubkey: r() < 0.1 ? "ff" : pick(ADDRS),          // "ff" decodes to no address
    value: 1 + Math.floor(r() * 5_000_000_000),
  }));
  const block = (height: number): any => {
    let cb = { txid: hex32(nextId++), version: 1, locktime: 0, inputs: [] as unknown[], outputs: outs(1 + Math.floor(r() * 3)) };
    if (coinbases.length && r() < 0.15) {                   // replay an earlier coinbase, maybe with fewer outputs
      const old = pick(coinbases);
      cb = { ...cb, txid: old.txid, outputs: r() < 0.5 ? old.outputs : old.outputs.slice(0, 1) };
    }
    coinbases.push({ txid: cb.txid, outputs: cb.outputs });
    const txs: unknown[] = [cb];
    for (let i = Math.floor(r() * 3); i > 0; i--) {
      const txid = coinbases.length && r() < 0.1 ? pick(coinbases).txid : hex32(nextId++);
      txs.push({ txid, version: 1, locktime: 0, inputs: [{ prev_txid: pick(coinbases).txid, vout: 0 }], outputs: outs(1 + Math.floor(r() * 2)) });
    }
    if (r() < 0.05) txs.push(txs[0]);                       // a txid repeated within the block
    return { hash: hex32(1_000_000 + nonce++), height, chainwork: String(height + 1), header: { prev: null, merkle: null, time: 1700000000 + height, bits: 0x1e00ffff, nonce, version: 1 }, txs };
  };
  let compared = 0;
  for (let s = 0; s < steps; s++) {
    const x = r();
    let what: string;
    if (tip < 0 || x < 0.55) { tip++; await writeBlock(block(tip)); what = `write ${tip}`; }
    else if (x < 0.8) { const h = Math.floor(r() * (tip + 1)); await writeBlock(block(h)); what = `rewrite ${h}`; }
    else if (x < 0.95) { const a = Math.max(-1, tip - 1 - Math.floor(r() * 4)); await unwindAbove(a); tip = a; what = `unwind to ${a}`; }
    else { const a = Math.floor(r() * (tip + 1)) - 1; await unwindAbove(a); tip = a; what = `deep unwind to ${a}`; }
    const got = await totals();
    assert.deepEqual(got, await aggregate(), `seed ${seed} step ${s} (${what}): coinbase_totals differs from the aggregate`);
    if (got.length > 0) compared++;
  }
  return compared;
}

test("coinbase_totals equals the coinbase-output aggregate after every write, re-write and unwind", async () => {
  for (const seed of [1, 2, 3, 4]) {
    await resetStoreForTests();
    const compared = await walk(seed, 150);
    assert.ok(compared >= 100, `seed ${seed}: only ${compared} of 150 steps compared a non-empty table`);
  }
});

// A coinbase replayed with fewer outputs moves its tx row and vout 0 to the new height and leaves vout 1 at the
// old one; that vout then leaves the aggregate when the tx row is deleted, by an unwind between the two heights
// or by a re-write of the new height. The random walk rarely lines these up, so each is driven here.
test("a replayed coinbase split across two heights stays equal through an unwind and a re-write", async () => {
  const [A, B] = [ADDRS[0]!, ADDRS[1]!];
  const blk = (h: number, txs: unknown[]): any => ({ hash: hex32(700 + h), height: h, chainwork: String(h + 1), header: { prev: null, time: 1700000000 + h, bits: 1, nonce: 0, version: 1 }, txs });
  const twoOut = { txid: hex32(42), inputs: [], outputs: [{ script_pubkey: A, value: 10 }, { script_pubkey: B, value: 20 }] };
  const oneOut = { ...twoOut, outputs: [twoOut.outputs[0]] };
  const other = (id: number) => ({ txid: hex32(id), inputs: [], outputs: [{ script_pubkey: A, value: 1 }] });
  for (const end of ["unwind", "rewrite"] as const) {
    await resetStoreForTests();
    await writeBlock(blk(0, [other(1)]));
    await writeBlock(blk(1, [twoOut]));
    await writeBlock(blk(2, [other(2)]));
    await writeBlock(blk(3, [oneOut]));
    assert.deepEqual(await totals(), await aggregate(), "after the replay");
    if (end === "unwind") await unwindAbove(2); else await writeBlock(blk(3, [other(3)]));
    assert.deepEqual(await totals(), await aggregate(), `after the ${end}`);
    assert.deepEqual(await totals(), [`0x${A}:${end === "unwind" ? 2 : 3}:${end === "unwind" ? 2 : 3}`], `${end}: B's vout 1 lost its tx row`);
  }
});

// A writer without the maintenance (an older version after a rollback, or rows written by hand) leaves
// coinbase_totals wrong; the next boot rebuilds it from outputs JOIN txs.
test("a boot rebuilds coinbase_totals left wrong by a writer without maintenance", async () => {
  await resetStoreForTests();
  await walk(9, 60);
  const [A, C] = [ADDRS[0]!, ADDRS[2]!];
  await store().tx(async (d) => {
    await d.run("INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES(?,?,?,?,?,?,?,?,?,?)", hex32(9_000_001), 9999, 0, "Coinbase", null, 0, 0, 0, 1, 1);
    await d.run("INSERT INTO outputs(txid,vout,addr,value,height) VALUES(?,?,?,?,?)", hex32(9_000_001), 0, `0x${C}`, 123, 9999);
    await d.run("UPDATE coinbase_totals SET outputs = outputs + 5 WHERE addr = ?", `0x${A}`);
  });
  const want = await aggregate();
  assert.notDeepEqual(await totals(), want, "the table is wrong before the boot");
  await closeDb();
  assert.deepEqual(await totals(), want, "the boot rebuilt coinbase_totals from outputs JOIN txs");
});

// Another process may boot (and rebuild) while this one writes, or two may boot at once. Each case below runs
// the other process's transaction on a second connection, holds it open while this process acts, then commits.
test("Postgres: writers and boot rebuilds serialize on the coinbase_totals lock", { skip: SQLITE && "the lock is Postgres-only; SQLite is covered below" }, async () => {
  await resetStoreForTests();
  const A = ADDRS[0]!;
  const blk = (h: number, id: number): any => ({ hash: hex32(800_000 + h), height: h, chainwork: String(h + 1),
    header: { prev: null, merkle: null, time: 1700000000 + h, bits: 1, nonce: 0, version: 1 },
    txs: [{ txid: hex32(810_000 + id), inputs: [], outputs: [{ script_pubkey: A, value: 9 }, { script_pubkey: ADDRS[1]!, value: 4 }] }] });
  await writeBlock(blk(0, 0));
  const { Client } = await import("pg");
  const other = new Client({ connectionString: process.env.CSD_INDEX_PG });
  await other.connect();
  try {
    await other.query("SET search_path TO t_coinbase_totals");
    const interleave = async (theirs: string[], ours: () => Promise<unknown>, readersRun = true) => {
      await other.query("BEGIN");
      for (const q of theirs) await other.query(q);
      const p = ours();
      if (readersRun) {
        const read = await Promise.race([store().get("SELECT COUNT(*) AS n FROM coinbase_totals").then(() => "answered"),
          new Promise((r) => setTimeout(() => r("blocked"), 250))]);
        assert.equal(read, "answered", "a reader is not blocked by the lock");
      }
      await new Promise((r) => setTimeout(r, 300));
      await other.query("COMMIT");
      await p;
    };
    // A's total wrong, as a writer without maintenance leaves it, so a stale read of it shows in the result
    const corrupt = () => store().run("UPDATE coinbase_totals SET outputs = outputs + 5 WHERE addr = ?", `0x${A}`);
    // another process's boot rebuild in flight: our writer must read A's total after it commits, not before
    await corrupt();
    await interleave(coinbaseTotalsRebuildSql("postgres"), () => writeBlock(blk(1, 1)));
    assert.deepEqual(await totals(), await aggregate(), "writeBlock during another process's rebuild");
    await corrupt();
    await interleave(coinbaseTotalsRebuildSql("postgres"), () => unwindAbove(0));
    assert.deepEqual(await totals(), await aggregate(), "unwindAbove during another process's rebuild");
    // another boot's rebuild that has deleted and re-inserted but not committed: ours must wait for it, not collide
    await closeDb();
    await interleave(coinbaseTotalsRebuildSql("postgres").filter((q) => !q.startsWith("LOCK")), () => store().get("SELECT 1"), false);
    assert.deepEqual(await totals(), await aggregate(), "two boots rebuilding at once");
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    await other.end();
  }
});

test("SQLite: a writer whose snapshot the boot rebuild outdated fails instead of writing stale totals", { skip: !SQLITE && "SQLite-only; Postgres is covered above" }, async () => {
  await resetStoreForTests();
  await walk(5, 20);
  const { DatabaseSync } = await import("node:sqlite");
  const writer = new DatabaseSync(process.env.CSD_INDEX_DB!);
  writer.exec("PRAGMA busy_timeout = 100");
  writer.exec("BEGIN");
  writer.prepare("SELECT addr, outputs FROM coinbase_totals").all();        // the writer's read: its snapshot starts here
  await closeDb();
  await store().get("SELECT 1");                                              // another process boots and rebuilds
  assert.throws(() => writer.exec(`INSERT INTO coinbase_totals(addr, outputs, value) VALUES('0x${ADDRS[4]}', 1, 1)`), /busy|locked/i);
  writer.exec("ROLLBACK");
  writer.close();
  assert.deepEqual(await totals(), await aggregate());
});

test("HAPPY PATH: an honest chain's totals are the per-address coinbase sums", async () => {
  await resetStoreForTests();
  const [A, B] = [ADDRS[0]!, ADDRS[1]!];
  const cb = (id: number, o: { to: string; v: number }[]) => ({ txid: hex32(id), inputs: [], outputs: o.map((x) => ({ script_pubkey: x.to, value: x.v })) });
  const blk = (h: number, txs: unknown[]): any => ({ hash: hex32(500 + h), height: h, chainwork: String(h + 1), header: { prev: null, time: 1700000000 + h, bits: 1, nonce: 0, version: 1 }, txs });
  await writeBlock(blk(0, [cb(1, [{ to: A, v: 100 }])]));
  await writeBlock(blk(1, [cb(2, [{ to: A, v: 50 }, { to: B, v: 7 }]),
    { txid: hex32(3), inputs: [{ prev_txid: hex32(1), vout: 0 }], outputs: [{ script_pubkey: B, value: 90 }] }]));
  assert.deepEqual(await totals(), [`0x${A}:2:150`, `0x${B}:1:7`], "B's 90 is a payment, not a coinbase output");
  await unwindAbove(0);
  assert.deepEqual(await totals(), [`0x${A}:1:100`], "B's row leaves with its only coinbase output");
});

// The maintenance runs once per tx on the write path and once per unwind; a table scan there would make a
// from-genesis replay quadratic (the N20 class), so each statement must seek an index.
test("every coinbase-totals maintenance read is driven by the index that bounds it", { skip: !SQLITE && "EXPLAIN QUERY PLAN is sqlite-only" }, async () => {
  const driver: Record<keyof typeof COINBASE_WHERE, RegExp> = {
    height: /^SEARCH o USING INDEX idx_out_height \(height=\?\)/,
    txAtHeight: /^SEARCH t USING INDEX idx_txs_height \(height=\?\)/,
    txid: /^SEARCH (t|o) USING INDEX sqlite_autoindex_(txs|outputs)_1 \(txid=\?\)/,
    above: /^SEARCH o USING INDEX idx_out_height \(height>\?\)/,
    txAbove: /^SEARCH t USING INDEX idx_txs_height \(height>\?\)/,
  };
  for (const [name, where] of Object.entries(COINBASE_WHERE) as [keyof typeof COINBASE_WHERE, string][]) {
    const n = (where.match(/\?/g) ?? []).length;
    const rows = await store().all<{ detail: string }>(`EXPLAIN QUERY PLAN ${coinbaseRowsSql(where)}`, ...Array(n).fill(5));
    const plan = rows.map((x) => x.detail).join(" | ");
    assert.match(plan, driver[name], `${name}: wrong driving index, plan was: ${plan}`);
    assert.ok(!/\bSCAN (o|t|c)\b/.test(plan), `${name}: table scan, plan was: ${plan}`);
  }
});
