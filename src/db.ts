// Relational store with two interchangeable backends behind ONE async interface:
//
//   - sqlite (node:sqlite, built into Node 22; no native dep, no build step). The
//     DEFAULT: zero-config, perfect for one operator / CI / third parties re-running
//     the index to audit determinism.
//   - Postgres (`pg` pool), selected by CSD_INDEX_PG=postgres://...; the scale path.
//     node:sqlite is SYNCHRONOUS: every query blocks the event loop, so concurrent
//     readers serialize behind each other and behind the block writer. Postgres moves
//     queries off-loop onto a pool, which is what lets the API keep answering while
//     blocks are being written.
//
// CSD's payload is relational (per-attester rows, address history, domain rankings,
// UTXO spends), which a relational engine models far better than a KV index; so we
// extend Cairn's sqlite scanner rather than adopt electrs's RocksDB (see docs/ecosystem/03).
//
// Reorg invariant: EVERY row carries `height`, so unwinding orphaned blocks is
// `DELETE ... WHERE height > ancestor` + un-spending outputs whose spender was
// orphaned. A reorg is followed as deep as the checkpoint floor allows (indexer.ts).
//
// Number policy (both backends): 64-bit integer columns are read EXACTLY; values
// within Number.MAX_SAFE_INTEGER come back as `number`, anything past 2^53 comes back
// as `bigint` (never silently truncated, never thrown). Callers that serialize amounts
// use amt()-style helpers to keep JSON clean.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { CFG } from "./config.js";

// CJS require shim for the lazy `pg` import (we run as ESM via tsx); keeps pg
// optional at runtime for sqlite-only users.
const require = createRequire(import.meta.url);

/** number when exact, bigint when past 2^53; never lossy. */
function exact(v: bigint): number | bigint {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;
}

export interface Store {
  /** Run DDL / multiple statements (no params, no result). */
  exec(sql: string): Promise<void>;
  /** Run one statement with params; no result rows. */
  run(sql: string, ...params: unknown[]): Promise<void>;
  /** First row or undefined. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  /** All rows. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** Serialized read-modify-write transaction. fn runs against the SAME connection. */
  tx<T>(fn: (s: Store) => Promise<T>): Promise<T>;
  /** Reads in one snapshot of the database (see snapshot() below). */
  snapshot<T>(fn: (s: Store) => Promise<T>): Promise<T>;
  /** Backend-specific maintenance (WAL checkpoint on sqlite; no-op on pg). */
  checkpoint(): Promise<void>;
  close(): Promise<void>;
  readonly backend: "sqlite" | "postgres";
}

