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
// orphaned. Nothing deeper than CONFIRMATIONS_FINAL is ever touched.
//
// Number policy (both backends): 64-bit integer columns are read EXACTLY; values
// within Number.MAX_SAFE_INTEGER come back as `number`, anything past 2^53 comes back
// as `bigint` (never silently truncated, never thrown). Callers that serialize amounts
// use amt()-style helpers to keep JSON clean.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
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
  /** Backend-specific maintenance (WAL checkpoint on sqlite; no-op on pg). */
  checkpoint(): Promise<void>;
  close(): Promise<void>;
  readonly backend: "sqlite" | "postgres";
}

// ── shared DDL (kept to the dialect intersection; BIGINT where a value can pass 2^31) ──
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

// Every boot rebuilds coinbase_totals and address_totals from the rows. A writer without the maintenance (an older
// version writing the same database) leaves them stale; the next start repairs them. The coinbase rebuild took 0.3 to 0.4 s on Postgres and 0.9 to 1.0 s on
// SQLite seeded at 2026-10 mainnet size. The rebuild and the maintaining writers serialize: on Postgres both take
// TOTALS_LOCK first in their transaction (it conflicts with itself, not with readers); on SQLite the rebuild and every
// Store.tx begin IMMEDIATE, so each waits for another process's write transaction through busy_timeout instead of failing.
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
      if (this.stmts.size > 256) this.stmts.clear(); // safety valve, never hit by current code
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
  async checkpoint(): Promise<void> { try { this.d.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* busy */ } }
  async close(): Promise<void> { this.d.close(); }
}

// ── postgres backend ──
// `?` placeholders are translated to $1..$n so call sites stay dialect-free.
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

class PgStore implements Store {
  readonly backend = "postgres" as const;
  private pool!: import("pg").Pool;
  private schemaSafe: string;
  private _ready: Promise<void> | null = null;
  // CAIRN-IDX-POOL-1 / PG-7: hard cap on the pending-acquire queue (pg-pool has no native one).
  // Sized as the pool max + a modest burst buffer; beyond it we fast-fail rather than let a flood
  // park thousands of waiters and balloon memory/latency.
  private readonly maxWaiting = Math.max(64, CFG.pgPoolSize * 8);
  constructor(url: string, schema: string) {
    const { Pool, types } = require("pg") as typeof import("pg");
    // Exact integer reads, same policy as the sqlite backend: int8 (OID 20) and the
    // NUMERIC (OID 1700) that SUM(bigint) yields come back as number within 2^53,
    // bigint past it (the sums here are integral; sats, counts, heights).
    const exactParser = (v: string) => exact(BigInt(v));
    const perPool = {
      getTypeParser: (oid: number, format?: string) =>
        oid === 20 || oid === 1700 ? exactParser : (types.getTypeParser as (o: number, f?: string) => unknown)(oid, format),
    } as unknown as import("pg").CustomTypesConfig;
    this.pool = new Pool({
      connectionString: url, max: CFG.pgPoolSize, types: perPool,
      // CAIRN-IDX-POOL-1 / PG-7: per-acquire timeout; any single acquire fails after 10s rather
      // than hanging. NOTE: this bounds how long ONE waiter waits, not how MANY can wait; pg-pool
      // 3.x has no built-in maxWaitingClients, so the queue length is bounded explicitly below in
      // acquireGuard() (the prior comment claimed "never queue forever" but the queue was unbounded).
      connectionTimeoutMillis: 10_000,
      // server-side guards: statement_timeout (30s) caps any single query (the start's totals rebuild aside) so no runaway read
      // starves the block writer; idle_in_transaction_session_timeout (60s) keeps an abandoned
      // BEGIN from holding locks. Both exceed connectionTimeoutMillis by design; the acquire
      // timeout fails fast; these bound work that is already running on a connection.
      options: "-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
    });
    // pg-pool EMITS 'error' for connection failures on IDLE pooled clients (server
    // restart, idle kill, network blip). With no listener that's an uncaught exception
    // that takes the whole process down; log and let the pool replace the client.
    this.pool.on("error", (e) => console.error(`[pg pool] idle client error: ${e.message}`));
    this.schemaSafe = schema.replace(/[^a-zA-Z0-9_]/g, "");
    // every pooled connection joins the schema
    this.pool.on("connect", (client) => {
      client.query(`SET search_path TO ${this.schemaSafe}`).catch(() => { /* a broken connection fails the user query queued behind it */ });
    });
  }
  // Lazily (re)established: if the first connect/DDL fails (pg still starting, network
  // blip), the failure must NOT be cached forever; the next call retries from scratch,
  // so the indexer loop recovers as soon as Postgres does.
  private ready(): Promise<void> {
    if (this._ready) return this._ready;
    const p = (async () => {
      const c = await this.pool.connect();
      try {
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSafe}`);
        await c.query(`SET search_path TO ${this.schemaSafe}`);
        await c.query(DDL);
        await c.query("BEGIN");
        try {
          // The rebuild reads every outputs and address_history row, which grows with rows anyone can add: the 30 s cap
          // would fail every start. SET LOCAL lifts it for this transaction only (test/boot-rebuild-timeout.test.ts).
          await c.query("SET LOCAL statement_timeout = 0");
          for (const q of totalsRebuildSql(this.backend)) await c.query(q);
          await c.query("COMMIT");
        } catch (e) {
          try { await c.query("ROLLBACK"); } catch { /* connection gone */ }
          throw e;
        }
      } finally { c.release(); }
    })();
    this._ready = p;
    p.catch(() => { if (this._ready === p) this._ready = null; });
    return p;
  }
  // Bound the pending-acquire queue: if more than maxWaiting requests are already parked waiting
  // for a connection, fast-fail this one rather than join an unbounded line. (Each pg.query that
  // can't get an idle client enters the same _pendingQueue, so checking waitingCount covers
  // query() and connect() alike.)
  private acquireGuard(): void {
    if (this.pool.waitingCount >= this.maxWaiting)
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
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    await this.ready(); this.acquireGuard();
    const c = await this.pool.connect();
    const cs: Store = {
      backend: "postgres",
      exec: async (sql) => { await c.query(sql); },
      run: async (sql, ...p) => { await c.query(toPg(sql), p as unknown[]); },
      get: async (sql, ...p) => (await c.query(toPg(sql), p as unknown[])).rows[0],
      all: async (sql, ...p) => (await c.query(toPg(sql), p as unknown[])).rows,
      tx: () => { throw new Error("nested tx"); },
      checkpoint: async () => { /* autovacuum's job, as on the pool */ },
      close: async () => { /* the client goes back to the pool in this method's finally */ },
    };
    try {
      await c.query("BEGIN");
      const r = await fn(cs);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* connection gone */ }
      throw e;
    } finally { c.release(); }
  }
  async checkpoint(): Promise<void> { /* autovacuum's job */ }
  async close(): Promise<void> { await this.pool.end(); }
}

let _store: Store | null = null;

export function store(): Store {
  if (_store) return _store;
  _store = CFG.pg ? new PgStore(CFG.pg, CFG.pgSchema) : new SqliteStore(CFG.db);
  return _store;
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
  await s.exec(DDL);
  await s.tx(async (d) => { for (const q of totalsRebuildSql(d.backend)) await d.run(q); });
}

export async function getMeta(k: string): Promise<string | null> {
  const r = await store().get<{ value: string }>("SELECT value FROM meta WHERE key=?", k);
  return r?.value ?? null;
}
export async function setMeta(k: string, v: string): Promise<void> {
  await store().run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, v);
}
