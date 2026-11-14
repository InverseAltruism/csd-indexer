// address_totals is a second home for what /address/:a serves (db.ts addressTotalsSql), so it must equal that
// aggregate after every write the indexer can make, and the route must answer what 0.3.8's scan answered, byte for
// byte. Seeded walks of block writes with spends, repeated txids, same-height and buried re-writes and unwinds
// compare both after every step; a chain with a reorg runs through syncOnce against a mock node.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";
import { type Blk, block, coinbase, id, mockNode, repeatChain, spend } from "./_repeat-chain.js";

let CHAIN: Blk[] = [];
const node = await mockNode(() => CHAIN);
process.env.CSD_RPC = node.url;
process.env.CSD_INDEX_DB = tmpDb("addrtotals");
process.env.CSD_INDEX_PG_SCHEMA = "t_address_totals";
process.env.CSD_INDEX_FROM = "0";

const { writeBlock, unwindAbove, syncOnce, indexedHeight, ADDRESS_AT } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb, addressTotalsSql, ADDRESS_TOTALS_ALL, totalsRebuildSql } = await import("../src/db.js");
const { amt } = await import("../src/queries.js");
const { buildApp } = await import("../src/server.js");
await resetStoreForTests();

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
test.after(async () => { srv.close(); node.close(); await closeDb(); });

const SQLITE = store().backend === "sqlite";
const ADDRS = ["a1", "b2", "c3", "d4", "e5"].map((b) => b.repeat(20));
const UNKNOWN = "0x" + "f6".repeat(20);
const hex32 = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const str = (rows: Record<string, unknown>[]) => rows.map((r) => Object.values(r).map(String).join(":"));

async function totals(): Promise<string[]> {
  return str(await store().all("SELECT addr, outputs, unspent, funded_hi, funded_lo, spent_hi, spent_lo, txs FROM address_totals ORDER BY addr"));
}
async function aggregate(): Promise<string[]> {
  return str(await store().all(`${addressTotalsSql(ADDRESS_TOTALS_ALL, true)} ORDER BY addr`));
}
// /address/:a as 0.3.8 computed it (csd-indexer 0bc983d src/queries.ts addressStats, and src/server.ts), the oracle.
async function oracle(addr: string): Promise<string> {
  const a = addr.toLowerCase();
  const o = await store().get<{ funded: number | bigint; spent: number | bigint; unspent: number | bigint }>(
    "SELECT COALESCE(SUM(value),0) funded, COALESCE(SUM(CASE WHEN spent_txid IS NOT NULL THEN value ELSE 0 END),0) spent, " +
    "COUNT(*) - COUNT(spent_txid) unspent FROM outputs WHERE addr=?", a);
  const txc = (await store().get<{ n: number }>("SELECT COUNT(DISTINCT txid) n FROM address_history WHERE addr=?", a))?.n ?? 0;
  const funded = o?.funded ?? 0, spent = o?.spent ?? 0;
  const stats = { funded: amt(funded), spent: amt(spent), balance: amt(BigInt(funded) - BigInt(spent)), tx_count: Number(txc), utxo_count: Number(o?.unspent ?? 0) };
  return JSON.stringify({ address: a, chain_stats: stats });
}
const route = async (addr: string) => { const r = await fetch(`${base}/address/${addr}`); assert.equal(r.status, 200); return r.text(); };
/** Every address the rows name, plus one they do not. */
async function everyAddress(): Promise<string[]> {
  const rows = await store().all<{ addr: string }>("SELECT addr FROM outputs WHERE addr IS NOT NULL UNION SELECT addr FROM address_history");
  return [...new Set([...rows.map((r) => r.addr), UNKNOWN])];
}
async function assertRouteIsOracle(what: string): Promise<number> {
  const addrs = await everyAddress();
  for (const a of addrs) assert.equal(await route(a), await oracle(a), `${what}: /address/${a} differs from 0.3.8's answer`);
  return addrs.length;
}

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

