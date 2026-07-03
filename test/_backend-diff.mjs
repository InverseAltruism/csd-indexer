// _backend-diff.mjs — the sqlite-vs-postgres row-for-row parity proof (Phase C).
//
// The README has long claimed "a from-genesis reindex matches row-for-row across backends";
// until this script that claim had no committed harness behind it (CI proves the same TEST SUITE
// passes on both backends; this proves a REAL chain's rows match). Run it after a from-genesis
// pg backfill, before any production cutover, and again after every future pg upgrade.
//
// Method: for every table, both sides are read in the same canonical ORDER BY with the same
// column projection, every value is normalized to a canonical string (bigint-safe: sqlite reads
// with readBigInts, pg int8/numeric parse as strings), and compared row-by-row + sha256 per table.
//
// Two known live-diff gotchas are handled (the "mid-rebuild = fake divergence" class):
//   1. Rows are only compared up to a FINALIZED height H = min(tip_sqlite, tip_pg) - LAG
//      (default LAG 12 >= 2x finalDepth), so tip churn between the two reads can't fake a diff.
//   2. An output at height <= H may be SPENT by a tx ABOVE H on one side only (the sides were
//      read moments apart) — spent_txid/spent_height are normalized to null when spent_height > H
//      on BOTH sides before comparing.
// meta is reported informationally only (indexed_height legitimately differs mid-catchup).
//
// USAGE (run as a user that can read the live sqlite DB, e.g. sudo -u csdsvc):
//   node test/_backend-diff.mjs --sqlite /var/lib/csd-indexer/csd-index.db \
//     --pg "postgresql://csdsvc@/csd_index?host=/var/run/postgresql&port=5439" [--pg-schema public]
//     [--max-height H] [--lag 12] [--max-mismatches 10]
// Exit 0 = every table matches at H. Non-zero = mismatch (first N printed per table).
//
// NOTE: tables are loaded fully per side (largest today ~126k rows, fine). If this is ever run
// at 100x chain size, page the reads by the ORDER BY keys instead.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const SQLITE = opt("sqlite", process.env.CSD_INDEX_DB ?? "/var/lib/csd-indexer/csd-index.db");
const PG_DSN = opt("pg", process.env.CSD_INDEX_PG ?? "");
const PG_SCHEMA = opt("pg-schema", process.env.CSD_INDEX_PG_SCHEMA ?? "public");
const LAG = Number(opt("lag", "12"));
const MAX_MISMATCH = Number(opt("max-mismatches", "10"));
if (!PG_DSN) { console.error("need --pg <dsn> (or CSD_INDEX_PG)"); process.exit(2); }
if (!/^[A-Za-z0-9_]+$/.test(PG_SCHEMA)) { console.error("bad --pg-schema"); process.exit(2); }

// ── the canonical projection per table: same columns, same order, both sides ──
// blocks are compared canonical-only (orphaned=0): an orphaned marker row is bookkeeping, not
// derived chain state, and unwind deletes above-ancestor rows anyway.
const TABLES = [
  { name: "blocks", cols: ["height", "hash", "prev", "merkle", "time", "bits", "nonce", "version", "tx_count", "chainwork"], where: "orphaned=0 AND height <= $H", order: "height" },
  { name: "txs", cols: ["txid", "height", "pos", "app_type", "signer", "fee", "time", "n_in", "n_out", "coinbase"], where: "height <= $H", order: "txid" },
  { name: "outputs", cols: ["txid", "vout", "addr", "value", "height", "spent_txid", "spent_height"], where: "height <= $H", order: "txid, vout" },
  { name: "address_history", cols: ["addr", "txid", "height", "pos", "direction", "delta"], where: "height <= $H", order: "addr, txid, direction, delta, pos" },
  { name: "proposals", cols: ["txid", "domain", "payload_hash", "uri", "expires_epoch", "proposer", "fee", "height", "time"], where: "height <= $H", order: "txid" },
  { name: "attestations", cols: ["txid", "proposal_id", "attester", "score", "confidence", "fee", "height", "time"], where: "height <= $H", order: "txid" },
];

// canonical value: null -> "∅", bigint/number/pg-numeric-string -> plain decimal string, text as-is.
const canonVal = (v) => {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
};
// spent-above-H normalization (gotcha 2). Applies identically to both sides.
const normalizeRow = (table, row, H) => {
  if (table === "outputs") {
    const sh = row.spent_height;
    if (sh !== null && sh !== undefined && BigInt(sh) > BigInt(H)) { row.spent_txid = null; row.spent_height = null; }
  }
  return row;
};