// ── shared DDL (kept to the dialect intersection; BIGINT where a value can pass 2^31) ──
// The chain-order feeds' page statements (queries.ts feedPageStatement) walk these in height order from the cursor,
// so a page reads its own rows instead of every row of the feed; indexer.ts writeBlock's and unwindAbove's deletes of
// proposals and attestations by height search the height ones. Exported for the feed bench, which times each build.
export const FEED_INDEX_DDL = [
  "CREATE INDEX IF NOT EXISTS idx_prop_domain_height ON proposals(domain, height)",
  "CREATE INDEX IF NOT EXISTS idx_prop_height ON proposals(height)",
  "CREATE INDEX IF NOT EXISTS idx_att_height ON attestations(height)",
] as const;
// Exported for the UTXO bench, which times its build.
export const UTXO_INDEX_DDL = "CREATE INDEX IF NOT EXISTS idx_out_addr_unspent ON outputs(addr, (COALESCE(spent_txid, '')), height, txid, vout)";
// Postgres estimates `addr = ? AND COALESCE(spent_txid, '') = ''` as if the two were independent: for a miner's
// address with thousands of spent outputs and a few unspent ones it expects thousands of rows and walks outputs by
// height instead of the index above. The statistics object gives it the pair's frequencies (Postgres 14 or later);
// ANALYZE fills it, at the first start that creates it and then as autovacuum analyzes the table. At the default
// target its list holds the 100 commonest pairs of a 30,000-row sample, and a miner's few unspent outputs fell out of
// it in 2 of 60 ANALYZE runs on the plan test's table; at 250 the sample is 75,000 rows and the list 250 pairs, and
// none of 200 runs left the index (1000 held as well, with ANALYZE four times as long: 12 s on 300,000 outputs
// against 2.9 s). With no statistics yet the planner seeks this index on both columns and sorts what it finds.
const UTXO_STATS = "st_out_addr_unspent";
const UTXO_STATS_DDL = `CREATE STATISTICS IF NOT EXISTS ${UTXO_STATS} (mcv, dependencies) ON addr, (COALESCE(spent_txid, '')) FROM outputs`;
const UTXO_STATS_TARGET = `ALTER STATISTICS ${UTXO_STATS} SET STATISTICS 250`;
/** The schema statements a start applies on `backend`. */
const schemaSql = (backend: Store["backend"]): string[] => (backend === "postgres" ? [DDL, UTXO_STATS_DDL, UTXO_STATS_TARGET] : [DDL]);
// The statistics object exists and holds no data yet. pg_statistic_ext_data is readable by a superuser only; the
// pg_stats_ext view shows the table owner its own rows (test/pg-nonsuperuser.test.ts).
const UTXO_STATS_EMPTY = `SELECT 1 FROM pg_statistic_ext s WHERE s.stxname = '${UTXO_STATS}' ` +
  "AND s.stxnamespace = current_schema()::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_stats_ext v " +
  "WHERE v.statistics_schemaname = current_schema() AND v.statistics_name = s.stxname)";