type WalkCounts = { compared: number; repeats: number; spent: number; unwinds: number };
async function walk(seed: number, steps: number): Promise<WalkCounts> {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  let tip = -1, nextId = 1, nonce = 0;
  const made: { txid: string; inputs: unknown[]; outputs: any[] }[] = [];
  const outs = (k: number): any[] => {
    const to = pick(ADDRS), value = 1 + Math.floor(r() * 5_000_000_000);
    return Array.from({ length: k }, () => r() < 0.3 ? { script_pubkey: to, value } : {   // same address and value twice in one tx
      script_pubkey: r() < 0.1 ? "ff" : pick(ADDRS),                                    // "ff" decodes to no address
      value: r() < 0.03 ? 2 ** 52 + Math.floor(r() * 2 ** 52) : 1 + Math.floor(r() * 5_000_000_000),
    });
  };
  const inputs = (): unknown[] => Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
    const of = made.length ? pick(made) : null;   // spent before or not, orphaned or not, or unknown
    return r() < 0.1 || !of ? { prev_txid: hex32(9_000_000 + nextId++), vout: 0 } : { prev_txid: of.txid, vout: Math.floor(r() * of.outputs.length) };
  });
  const blk = (height: number): any => {
    const txs: any[] = [r() < 0.15 && made.length ? pick(made) : { txid: hex32(nextId++), inputs: [], outputs: outs(1 + Math.floor(r() * 2)) }];
    for (let i = Math.floor(r() * 4); i > 0; i--) {
      txs.push(r() < 0.12 && made.length ? pick(made) : { txid: hex32(nextId++), inputs: inputs(), outputs: outs(1 + Math.floor(r() * 3)) });
    }
    if (r() < 0.05) txs.push(txs[txs.length - 1]);   // a txid repeated within the block
    for (const t of txs) made.push(t);
    return { hash: hex32(1_000_000 + nonce++), height, chainwork: String(height + 1), header: { prev: null, merkle: null, time: 1700000000 + height, bits: 1, nonce, version: 1 }, txs };
  };
  const n: WalkCounts = { compared: 0, repeats: 0, spent: 0, unwinds: 0 };
  for (let s = 0; s < steps; s++) {
    const x = r();
    let what: string;
    if (tip < 0 || x < 0.55) { tip++; await writeBlock(blk(tip)); what = `write ${tip}`; }
    else if (x < 0.7) { await writeBlock(blk(tip)); what = `tip ${tip} written again`; }
    else if (x < 0.8) { const h = Math.floor(r() * (tip + 1)); await writeBlock(blk(h)); what = `buried re-write ${h}`; }
    else if (x < 0.95) { const a = Math.max(-1, tip - 1 - Math.floor(r() * 4)); await unwindAbove(a); tip = a; what = `unwind to ${a}`; n.unwinds++; }
    else { const a = Math.floor(r() * (tip + 1)) - 1; await unwindAbove(a); tip = a; what = `deep unwind to ${a}`; n.unwinds++; }
    const got = await totals();
    assert.deepEqual(got, await aggregate(), `seed ${seed} step ${s} (${what}): address_totals differs from the aggregate`);
    if (s % 5 === 4 || s === steps - 1) await assertRouteIsOracle(`seed ${seed} step ${s} (${what})`);
    if (got.length > 0) n.compared++;
    if (await store().get("SELECT 1 FROM tx_repeats LIMIT 1")) n.repeats++;
    if (await store().get("SELECT 1 FROM outputs WHERE spent_txid IS NOT NULL LIMIT 1")) n.spent++;
  }
  return n;
}

test("address_totals equals the aggregate, and /address/:a 0.3.8's answer, after every write, re-write and unwind", async () => {
  for (const seed of [1, 2, 3, 4]) {
    await resetStoreForTests();
    const n = await walk(seed, 150);
    // so a walk that never builds the telling state cannot pass vacuously
    assert.ok(n.compared >= 100 && n.repeats >= 50 && n.spent >= 50 && n.unwinds >= 20, `seed ${seed}: ${JSON.stringify(n)}`);
  }
});

