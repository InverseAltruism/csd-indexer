// _backend-bench.mjs — comparative sqlite-vs-postgres benchmark on the REAL provisioned setup.
//
// Answers, with numbers, the four cutover questions:
//   1. READ: point-read + aggregate latency on the real chain data, both backends.
//      (Expect sqlite to WIN raw point-reads: it is a sync in-process call vs a socket round
//      trip. That is not the decision metric — see 3.)
//   2. WRITE: per-block transaction cost on a scratch store (same shape as writeBlock: block +
//      txs + outputs + address_history in ONE tx). Compare against the 120s block target to
//      answer "will it fall behind the tip".
//   3. EVENT-LOOP STALL: how long the serving process is FROZEN while a heavy aggregate runs.
//      This is the architectural reason pg exists (db.ts:6-10): sync sqlite executes ON the
//      event loop (a scan freezes every HTTP response + the indexer), pg awaits off-process.
//   4. READ-UNDER-WRITE: read latency while a write burst runs — the "explorer stays snappy
//      while blocks land" property.
//
// SAFETY: reads touch only the real tables read-only; ALL writes go to a scratch sqlite file
// and a scratch pg schema (bench_tmp_<pid>), both dropped at the end. Run as the DB service user (peer auth).
//
// USAGE: node test/_backend-bench.mjs --sqlite /var/lib/csd-indexer/csd-index.db \
//          --pg "postgresql://<db-user>@/csd_index?host=/var/run/postgresql"
//        npx tsx test/_backend-bench.mjs --feeds [--db <scratch file>] [--scale 100] \
//          [--limits 1000] [--cx-proposals N --cx-attestations N --other-proposals N --other-attestations N]
//        --feeds runs only section F (feedBench below) on a scratch SQLite file: no live data, no --pg.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const SQLITE = opt("sqlite", process.env.CSD_INDEX_DB ?? "/var/lib/csd-indexer/csd-index.db");
const PG_DSN = opt("pg", process.env.CSD_INDEX_PG ?? "");
const PG_SCHEMA = opt("pg-schema", "public");
const now = () => performance.now();
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
};
const fmt = (r) => `p50=${r.p50.toFixed(2)}ms p95=${r.p95.toFixed(2)}ms max=${r.max.toFixed(2)}ms`;
if (args.includes("--feeds")) { await feedBench(); process.exit(0); }
if (!PG_DSN) { console.error("need --pg <dsn>"); process.exit(2); }
if (!/^[A-Za-z0-9_]+$/.test(PG_SCHEMA)) { console.error("bad --pg-schema"); process.exit(2); }

// ── connections (mirroring the real stores' key behaviors: WAL+busy_timeout+prepared reuse on
//    sqlite, pool max 10 + exact int8/numeric parsers on pg — see src/db.ts) ──
const sq = new DatabaseSync(SQLITE, { readOnly: true });
const sqStmts = new Map();
const sqPrep = (sql) => { let st = sqStmts.get(sql); if (!st) { st = sq.prepare(sql); st.setReadBigInts(true); sqStmts.set(sql, st); } return st; };
const sqAll = (sql, ...p) => sqPrep(sql).all(...p);
const sqGet = (sql, ...p) => sqPrep(sql).get(...p);

const require = createRequire(import.meta.url);
const pgmod = require("pg");
pgmod.types.setTypeParser(20, (s) => s);
pgmod.types.setTypeParser(1700, (s) => s);
const pool = new pgmod.Pool({ connectionString: PG_DSN, max: 10, statement_timeout: 30000 });
const pgAll = async (sql, params = []) => (await pool.query(sql, params)).rows;
const T = (t) => `${PG_SCHEMA}.${t}`;

// warm both sides + sample real keys
await pgAll(`SELECT 1`);
sqGet("SELECT 1 AS one");
const tip = Number((await pgAll(`SELECT MAX(height) h FROM ${T("blocks")} WHERE orphaned=0`))[0].h);
const txids = (await pgAll(`SELECT txid FROM ${T("txs")} ORDER BY random() LIMIT 200`)).map((r) => r.txid);
// (subquery: pg rejects SELECT DISTINCT with an ORDER BY expression not in the select list)
const addrs = (await pgAll(`SELECT addr FROM (SELECT DISTINCT addr FROM ${T("address_history")}) d ORDER BY random() LIMIT 50`)).map((r) => r.addr);
console.log(`backend-bench: real data (pg tip=${tip}, ${txids.length} sampled txids, ${addrs.length} addrs) — sqlite=${SQLITE}\n`);