// An INTEGER column (txs.pos, outputs.vout) is 4 bytes on Postgres, where a larger bind fails the statement; SQLite's
// INTEGER is 8 bytes. A route refuses a cursor value above this instead of answering 500 on one backend only.
export const PG_INTEGER_MAX = 2 ** 31 - 1;
// blocks.version is BIGINT (u32 in the codec; int4 overflowed on pg and wedged writeBlock). A Postgres
// database created before 0.2.11 needs `ALTER TABLE blocks ALTER COLUMN version TYPE BIGINT` once:
// CREATE TABLE IF NOT EXISTS does not alter an existing table. sqlite INTEGER is already 64-bit.
// blocks.orphaned is unused: writeBlock writes 0, nothing writes 1 and no query reads it (a reorg deletes
// the rows). It stays until a schema migration drops it, because the live databases carry it.
const DDL = `
  CREATE TABLE IF NOT EXISTS blocks (
    height BIGINT PRIMARY KEY,
    hash TEXT NOT NULL, prev TEXT, merkle TEXT,
    time BIGINT, bits BIGINT, nonce BIGINT, version BIGINT,
    tx_count INTEGER, chainwork TEXT, orphaned INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS txs (
    txid TEXT PRIMARY KEY, height BIGINT NOT NULL, pos INTEGER NOT NULL,
    app_type TEXT, signer TEXT, fee BIGINT, time BIGINT, n_in INTEGER, n_out INTEGER, coinbase INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS outputs (
    txid TEXT NOT NULL, vout INTEGER NOT NULL, addr TEXT, value BIGINT,
    height BIGINT NOT NULL, spent_txid TEXT, spent_height BIGINT,
    PRIMARY KEY (txid, vout)
  );
  CREATE TABLE IF NOT EXISTS address_history (
    addr TEXT NOT NULL, txid TEXT NOT NULL, height BIGINT NOT NULL,
    pos INTEGER, direction TEXT, delta BIGINT,
    PRIMARY KEY (addr, txid, direction, delta, pos)
  );
  CREATE TABLE IF NOT EXISTS proposals (
    txid TEXT PRIMARY KEY, domain TEXT, payload_hash TEXT, uri TEXT,
    expires_epoch BIGINT, proposer TEXT, fee BIGINT, height BIGINT, time BIGINT
  );
  CREATE TABLE IF NOT EXISTS attestations (
    txid TEXT PRIMARY KEY, proposal_id TEXT, attester TEXT, score BIGINT,
    confidence BIGINT, fee BIGINT, height BIGINT, time BIGINT
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  -- Per-address count and sum of the coinbase outputs in outputs JOIN txs (COINBASE_OUTPUTS below), kept equal
  -- to that aggregate by indexer.ts coinbaseTotalsWrites inside every writeBlock and unwindAbove transaction.
  CREATE TABLE IF NOT EXISTS coinbase_totals (addr TEXT PRIMARY KEY, outputs BIGINT NOT NULL, value BIGINT NOT NULL);
  -- Per address what /address/:a serves, the addressTotalsSql aggregate below, kept equal to it by indexer.ts
  -- addressTotalsWrites inside every writeBlock and unwindAbove transaction. A sum is held as two columns (joinSum).
  CREATE TABLE IF NOT EXISTS address_totals (addr TEXT PRIMARY KEY, outputs BIGINT NOT NULL, unspent BIGINT NOT NULL,
    funded_hi BIGINT NOT NULL, funded_lo BIGINT NOT NULL, spent_hi BIGINT NOT NULL, spent_lo BIGINT NOT NULL, txs BIGINT NOT NULL);
  -- A block's positions that hold a txid whose txs row sits at an earlier place (indexer.ts writeBlock). With the
  -- txs rows of the height they are the block's whole ordered tx list (queries.ts BLOCK_TX_LIST).
  CREATE TABLE IF NOT EXISTS tx_repeats (height BIGINT NOT NULL, pos INTEGER NOT NULL, txid TEXT NOT NULL, PRIMARY KEY (height, pos));

  CREATE INDEX IF NOT EXISTS idx_txs_height       ON txs(height);
  CREATE INDEX IF NOT EXISTS idx_txs_signer       ON txs(signer);
  CREATE INDEX IF NOT EXISTS idx_out_addr         ON outputs(addr);
  CREATE INDEX IF NOT EXISTS idx_out_spent        ON outputs(spent_txid);
  CREATE INDEX IF NOT EXISTS idx_addrhist_addr    ON address_history(addr, height);
  CREATE INDEX IF NOT EXISTS idx_prop_domain      ON proposals(domain);
  -- Composite (proposal_id, height, txid) matches /proposal/:id/attestations' ORDER BY + keyset cursor,
  -- so the resolver's pagination is index-ordered SEEKS, not a per-page temp-B-tree re-sort (it also
  -- fully serves the old proposal_id-only lookups, so the single-column index is dropped below).
  CREATE INDEX IF NOT EXISTS idx_att_proposal_hk  ON attestations(proposal_id, height, txid);
  DROP INDEX IF EXISTS idx_att_proposal;
  CREATE INDEX IF NOT EXISTS idx_att_attester     ON attestations(attester);
  -- N17: /block/:hash (queries.ts blockByHash) was an O(chain) seq scan, 2 lookups per height
  -- behind every cold /api/headers miss. N20: writeBlock's per-height self-clear and unwindAbove
  -- run height/spent_height-predicate UPDATE/DELETEs on outputs + address_history that seq-scan
  -- without these, making the from-genesis DR replay effectively quadratic. Additive + idempotent,
  -- applied at boot on both backends like every index above.
  CREATE INDEX IF NOT EXISTS idx_blocks_hash      ON blocks(hash);
  -- /blocks/at-or-after/:time reads MIN(height) over time >= t from this index alone.
  CREATE INDEX IF NOT EXISTS idx_blocks_time      ON blocks(time, height);
  CREATE INDEX IF NOT EXISTS idx_out_height       ON outputs(height);
  CREATE INDEX IF NOT EXISTS idx_out_spent_height ON outputs(spent_height);
  CREATE INDEX IF NOT EXISTS idx_addrhist_height  ON address_history(height);
  -- /address/:a/utxo (queries.ts addressUtxos) seeks an address's unspent outputs in (height, txid, vout) order and
  -- stops at the page. The unspent test is an equality on this expression, which both planners use for the order;
  -- \`spent_txid IS NULL\` is no equality to either, and the page read every output of the address (Postgres) or of
  -- the unspent set (SQLite). test/address-utxo.test.ts pins the plan.
  ${UTXO_INDEX_DDL};
${FEED_INDEX_DDL.map((s) => `  ${s};`).join("\n")}
`;