// The production call shape: syncOnce against a node through a reorg, on a chain where a coinbase, a Propose and an
// Attest are each held twice and an output is spent again after its first spender (test/_repeat-chain.ts).
test("HAPPY PATH: through syncOnce, a reorg and repeated txids, the table is the aggregate and the route 0.3.8's answer", async () => {
  await resetStoreForTests();
  const { main, C1, A } = repeatChain();
  CHAIN = main;
  await syncOnce();
  assert.equal(await indexedHeight(), 6);
  assert.deepEqual(await totals(), await aggregate(), "the repeat chain");
  assert.ok(await assertRouteIsOracle("the repeat chain") >= 3);
  // heavier branch from height 3: C1 and A held again at 4, A's output spent by another tx, a fresh payee
  const PAYEE2 = "0x" + "d4".repeat(20);
  const T = { ...spend("t", A, 40), outputs: [{ script_pubkey: PAYEE2, value: 40 }] };
  const b4 = block(main[3]!, "r4", [C1, A, T], 5000);
  const b5 = block(b4, "r5", [coinbase("r5"), spend("u", T, 39)], 5000);
  CHAIN = [...main.slice(0, 4), b4, b5];
  await syncOnce();
  assert.equal(await indexedHeight(), 5);
  assert.ok(await store().get("SELECT 1 FROM tx_repeats WHERE height = 4"), "the branch holds repeats");
  assert.deepEqual(await totals(), await aggregate(), "after the reorg");
  assert.ok(await assertRouteIsOracle("after the reorg") >= 4);
  const payee2 = JSON.parse(await route(PAYEE2));
  assert.deepEqual(payee2.chain_stats, { funded: 40, spent: 40, balance: 0, tx_count: 2, utxo_count: 0 }, "the new payee's figures");
  CHAIN = [...main.slice(0, 3), block(main[2]!, "s3", [coinbase("s3")], 50_000)];   // a heavier branch from height 2
  await syncOnce();
  assert.equal(await indexedHeight(), 3);
  assert.deepEqual(await totals(), await aggregate(), "after the second reorg");
  await assertRouteIsOracle("after the second reorg");
  assert.equal(JSON.parse(await route(PAYEE2)).chain_stats.tx_count, 0, "the orphaned payee has no row left");
  assert.equal((await store().all("SELECT addr FROM address_totals WHERE addr = ?", PAYEE2)).length, 0);
});

// Sums held as two columns: an address paid twice the column maximum answers the exact figure (0.3.8 answered it
// on Postgres, where SUM yields numeric, and failed on SQLite, whose SUM refuses to overflow), and a boot rebuilds it.
test("funded and spent past 2^63 stay exact through writes, an unwind and a boot", async () => {
  await resetStoreForTests();
  const MAX = (1n << 63n) - 1n, [A, B] = [ADDRS[4]!, ADDRS[1]!];
  const fund = { txid: id("max-fund"), inputs: [], outputs: [{ script_pubkey: A, value: MAX.toString() }, { script_pubkey: A, value: MAX.toString() }] };
  const pay = { txid: id("max-pay"), inputs: [{ prev_txid: fund.txid, vout: 1 }], outputs: [{ script_pubkey: B, value: "5" }] };
  const blk = (h: number, txs: unknown[]): any => ({ hash: hex32(600 + h), height: h, chainwork: String(h + 1), header: { prev: null, time: 1700000000 + h, bits: 1, nonce: 0, version: 1 }, txs });
  await writeBlock(blk(0, [coinbase("max"), fund]));   // fund at position 1: its outputs are no coinbase outputs
  await writeBlock(blk(1, [pay]));
  const want = { funded: (2n * MAX).toString(), spent: MAX.toString(), balance: MAX.toString(), tx_count: 2, utxo_count: 1 };
  assert.deepEqual(JSON.parse(await route(`0x${A}`)).chain_stats, want);
  if (!SQLITE) assert.equal(await route(`0x${A}`), await oracle(`0x${A}`), "Postgres: 0.3.8's numeric sum, byte for byte");
  await closeDb();
  assert.deepEqual(JSON.parse(await route(`0x${A}`)).chain_stats, want, "after the boot rebuild");
  assert.deepEqual(await totals(), await aggregate());
  await unwindAbove(0);
  assert.deepEqual(JSON.parse(await route(`0x${A}`)).chain_stats, { ...want, spent: 0, balance: want.funded, tx_count: 1, utxo_count: 2 });
});