// ── sqlite side (read-only; live-WAL safe for the owning user) ──
const sq = new DatabaseSync(SQLITE, { readOnly: true });
const sqAll = (sql, ...params) => {
  const st = sq.prepare(sql);
  st.setReadBigInts(true); // value/fee/delta can legitimately exceed 2^53 — never read lossy
  return st.all(...params);
};
const sqTip = () => {
  const r = sqAll("SELECT MAX(height) AS h FROM blocks WHERE orphaned=0")[0];
  return r?.h === null || r?.h === undefined ? -1n : BigInt(r.h);
};

// ── pg side ──
const require = createRequire(import.meta.url);
const pgmod = require("pg");
pgmod.types.setTypeParser(20, (s) => s);   // int8 -> exact string
pgmod.types.setTypeParser(1700, (s) => s); // numeric -> exact string
const pool = new pgmod.Pool({ connectionString: PG_DSN, max: 2 });
const pgAll = async (sql, params = []) => (await pool.query(sql, params)).rows;
const pgTip = async () => {
  const r = await pgAll(`SELECT MAX(height) AS h FROM ${PG_SCHEMA}.blocks WHERE orphaned=0`);
  return r[0]?.h === null || r[0]?.h === undefined ? -1n : BigInt(r[0].h);
};

const t0 = Date.now();
const tipS = sqTip();
const tipP = await pgTip();
if (tipS < 0n || tipP < 0n) { console.error(`empty index (sqlite tip=${tipS}, pg tip=${tipP}) — backfill first`); process.exit(2); }
const H = opt("max-height", null) !== null ? BigInt(opt("max-height")) : (tipS < tipP ? tipS : tipP) - BigInt(LAG);
console.log(`backend-diff: sqlite tip=${tipS} pg tip=${tipP} -> comparing at FINALIZED H=${H} (lag ${LAG})`);

let failed = 0;
for (const t of TABLES) {
  const proj = t.cols.join(", ");
  const whereS = t.where.replace("$H", H.toString());
  const rowsS = sqAll(`SELECT ${proj} FROM ${t.name} WHERE ${whereS} ORDER BY ${t.order}`)
    .map((r) => normalizeRow(t.name, r, H));
  const rowsP = (await pgAll(`SELECT ${proj} FROM ${PG_SCHEMA}.${t.name} WHERE ${t.where.replace("$H", "$1")} ORDER BY ${t.order}`, [H.toString()]))
    .map((r) => normalizeRow(t.name, r, H));

  const canon = (r) => t.cols.map((c) => canonVal(r[c])).join("|");
  const hS = createHash("sha256"), hP = createHash("sha256");
  for (const r of rowsS) hS.update(canon(r) + "\n");
  for (const r of rowsP) hP.update(canon(r) + "\n");
  const dS = hS.digest("hex"), dP = hP.digest("hex");

  if (rowsS.length === rowsP.length && dS === dP) {
    console.log(`  PASS ${t.name.padEnd(16)} rows=${String(rowsS.length).padStart(7)} sha=${dS.slice(0, 16)}`);
    continue;
  }
  failed++;
  console.log(`  FAIL ${t.name.padEnd(16)} sqlite rows=${rowsS.length} sha=${dS.slice(0, 16)} | pg rows=${rowsP.length} sha=${dP.slice(0, 16)}`);
  let shown = 0;
  const n = Math.max(rowsS.length, rowsP.length);
  for (let i = 0; i < n && shown < MAX_MISMATCH; i++) {
    const a = rowsS[i] ? canon(rowsS[i]) : "<missing>";
    const b = rowsP[i] ? canon(rowsP[i]) : "<missing>";
    if (a !== b) { shown++; console.log(`       row[${i}] sqlite: ${a}\n       row[${i}] pg    : ${b}`); }
  }
}

// meta: informational only — indexed_height legitimately differs while one side catches up.
const metaS = sqAll("SELECT key, value FROM meta ORDER BY key").map((r) => `${r.key}=${canonVal(r.value)}`);
const metaP = (await pgAll(`SELECT key, value FROM ${PG_SCHEMA}.meta ORDER BY key`)).map((r) => `${r.key}=${canonVal(r.value)}`);
console.log(`  info meta            sqlite [${metaS.join(", ")}] | pg [${metaP.join(", ")}]`);

await pool.end();
sq.close();
console.log(failed === 0
  ? `ALL TABLES MATCH at H=${H} (${((Date.now() - t0) / 1000).toFixed(1)}s) — row-for-row parity PROVEN`
  : `${failed} TABLE(S) DIVERGE at H=${H} — do NOT cut over`);
process.exit(failed === 0 ? 0 : 1);