// The coinbase outputs paying an address: the one definition coinbase_totals summarises. Callers append
// `AND (...)` to narrow it.
export const COINBASE_OUTPUTS = "FROM outputs o JOIN txs t ON t.txid = o.txid WHERE t.coinbase = 1 AND o.addr IS NOT NULL";

// What /address/:a serves per address, over the rows three predicates select: count, unspent count and funded sum of
// `outputs` rows, minus one unspent and plus the spent sum per spent row, distinct txids of `address_history` rows.
// "1 = 1" gives the whole aggregate, ADDRESS_AT (indexer.ts) a share. Grouped arms rebuild from the address indexes
// on Postgres; ungrouped arms keep SQLite on its height indexes. A sum is two sums (joinSum), each inside int64 below
// 2^31 outputs per address, where one SUM(value) passes 2^63 at 877 times the max supply received.
const ADDRESS_TOTALS_TERMS = (() => {
  const hi = "COALESCE(value, 0) >> 32", lo = "COALESCE(value, 0) & 4294967295";
  //              outputs unspent funded_hi funded_lo spent_hi spent_lo
  return { output: ["1", "1", hi, lo, "0", "0"], spent: ["0", "-1", "0", "0", hi, lo], history: ["0", "0", "0", "0", "0", "0"] };
})();
const ADDRESS_TOTALS_SUMS = ["outputs", "unspent", "funded_hi", "funded_lo", "spent_hi", "spent_lo"] as const;
export const ADDRESS_TOTALS_COLS = [...ADDRESS_TOTALS_SUMS, "txs"] as const;
export const addressTotalsSql = (w: { outputs: string; spent: string; history: string }, grouped: boolean): string => {
  const arm = (terms: string[], txid: string | null, from: string) => {
    const cols = [...terms.map((t, i) => `${grouped ? `SUM(${t})` : t} AS ${ADDRESS_TOTALS_SUMS[i]}`),
      `${txid == null ? (grouped ? "0" : "NULL") : grouped ? `COUNT(DISTINCT ${txid})` : txid} AS txs`];
    return `SELECT addr, ${cols.join(", ")} FROM ${from}${grouped ? " GROUP BY addr" : ""}`;
  };
  return `SELECT addr, ${ADDRESS_TOTALS_SUMS.map((c) => `SUM(${c}) AS ${c}`).join(", ")}, ${grouped ? "SUM(txs)" : "COUNT(DISTINCT txs)"} AS txs FROM (` +
    [arm(ADDRESS_TOTALS_TERMS.output, null, `outputs WHERE addr IS NOT NULL AND (${w.outputs})`),
      arm(ADDRESS_TOTALS_TERMS.spent, null, `outputs WHERE addr IS NOT NULL AND spent_txid IS NOT NULL AND (${w.spent})`),
      arm(ADDRESS_TOTALS_TERMS.history, "txid", `address_history WHERE (${w.history})`)].join(" UNION ALL ") +
    ") x GROUP BY addr";
};
export const ADDRESS_TOTALS_ALL = { outputs: "1 = 1", spent: "1 = 1", history: "1 = 1" } as const;
/** A sum address_totals holds as its two columns, the sums of value >> 32 and of value & 0xFFFFFFFF. */
export function joinSum(hi: number | bigint | null | undefined, lo: number | bigint | null | undefined): bigint {
  return (BigInt(hi ?? 0) << 32n) + BigInt(lo ?? 0);
}