// ── 1. READ latency on real data ──
async function bench(name, n, sqFn, pgFn) {
  const a = []; const b = [];
  for (let i = 0; i < n; i++) { const t0 = now(); sqFn(i); a.push(now() - t0); }
  for (let i = 0; i < n; i++) { const t0 = now(); await pgFn(i); b.push(now() - t0); }
  console.log(`  ${name.padEnd(30)} sqlite ${fmt(stats(a))}\n  ${"".padEnd(30)} pg     ${fmt(stats(b))}`);
}
console.log("── 1. reads on the real chain (lower = better; sqlite is expected to win point-reads) ──");
await bench("tip height", 200,
  () => sqGet("SELECT MAX(height) h FROM blocks WHERE orphaned=0"),
  () => pgAll(`SELECT MAX(height) h FROM ${T("blocks")} WHERE orphaned=0`));
await bench("block by height (random)", 200,
  (i) => sqGet("SELECT * FROM blocks WHERE height=?", Math.floor((i * 7919) % tip)),
  (i) => pgAll(`SELECT * FROM ${T("blocks")} WHERE height=$1`, [Math.floor((i * 7919) % tip)]));
await bench("tx by id (random)", 200,
  (i) => sqGet("SELECT * FROM txs WHERE txid=?", txids[i % txids.length]),
  (i) => pgAll(`SELECT * FROM ${T("txs")} WHERE txid=$1`, [txids[i % txids.length]]));
await bench("outputs of tx", 200,
  (i) => sqAll("SELECT * FROM outputs WHERE txid=? ORDER BY vout", txids[i % txids.length]),
  (i) => pgAll(`SELECT * FROM ${T("outputs")} WHERE txid=$1 ORDER BY vout`, [txids[i % txids.length]]));
await bench("address txids page (25)", 100,
  (i) => sqAll("SELECT DISTINCT txid, height FROM address_history WHERE addr=? ORDER BY height DESC, txid LIMIT 25", addrs[i % addrs.length]),
  (i) => pgAll(`SELECT DISTINCT txid, height FROM ${T("address_history")} WHERE addr=$1 ORDER BY height DESC, txid LIMIT 25`, [addrs[i % addrs.length]]));
await bench("health counts (4x COUNT(*))", 20,
  () => { sqGet("SELECT COUNT(*) n FROM blocks WHERE orphaned=0"); sqGet("SELECT COUNT(*) n FROM txs"); sqGet("SELECT COUNT(*) n FROM proposals"); sqGet("SELECT COUNT(*) n FROM attestations"); },
  async () => { await pgAll(`SELECT COUNT(*) n FROM ${T("blocks")} WHERE orphaned=0`); await pgAll(`SELECT COUNT(*) n FROM ${T("txs")}`); await pgAll(`SELECT COUNT(*) n FROM ${T("proposals")}`); await pgAll(`SELECT COUNT(*) n FROM ${T("attestations")}`); });
await bench("richlist aggregate (full scan)", 10,
  () => sqAll("SELECT addr, SUM(value) bal FROM outputs WHERE spent_txid IS NULL AND addr IS NOT NULL GROUP BY addr ORDER BY bal DESC LIMIT 100"),
  () => pgAll(`SELECT addr, SUM(value) bal FROM ${T("outputs")} WHERE spent_txid IS NULL AND addr IS NOT NULL GROUP BY addr ORDER BY bal DESC LIMIT 100`));
await bench("emitted supply (outputs join)", 10,
  () => sqGet("SELECT SUM(o.value) s FROM outputs o JOIN txs t ON t.txid=o.txid WHERE t.coinbase=1"),
  () => pgAll(`SELECT SUM(o.value) s FROM ${T("outputs")} o JOIN ${T("txs")} t ON t.txid=o.txid WHERE t.coinbase=1`));