// A writer without the maintenance (an older version after a rollback, or rows written by hand) leaves the table
// wrong; the next boot rebuilds it from the rows.
test("a boot rebuilds address_totals left wrong by a writer without maintenance", async () => {
  await resetStoreForTests();
  await walk(9, 40);
  await store().tx(async (d) => {
    await d.run("INSERT INTO outputs(txid,vout,addr,value,height) VALUES(?,?,?,?,?)", hex32(9_500_001), 0, UNKNOWN, 123, 9999);
    await d.run("UPDATE address_totals SET txs = txs + 5 WHERE addr = ?", `0x${ADDRS[0]}`);
  });
  const want = await aggregate();
  assert.notDeepEqual(await totals(), want, "the table is wrong before the boot");
  await closeDb();
  assert.deepEqual(await totals(), want, "the boot rebuilt address_totals from the rows");
  await assertRouteIsOracle("after the boot");
});

// Another process may boot (and rebuild) while this one writes; its rebuild holds the lock until it commits.
test("Postgres: a writer waits for another process's rebuild of address_totals", { skip: SQLITE && "the lock is Postgres-only; SQLite's IMMEDIATE transactions are covered in test/coinbase-totals.test.ts" }, async () => {
  await resetStoreForTests();
  const A = ADDRS[0]!;
  const blk = (h: number, id: number): any => ({ hash: hex32(800_000 + h), height: h, chainwork: String(h + 1),
    header: { prev: null, merkle: null, time: 1700000000 + h, bits: 1, nonce: 0, version: 1 },
    txs: [{ txid: hex32(810_000 + id), inputs: h ? [{ prev_txid: hex32(810_000), vout: 0 }] : [], outputs: [{ script_pubkey: A, value: 9 }] }] });
  await writeBlock(blk(0, 0));
  const { Client } = await import("pg");
  const other = new Client({ connectionString: process.env.CSD_INDEX_PG });
  await other.connect();
  try {
    await other.query("SET search_path TO t_address_totals");
    for (const [what, ours] of [["writeBlock", () => writeBlock(blk(1, 1))], ["unwindAbove", () => unwindAbove(0)]] as const) {
      await store().run("UPDATE address_totals SET txs = txs + 5 WHERE addr = ?", `0x${A}`);   // a stale read of it would show
      await other.query("BEGIN");
      for (const q of totalsRebuildSql("postgres")) await other.query(q);
      const p = ours();
      await new Promise((r) => setTimeout(r, 300));
      await other.query("COMMIT");
      await p;
      assert.deepEqual(await totals(), await aggregate(), `${what} during another process's rebuild`);
    }
  } finally {
    await other.query("ROLLBACK").catch(() => undefined);
    await other.end();
  }
});

// The maintenance runs twice per block and once per unwind; a scan there would make a replay quadratic, so each
// arm must seek the index that bounds it.
test("every address-totals maintenance read is driven by an index on height", { skip: !SQLITE && "EXPLAIN QUERY PLAN is sqlite-only" }, async () => {
  for (const [name, w] of Object.entries(ADDRESS_AT)) {
    const sql = addressTotalsSql(w, false);
    const plan = (await store().all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, 5, 5, 5, 5)).map((x) => x.detail).join(" | ");
    assert.ok(!/\bSCAN (outputs|address_history)\b/.test(plan), `${name}: table scan, plan was: ${plan}`);
    assert.match(plan, /SEARCH outputs USING INDEX idx_out_height/, `${name}: plan was: ${plan}`);
    assert.match(plan, /SEARCH outputs USING INDEX idx_out_spent_height/, `${name}: plan was: ${plan}`);
    assert.match(plan, /SEARCH address_history USING INDEX idx_addrhist_height/, `${name}: plan was: ${plan}`);
  }
});