// Every start rebuilds coinbase_totals and address_totals from the rows; a writer without the maintenance (an older
// version on the same database) leaves them stale until then. The rebuild and the maintaining writers serialize: on
// Postgres both take TOTALS_LOCK first in their transaction (it conflicts with itself, not with readers); on SQLite the
// rebuild and every Store.tx begin IMMEDIATE, so each waits for another process's write transaction (busy_timeout).
export const TOTALS_LOCK = "LOCK TABLE coinbase_totals, address_totals IN SHARE ROW EXCLUSIVE MODE";
export function totalsRebuildSql(backend: Store["backend"]): string[] {
  return [
    ...(backend === "postgres" ? [TOTALS_LOCK] : []),
    "DELETE FROM coinbase_totals",
    `INSERT INTO coinbase_totals(addr, outputs, value) SELECT o.addr, COUNT(*), COALESCE(SUM(o.value), 0) ${COINBASE_OUTPUTS} GROUP BY o.addr`,
    "DELETE FROM address_totals",
    `INSERT INTO address_totals(addr, ${ADDRESS_TOTALS_COLS.join(", ")}) ${addressTotalsSql(ADDRESS_TOTALS_ALL, backend === "postgres")}`,
  ];
}

// ── sqlite backend ──
class SqliteStore implements Store {
  readonly backend = "sqlite" as const;
  private d: DatabaseSync;
  // Statement cache: the codebase has ~30 distinct SQL strings, and prepare-per-call
  // measured ~2.5x slower on the hot write path (200k-insert microbench: 536ms prepared
  // vs 1333ms re-prepared). Unbounded growth is impossible in practice, but cap anyway.
  private stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  constructor(file: string) {
    this.d = new DatabaseSync(file);
    this.d.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;`);
    this.d.exec(DDL);
    this.d.exec("BEGIN IMMEDIATE");
    try {
      for (const q of totalsRebuildSql(this.backend)) this.d.exec(q);
      this.d.exec("COMMIT");
    } catch (e) { try { this.d.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
  }
  private stmt(sql: string) {
    let st = this.stmts.get(sql);
    if (!st) {
      if (this.stmts.size > 256) this.stmts.clear(); // a bound: IN lists and /analytics/series vary the SQL text
      st = this.d.prepare(sql);
      st.setReadBigInts(true);
      this.stmts.set(sql, st);
    }
    return st;
  }
  // node:sqlite THROWS ERR_OUT_OF_RANGE reading an integer past 2^53 as a Number, so we
  // ALWAYS read integers as BigInt and convert back per-value (exact, never throws).
  private rows<T>(sql: string, params: unknown[]): T[] {
    const raw = this.stmt(sql).all(...(params as never[])) as Record<string, unknown>[];
    return raw.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) o[k] = typeof v === "bigint" ? exact(v) : v;
      return o as T;
    });
  }
  async exec(sql: string): Promise<void> { this.d.exec(sql); }
  async run(sql: string, ...params: unknown[]): Promise<void> {
    this.stmt(sql).run(...(params as never[]));
  }
  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.rows<T>(sql, params)[0];
  }
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.rows<T>(sql, params);
  }
  // ISOLATION INVARIANT (load-bearing, experimentally verified): the BEGIN..COMMIT window
  // stays atomic w.r.t. HTTP readers ONLY because every await inside dbTx callbacks is a
  // store call (a microtask; the event loop cannot run I/O callbacks until the microtask
  // chain drains). Adding `await fetch(...)`/fs/timers inside a dbTx callback would let
  // readers interleave on this SAME connection and see uncommitted rows. Don't.
  // IMMEDIATE: every caller writes, and a deferred transaction that reads first cannot wait for another
  // process's write lock when it upgrades (SQLITE_BUSY at once, busy_timeout unused).
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    this.d.exec("BEGIN IMMEDIATE");
    try { const r = await fn(this); this.d.exec("COMMIT"); return r; }
    catch (e) { try { this.d.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
  }
  // A deferred transaction reads one WAL snapshot from its first read, so another process's commit (a separate `index`
  // run) cannot land between two reads. The callback awaits only store reads, as a dbTx callback does, so this
  // process's writer cannot begin inside it; inside an open transaction the reads already share one view.
  async snapshot<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    if (this.d.isTransaction) return await fn(this);
    this.d.exec("BEGIN");
    try { return await fn(this); }
    finally { if (this.d.isTransaction) this.d.exec("COMMIT"); }
  }
  async checkpoint(): Promise<void> { try { this.d.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* busy */ } }
  async close(): Promise<void> { this.d.close(); }
}

// ── postgres backend ──
// A start's transactions, the schema DDL, `ANALYZE outputs` (only while the statistics object holds no data) and the
// totals rebuild, grow with the rows: an index the DDL adds is built over every row of its table, ANALYZE samples
// outputs, and the rebuild reads every outputs and address_history row, which anyone can add. The
// pool's 30 s statement timeout would fail every start past that, so each runs without it, and every other statement
// on the connection keeps it (SET LOCAL). A lock another session holds is waited for at most BOOT_LOCK_TIMEOUT_MS per
// lock; past that the transaction fails (SQLSTATE 55P03) and rolls back, and the next store call starts again
// (test/boot-rebuild-timeout.test.ts).
export const BOOT_LOCK_TIMEOUT_MS = 5000;
async function bootTx(c: import("pg").PoolClient, statements: readonly string[], broken: (e: Error) => void): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query("SET LOCAL statement_timeout = 0");
    await c.query(`SET LOCAL lock_timeout = ${BOOT_LOCK_TIMEOUT_MS}`);
    for (const q of statements) await c.query(q);
    await c.query("COMMIT");
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (re) { broken(re as Error); }
    if ((e as { code?: string }).code === "55P03") {
      throw new Error(`the start waited ${BOOT_LOCK_TIMEOUT_MS} ms for a lock another session holds; the next store call starts again (${(e as Error).message})`, { cause: e });
    }
    throw e;
  }
}

// A client checked out of the pool has no 'error' listener (pg-pool removes its own at checkout and adds it back at
// release), and a session that ends while the client is out (a server restart, pg_terminate_backend) emits 'error' on
// it: with no listener that ended the process. withClient listens while the client is out, and a client that saw such
// an error or whose ROLLBACK failed (fn reports it through `broken`) goes back with the error, so the pool closes it:
// a session still answering inside its aborted transaction, or about to end, is not handed to the next caller
// (test/pg-client-loss.test.ts).
async function withClient<T>(pool: import("pg").Pool, fn: (c: import("pg").PoolClient, broken: (e: Error) => void) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  let failed: Error | undefined;
  const broken = (e: Error) => { failed ??= e; };
  c.on("error", broken);
  try { return await fn(c, broken); } finally { c.removeListener("error", broken); c.release(failed); }
}

// `?` placeholders are translated to $1..$n so call sites stay dialect-free.
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// A Store over one pg client: a transaction's or a snapshot's statements all run on it.
function clientStore(c: import("pg").PoolClient): Store {
  return {
    backend: "postgres",
    exec: async (sql) => { await c.query(sql); },
    run: async (sql, ...p) => { await c.query(toPg(sql), p as unknown[]); },
    get: async (sql, ...p) => (await c.query(toPg(sql), p as unknown[])).rows[0],
    all: async (sql, ...p) => (await c.query(toPg(sql), p as unknown[])).rows,
    tx: () => { throw new Error("nested tx"); },
    snapshot: (fn) => fn(clientStore(c)),
    checkpoint: async () => { /* autovacuum's job, as on the pool */ },
    close: async () => { /* the client goes back to the pool where it was taken */ },
  };
}

class PgStore implements Store {
  readonly backend = "postgres" as const;
  private pool!: import("pg").Pool;
  private schemaSafe: string;
  private _ready: Promise<void> | null = null;
  // CAIRN-IDX-POOL-1 / PG-7: hard cap on the pending-acquire queue (pg-pool has no native one).
  // Sized as the pool max + a modest burst buffer; beyond it we fast-fail rather than let a flood
  // park thousands of waiters and balloon memory/latency. The writer's store has no cap (writer() below).
  private readonly maxWaiting: number;
  private _writer: PgStore | null = null;
  constructor(private readonly url: string, schema: string, private readonly opts: { max: number; guarded: boolean; boot?: PgStore }) {
    this.maxWaiting = Math.max(64, opts.max * 8);
    const { Pool, types } = require("pg") as typeof import("pg");
    // Exact integer reads, same policy as the sqlite backend: int8 (OID 20) and the
    // NUMERIC (OID 1700) that SUM(bigint) yields come back as number within 2^53,
    // bigint past it (the sums here are integral; sats, counts, heights).
    const exactParser = (v: string) => exact(BigInt(v));
    const perPool = {
      getTypeParser: (oid: number, format?: string) =>
        oid === 20 || oid === 1700 ? exactParser : (types.getTypeParser as (o: number, f?: string) => unknown)(oid, format),
    } as unknown as import("pg").CustomTypesConfig;
    this.schemaSafe = schema.replace(/[^a-zA-Z0-9_]/g, "");
    this.pool = new Pool({
      connectionString: url, max: opts.max, types: perPool,
      // CAIRN-IDX-POOL-1 / PG-7: per-acquire timeout; any single acquire fails after 10s rather
      // than hanging. NOTE: this bounds how long ONE waiter waits, not how MANY can wait; pg-pool
      // 3.x has no built-in maxWaitingClients, so the queue length is bounded explicitly below in
      // acquireGuard() (the prior comment claimed "never queue forever" but the queue was unbounded).
      connectionTimeoutMillis: 10_000,
      // server-side guards: statement_timeout (30s) caps any single query (a start's DDL and rebuild aside, bootTx) so no runaway read
      // holds a connection; idle_in_transaction_session_timeout (60s) keeps an abandoned
      // BEGIN from holding locks. Both exceed connectionTimeoutMillis by design; the acquire
      // timeout fails fast; these bound work that is already running on a connection.
      options: "-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
    });
    // pg-pool EMITS 'error' for connection failures on IDLE pooled clients (server
    // restart, idle kill, network blip). With no listener that's an uncaught exception
    // that takes the whole process down; log and let the pool replace the client.
    this.pool.on("error", (e) => console.error(`[pg pool] idle client error: ${e.message}`));
    // every pooled connection joins the schema
    this.pool.on("connect", (client) => {
      client.query(`SET search_path TO ${this.schemaSafe}`).catch(() => { /* a broken connection fails the user query queued behind it */ });
    });
  }
  /** The block writer's store: its own pool of one connection, without the readers' wait cap, so no read flood can
   *  refuse or queue a block write (test/pg-writer-connection.test.ts). The readers keep their pool and their cap. */
  writer(): Store {
    if (this.opts.boot) return this;
    this._writer ??= new PgStore(this.url, this.schemaSafe, { max: 1, guarded: false, boot: this });
    return this._writer;
  }
  // Lazily (re)established: if the first connect/DDL fails (pg still starting, network
  // blip), the failure must NOT be cached forever; the next call retries from scratch,
  // so the indexer loop recovers as soon as Postgres does. A writer's store boots through its owner.
  private ready(): Promise<void> {
    if (this.opts.boot) return this.opts.boot.ready();
    if (this._ready) return this._ready;
    const p = withClient(this.pool, async (c, broken) => {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSafe}`);
      await c.query(`SET search_path TO ${this.schemaSafe}`);
      await bootTx(c, schemaSql(this.backend), broken);
      if ((await c.query(UTXO_STATS_EMPTY)).rowCount) await bootTx(c, ["ANALYZE outputs"], broken);
      await bootTx(c, totalsRebuildSql(this.backend), broken);
    });
    this._ready = p;
    p.catch(() => { if (this._ready === p) this._ready = null; });
    return p;
  }
  // Bound the pending-acquire queue: if more than maxWaiting requests are already parked waiting
  // for a connection, fast-fail this one rather than join an unbounded line. (Each pg.query that
  // can't get an idle client enters the same _pendingQueue, so checking waitingCount covers
  // query() and connect() alike.)
  private acquireGuard(): void {
    if (this.opts.guarded && this.pool.waitingCount >= this.maxWaiting)
      throw new Error("indexer db pool saturated (too many concurrent requests)");
  }
  async exec(sql: string): Promise<void> { await this.ready(); this.acquireGuard(); await this.pool.query(sql); }
  async run(sql: string, ...params: unknown[]): Promise<void> {
    await this.ready(); this.acquireGuard(); await this.pool.query(toPg(sql), params as unknown[]);
  }
  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    await this.ready(); this.acquireGuard();
    const r = await this.pool.query(toPg(sql), params as unknown[]);
    return r.rows[0] as T | undefined;
  }
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    await this.ready(); this.acquireGuard();
    const r = await this.pool.query(toPg(sql), params as unknown[]);
    return r.rows as T[];
  }
  private async onClient<T>(begin: string, fn: (s: Store) => Promise<T>): Promise<T> {
    await this.ready(); this.acquireGuard();
    return await withClient(this.pool, async (c, broken) => {
      try {
        await c.query(begin);
        const r = await fn(clientStore(c));
        await c.query("COMMIT");
        return r;
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch (re) { broken(re as Error); }
        throw e;
      }
    });
  }
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> { return await this.onClient("BEGIN", fn); }
  // REPEATABLE READ takes one snapshot at the first statement and keeps it for the transaction.
  async snapshot<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return await this.onClient("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", fn);
  }
  async checkpoint(): Promise<void> { /* autovacuum's job */ }
  async close(): Promise<void> {
    if (this._writer) { await this._writer.close(); this._writer = null; }
    await this.pool.end();
  }
}