// ── 2. WRITE path on scratch stores (block+tx+2 outputs+2 addr_history per tx, like writeBlock) ──
console.log("\n── 2. write path (per-block transaction; block target is 120,000ms) ──");
const DDL_TABLES = `
  CREATE TABLE IF NOT EXISTS blocks (height BIGINT PRIMARY KEY, hash TEXT NOT NULL, prev TEXT, merkle TEXT, time BIGINT, bits BIGINT, nonce BIGINT, version INTEGER, tx_count INTEGER, chainwork TEXT, orphaned INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS txs (txid TEXT PRIMARY KEY, height BIGINT NOT NULL, pos INTEGER NOT NULL, app_type TEXT, signer TEXT, fee BIGINT, time BIGINT, n_in INTEGER, n_out INTEGER, coinbase INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS outputs (txid TEXT NOT NULL, vout INTEGER NOT NULL, addr TEXT, value BIGINT, height BIGINT NOT NULL, spent_txid TEXT, spent_height BIGINT, PRIMARY KEY (txid, vout));
  CREATE TABLE IF NOT EXISTS address_history (addr TEXT NOT NULL, txid TEXT NOT NULL, height BIGINT NOT NULL, pos INTEGER, direction TEXT, delta BIGINT, PRIMARY KEY (addr, txid, direction, delta, pos));
`; // mirrored from src/db.ts DDL (bench-local: this script has no TS import path)
const id64 = (n, salt) => "0x" + (BigInt(n) * 2654435761n + BigInt(salt)).toString(16).padStart(64, "0").slice(-64);
const addr40 = (n) => "0x" + (BigInt(n) * 40503n % (2n ** 160n)).toString(16).padStart(40, "0").slice(-40);

