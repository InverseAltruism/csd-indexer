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
// and a scratch pg schema (bench_tmp_<pid>), both dropped at the end. Run as csdsvc (peer auth).
//
// USAGE: node test/_backend-bench.mjs --sqlite /var/lib/csd-indexer/csd-index.db \
//          --pg "postgresql://csdsvc@/csd_index?host=/var/run/postgresql&port=5439"
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const SQLITE = opt("sqlite", process.env.CSD_INDEX_DB ?? "/var/lib/csd-indexer/csd-index.db");
const PG_DSN = opt("pg", process.env.CSD_INDEX_PG ?? "");
const PG_SCHEMA = opt("pg-schema", "public");
if (!PG_DSN) { console.error("need --pg <dsn>"); process.exit(2); }
if (!/^[A-Za-z0-9_]+$/.test(PG_SCHEMA)) { console.error("bad --pg-schema"); process.exit(2); }

const now = () => performance.now();
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
};
const fmt = (r) => `p50=${r.p50.toFixed(2)}ms p95=${r.p95.toFixed(2)}ms max=${r.max.toFixed(2)}ms`;

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
const addrs = (await pgAll(`SELECT DISTINCT addr FROM ${T("address_history")} ORDER BY random() LIMIT 50`)).map((r) => r.addr);
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