let _store: Store | null = null;
// The store a call runs against when it is not the process's default: a route's snapshot or the sync loop's writer.
const scope = new AsyncLocalStorage<Store>();

function base(): Store {
  if (_store) return _store;
  _store = CFG.pg ? new PgStore(CFG.pg, CFG.pgSchema, { max: CFG.pgPoolSize, guarded: true }) : new SqliteStore(CFG.db);
  return _store;
}

export function store(): Store { return scope.getStore() ?? base(); }

/** Runs fn with every store() call on the block writer's connection: on Postgres its own pool of one, outside the
 *  readers' pool and wait cap; on SQLite the one connection. */
export function asWriter<T>(fn: () => Promise<T>): Promise<T> {
  const b = base();
  return scope.run(b instanceof PgStore ? b.writer() : b, fn);
}

/** Runs fn with every store() call reading one snapshot (REPEATABLE READ on Postgres, a deferred transaction on
 *  SQLite), so an answer built from several statements is one view of the chain (test/snapshot-reads.test.ts). Inside
 *  a snapshot or a transaction it runs fn in the one already open. The callback awaits only store reads. */
export function snapshot<T>(fn: () => Promise<T>): Promise<T> {
  const cur = scope.getStore();
  if (cur) return cur.snapshot((s) => scope.run(s, fn));
  return base().snapshot((s) => scope.run(s, fn));
}

/** Serialized read-modify-write transaction (see Store.tx). */
export function tx<T>(fn: (s: Store) => Promise<T>): Promise<T> { return store().tx(fn); }

export async function closeDb(): Promise<void> { if (_store) { await _store.close(); _store = null; } }
export async function checkpoint(): Promise<void> { await store().checkpoint(); }

/** TEST ONLY: drop every table so a suite starts from nothing (works on both backends). */
export async function resetStoreForTests(): Promise<void> {
  const s = store();
  for (const t of ["address_history", "attestations", "proposals", "outputs", "txs", "tx_repeats", "blocks", "meta", "coinbase_totals", "address_totals"]) {
    await s.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  for (const q of schemaSql(s.backend)) await s.exec(q);
  await s.tx(async (d) => { for (const q of totalsRebuildSql(d.backend)) await d.run(q); });
}

export async function getMeta(k: string): Promise<string | null> {
  const r = await store().get<{ value: string }>("SELECT value FROM meta WHERE key=?", k);
  return r?.value ?? null;
}
export async function setMeta(k: string, v: string): Promise<void> {
  await store().run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, v);
}