const WSQL = `/tmp/csd-bench-${process.pid}.db`;
const wq = new DatabaseSync(WSQL);
wq.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
wq.exec(DDL_TABLES);
const BENCH_SCHEMA = `bench_tmp_${process.pid}`;
await pgAll(`CREATE SCHEMA IF NOT EXISTS ${BENCH_SCHEMA}`);
for (const stmt of DDL_TABLES.split(";").map((s) => s.trim()).filter(Boolean)) {
  await pgAll(stmt.replace(/\b(blocks|txs|outputs|address_history)\b/g, `${BENCH_SCHEMA}.$1`));
}
const N_BLOCKS = 500;
function writeBlockSqlite(h) {
  wq.exec("BEGIN");
  try {
    wq.prepare("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES (?,?,?,?,?,?,?,?,?,?,0)")
      .run(h, id64(h, 1), id64(h - 1, 1), id64(h, 2), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, 1, String(h));
    wq.prepare("INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES (?,?,?,?,?,?,?,?,?,1)")
      .run(id64(h, 3), h, 0, "Coinbase", addr40(h), 0, 1_700_000_000 + h * 120, 1, 2);
    for (let v = 0; v < 2; v++) {
      wq.prepare("INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES (?,?,?,?,?,NULL,NULL)").run(id64(h, 3), v, addr40(h + v), 2_500_000_000, h);
      wq.prepare("INSERT INTO address_history(addr,txid,height,pos,direction,delta) VALUES (?,?,?,?,'in',?)").run(addr40(h + v), id64(h, 3), h, v, 2_500_000_000);
    }
    wq.exec("COMMIT");
  } catch (e) { wq.exec("ROLLBACK"); throw e; }
}
async function writeBlockPg(h) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO ${BENCH_SCHEMA}.blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)`,
      [h, id64(h, 1), id64(h - 1, 1), id64(h, 2), 1_700_000_000 + h * 120, 0x1e00ffff, h, 1, 1, String(h)]);
    await c.query(`INSERT INTO ${BENCH_SCHEMA}.txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
      [id64(h, 3), h, 0, "Coinbase", addr40(h), 0, 1_700_000_000 + h * 120, 1, 2]);
    for (let v = 0; v < 2; v++) {
      await c.query(`INSERT INTO ${BENCH_SCHEMA}.outputs(txid,vout,addr,value,height,spent_txid,spent_height) VALUES ($1,$2,$3,$4,$5,NULL,NULL)`, [id64(h, 3), v, addr40(h + v), 2_500_000_000, h]);
      await c.query(`INSERT INTO ${BENCH_SCHEMA}.address_history(addr,txid,height,pos,direction,delta) VALUES ($1,$2,$3,$4,'in',$5)`, [addr40(h + v), id64(h, 3), h, v, 2_500_000_000]);
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
{
  const a = []; for (let h = 0; h < N_BLOCKS; h++) { const t0 = now(); writeBlockSqlite(h); a.push(now() - t0); }
  const b = []; for (let h = 0; h < N_BLOCKS; h++) { const t0 = now(); await writeBlockPg(h); b.push(now() - t0); }
  console.log(`  write 1 block (${N_BLOCKS}x)`.padEnd(32) + `sqlite ${fmt(stats(a))}`);
  console.log("".padEnd(32) + `pg     ${fmt(stats(b))}`);
  const worst = Math.max(stats(a).p95, stats(b).p95);
  console.log(`  verdict: worst p95 per block = ${worst.toFixed(2)}ms vs 120,000ms block target -> ~${Math.round(120000 / worst).toLocaleString()}x headroom`);
}

// ── 3. event-loop stall while a heavy aggregate runs (THE architectural difference) ──
console.log("\n── 3. event-loop stall during a heavy scan (how long ALL HTTP would freeze) ──");
async function loopStall(runQuery) {
  let maxGap = 0; let last = now();
  const t = setInterval(() => { const n2 = now(); maxGap = Math.max(maxGap, n2 - last - 5); last = n2; }, 5);
  for (let i = 0; i < 5; i++) { await runQuery(); await new Promise((r) => setTimeout(r, 10)); }
  clearInterval(t);
  return maxGap;
}
const heavySq = async () => sqAll("SELECT addr, SUM(value) bal, COUNT(*) c FROM outputs WHERE addr IS NOT NULL GROUP BY addr ORDER BY bal DESC");
const heavyPg = async () => pgAll(`SELECT addr, SUM(value) bal, COUNT(*) c FROM ${T("outputs")} WHERE addr IS NOT NULL GROUP BY addr ORDER BY bal DESC`);
console.log(`  sqlite: event loop frozen up to ${(await loopStall(heavySq)).toFixed(1)}ms per scan (scan runs ON the loop)`);
console.log(`  pg:     event loop frozen up to ${(await loopStall(heavyPg)).toFixed(1)}ms per scan (scan runs in the pg server)`);

// ── 4. reads while a write burst runs (scratch stores) ──
console.log("\n── 4. point-read latency DURING a 200-block write burst ──");
async function readUnderWrite(writeFn, readFn) {
  const lat = [];
  let writing = true;
  const reader = (async () => { while (writing) { const t0 = now(); await readFn(); lat.push(now() - t0); await new Promise((r) => setTimeout(r, 2)); } })();
  for (let h = N_BLOCKS; h < N_BLOCKS + 200; h++) await writeFn(h);
  writing = false; await reader;
  return stats(lat);
}
console.log(`  sqlite reads-under-write  ${fmt(await readUnderWrite(async (h) => writeBlockSqlite(h), async () => sqGet("SELECT * FROM txs WHERE txid=?", txids[0])))}`);
console.log(`  pg     reads-under-write  ${fmt(await readUnderWrite(writeBlockPg, () => pgAll(`SELECT * FROM ${T("txs")} WHERE txid=$1`, [txids[0]])))}`);

// ── cleanup ──
await pgAll(`DROP SCHEMA ${BENCH_SCHEMA} CASCADE`);
await pool.end();
sq.close(); wq.close();
for (const s of ["", "-wal", "-shm"]) { try { rmSync(WSQL + s); } catch { /* gone */ } }
console.log("\nbench done (scratch schema + file dropped). Decision guide: pg should show near-zero");
console.log("loop stall (section 3) and flat reads-under-write (section 4); sqlite should win raw");
console.log("point-reads (section 1). Both should clear the 120s block target by orders of magnitude.");

// ── F. chain-order feeds: full walks of /proposals and /attestations of one domain, format 1 and format 2 ──
// Loads `scale` times the given row counts (defaults: the live cairnx:v1 counts on 2026-11-18, and the rest of the
// live feeds as a second domain) into a scratch SQLite file whose schema src/db.ts creates, then walks each feed
// through the real app on a loopback port and prints EXPLAIN QUERY PLAN for the last page statement of each walk.
async function feedBench() {
  const scale = Number(opt("scale", "100"));
  const n = (k, d) => Number(opt(k, d)) * scale;
  const DOMAIN = "cairnx:v1", NOISE = "bench:other";
  const kinds = [["P", DOMAIN, n("cx-proposals", "1222")], ["A", DOMAIN, n("cx-attestations", "270")],
    ["P", NOISE, n("other-proposals", "1924")], ["A", NOISE, n("other-attestations", "261")]];
  const file = opt("db", `/tmp/csd-feed-bench-${process.pid}.db`);
  const drop = () => { for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true }); };
  drop();
  delete process.env.CSD_INDEX_PG;
  process.env.CSD_INDEX_DB = file;
  process.env.CSD_INDEX_FROM = "0";
  const { store, closeDb } = await import("../src/db.js");
  const { buildApp } = await import("../src/server.js");
  const s = store();

  // Records in chain order: each kind spread evenly over the chain, 30 per block after the coinbase.
  const recs = kinds.flatMap(([k, d, cnt], t) => Array.from({ length: cnt }, (_, j) => [(j + 0.5) / cnt, t, k, d]))
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const PER_BLOCK = 30;
  const hx = (v, w) => "0x" + BigInt(v).toString(16).padStart(w, "0");
  const addr = (v) => hx(v % 5000 + 1, 40);
  const val = (i) => (i % 1000 === 0 ? 2n ** 54n + BigInt(i) : BigInt(1000 + i)); // one value in 1000 past 2^53
  const t0 = now();
  const props = { [DOMAIN]: [], [NOISE]: [] };
  let outputs = 0;
  await s.tx(async (d) => {
    const blocks = Math.ceil(recs.length / PER_BLOCK);
    for (let h = 0; h < blocks; h++) {
      const time = 1_700_000_000 + h * 120;
      await d.run("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
        h, hx(0xb0000000n + BigInt(h), 64), null, null, time, 0x1e00ffff, 0, 1, 1 + PER_BLOCK, String(h + 1));
      const cb = hx(0xc0000000n + BigInt(h), 64);
      await d.run("INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES(?,?,?,?,?,?,?,?,?,1)", cb, h, 0, "Coinbase", addr(h), 0, time, 0, 1);
      await d.run("INSERT INTO outputs(txid,vout,addr,value,height) VALUES(?,?,?,?,?)", cb, 0, addr(h), 5_000_000_000, h);
      for (let pos = 1; pos <= PER_BLOCK; pos++) {
        const i = h * PER_BLOCK + pos - 1, r = recs[i];
        if (!r) break;
        const [, , k, dom] = r, txid = hx(i + 1, 64), who = addr(i);
        const outs = k === "P" ? [who, addr(i + 7)] : [addr(i + 3), addr(i + 11), who];
        await d.run("INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase) VALUES(?,?,?,?,?,?,?,?,?,0)",
          txid, h, pos, k === "P" ? "Propose" : "Attest", who, 1000, time, 1, outs.length);
        for (let v = 0; v < outs.length; v++) await d.run("INSERT INTO outputs(txid,vout,addr,value,height) VALUES(?,?,?,?,?)", txid, v, outs[v], val(i + v), h);
        outputs += outs.length;
        if (k === "P") {
          props[dom].push(txid);
          await d.run("INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time) VALUES(?,?,?,?,?,?,?,?,?)",
            txid, dom, hx(i, 64), `u${i}`, i % 997 === 0 ? 2n ** 53n : 9999, who, 1000, h, time);
        } else {
          const ps = props[dom];
          await d.run("INSERT INTO attestations(txid,proposal_id,attester,score,confidence,fee,height,time) VALUES(?,?,?,?,?,?,?,?)",
            txid, ps[(i * 7919) % ps.length], who, 100, 100, 1000, h, time);
        }
      }
    }
  });
  const count = async (t) => Number((await s.get(`SELECT COUNT(*) AS c FROM ${t}`)).c);
  console.log(`F. feeds bench: scale ${scale}, loaded in ${((now() - t0) / 1000).toFixed(1)}s: ${await count("blocks")} blocks, ${await count("txs")} txs, ` +
    `${await count("outputs")} outputs, ${await count("proposals")} proposals, ${await count("attestations")} attestations`);
  for (const [k, d, cnt] of kinds) console.log(`   ${k === "P" ? "proposals   " : "attestations"} ${d.padEnd(12)} ${cnt}`);

  // Every page statement the app runs, so its plan can be read with the same binds.
  let lastStmt = null;
  const all = s.all.bind(s);
  s.all = async (sql, ...p) => { if (/^SELECT s\.height AS at_height|^SELECT f\.\*/.test(sql)) lastStmt = { sql, p }; return await all(sql, ...p); };
  const srv = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const tip = await s.get("SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1");
  const at = `${tip.height}:${tip.hash}`;
  async function walk(kind, limit, format) {
    let after = null, rows = 0, outs = 0, bytes = 0;
    const pages = [], start = now();
    for (;;) {
      const p0 = now();
      const r = await fetch(`${url}/${kind}?domain=${encodeURIComponent(DOMAIN)}&at=${at}&limit=${limit}${format ? `&format=${format}` : ""}${after ? `&after=${after}` : ""}`);
      const body = await r.text();
      if (r.status !== 200) throw new Error(`${kind} answered ${r.status}: ${body.slice(0, 200)}`);
      pages.push(now() - p0);
      const j = JSON.parse(body);
      bytes += Buffer.byteLength(body);
      rows += j.rows.length;
      if (format === 2) for (const x of j.rows) outs += x.outputs.length;
      if (!j.next) break;
      after = j.next;
    }
    return { ms: now() - start, pages, rows, outs, bytes, deep: lastStmt };
  }
  console.log("\n   feed          limit format  walk ms (3 runs, median)  pages  rows    outputs  MB     page p50 / max ms");
  const plans = new Map();
  for (const kind of ["proposals", "attestations"]) {
    for (const limit of opt("limits", "1000").split(",").map(Number)) {
      for (const format of [null, 2]) {
        const runs = [];
        for (let i = 0; i < 3; i++) runs.push(await walk(kind, limit, format));
        runs.sort((a, b) => a.ms - b.ms);
        const m = runs[1], st = stats(m.pages);
        console.log(`   ${kind.padEnd(13)} ${String(limit).padStart(5)} ${String(format ?? "1 (absent)").padEnd(11)} ${m.ms.toFixed(0).padStart(8)}` +
          `${"".padEnd(17)} ${String(m.pages.length).padStart(5)}  ${String(m.rows).padStart(6)}  ${String(m.outs).padStart(7)}  ${(m.bytes / 1e6).toFixed(1).padStart(5)}  ` +
          `${st.p50.toFixed(1)} / ${st.max.toFixed(1)}`);
        if (!plans.has(`${kind} format ${format ?? 1}`)) plans.set(`${kind} format ${format ?? 1}`, m.deep);
      }
    }
  }
  console.log("\n   EXPLAIN QUERY PLAN of the last page statement of each walk at the first of --limits (the deepest cursor):");
  for (const [name, st] of plans) {
    console.log(`   ${name}:`);
    const rows = await all(`EXPLAIN QUERY PLAN ${st.sql}`, ...st.p);
    const depth = new Map([[0, 0]]);
    for (const r of rows) { depth.set(r.id, (depth.get(r.parent) ?? 0) + 1); console.log(`     ${"  ".repeat(depth.get(r.id) - 1)}${r.detail}`); }
  }
  srv.close();
  await closeDb();
  drop();
  console.log(`\n   ${outputs} outputs written; scratch file removed.`);
}