// /address/:a summed every output of the address on each call. Now its statements read one row: on SQLite
// the plan is one primary-key search of address_totals; on Postgres the buffers an executed plan touches are the same
// for an address of 50,000 outputs as for an address of one.
test("/address/:a does not scan: an address of 50,000 outputs costs what an address of one costs", async () => {
  await resetStoreForTests();
  const FLOOD = `0x${ADDRS[2]}`, SMALL = `0x${ADDRS[3]}`, N = 50_000;
  await store().tx(async (d) => {
    // one block of N outputs to FLOOD, every tenth spent, written as rows (a block of that size through writeBlock
    // takes minutes on Postgres); the boot below rebuilds the table from them
    await d.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${N})
      INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height)
      SELECT ? , i, ?, 1000 + i, 1, CASE WHEN i % 10 = 0 THEN ? END, CASE WHEN i % 10 = 0 THEN 2 END FROM n`, hex32(1), FLOOD, hex32(2));
    await d.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${N})
      INSERT INTO address_history(addr,txid,height,pos,direction,delta) SELECT ?, ?, 1, i, 'in', 1000 + i FROM n`, FLOOD, hex32(1));
    await d.run("INSERT INTO outputs(txid,vout,addr,value,height) VALUES(?,?,?,?,?)", hex32(3), 0, SMALL, 7, 1);
    await d.run("INSERT INTO address_history(addr,txid,height,pos,direction,delta) VALUES(?,?,?,?,?,?)", SMALL, hex32(3), 1, 0, "in", 7);
  });
  await closeDb();
  if (!SQLITE) await store().run("ANALYZE");

  // the statements the route runs, as it runs them
  const seen: { sql: string; params: unknown[] }[] = [];
  const s = store() as unknown as Record<"get" | "all", (sql: string, ...p: unknown[]) => Promise<unknown>>;
  const orig = { get: s.get.bind(store()), all: s.all.bind(store()) };
  for (const m of ["get", "all"] as const) s[m] = async (sql, ...p) => { seen.push({ sql, params: p }); return orig[m](sql, ...p); };
  let flood: string;
  try { flood = await route(FLOOD); } finally { s.get = orig.get; s.all = orig.all; }
  assert.equal(flood, await oracle(FLOOD), "HAPPY PATH: the flooded address's figures are 0.3.8's");
  assert.equal(JSON.parse(flood).chain_stats.utxo_count, N - N / 10);
  assert.ok(seen.length >= 1);

  for (const { sql, params } of seen) {
    const at = (a: string) => params.map((p) => (p === FLOOD ? a : p));
    if (SQLITE) {
      const plan = (await store().all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map((x) => x.detail);
      assert.deepEqual(plan.filter((l) => !/^SEARCH address_totals USING INDEX sqlite_autoindex_address_totals_1 \(addr=\?\)$/.test(l)), [],
        `the route reads more than one address_totals row: ${sql} -> ${plan.join(" | ")}`);
    } else {
      const cost = async (a: string) => {
        const [row] = await store().all<{ "QUERY PLAN": any }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ...at(a));
        const top = row!["QUERY PLAN"][0].Plan;
        const rels = new Set<string>();
        const walkPlan = (p: any) => { if (p["Relation Name"]) rels.add(p["Relation Name"]); for (const c of p.Plans ?? []) walkPlan(c); };
        walkPlan(top);
        return { buffers: top["Shared Hit Blocks"] + top["Shared Read Blocks"], rels: [...rels].sort() };
      };
      const [big, small] = [await cost(FLOOD), await cost(SMALL)];
      assert.equal(big.buffers, small.buffers, `buffers for 50,000 outputs ${big.buffers}, for one ${small.buffers}: ${sql}`);
      assert.deepEqual(big.rels, ["address_totals"], `the route reads ${big.rels.join(", ")}: ${sql}`);
    }
  }
});
