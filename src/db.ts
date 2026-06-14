// Relational store with two interchangeable backends behind ONE async interface:
//
//   - sqlite (node:sqlite, built into Node 22 — no native dep, no build step). The
//     DEFAULT: zero-config, perfect for one operator / CI / third parties re-running
//     the index to audit determinism.
//   - Postgres (`pg` pool), selected by CSD_INDEX_PG=postgres://... — the scale path.
//     node:sqlite is SYNCHRONOUS: every query blocks the event loop, so concurrent
//     readers serialize behind each other and behind the block writer. Postgres moves
//     queries off-loop onto a pool, which is what lets the API keep answering while
//     blocks are being written.
//
// CSD's payload is relational (per-attester rows, address history, domain rankings,
// UTXO spends), which a relational engine models far better than a KV index — so we
// extend Cairn's sqlite scanner rather than adopt electrs's RocksDB (see docs/ecosystem/03).
//
// Reorg invariant: EVERY row carries `height`, so unwinding orphaned blocks is
// `DELETE ... WHERE height > ancestor` + un-spending outputs whose spender was
// orphaned. Nothing deeper than CONFIRMATIONS_FINAL is ever touched.
//
// Number policy (both backends): 64-bit integer columns are read EXACTLY — values
// within Number.MAX_SAFE_INTEGER come back as `number`, anything past 2^53 comes back
// as `bigint` (never silently truncated, never thrown). Callers that serialize amounts
// use amt()-style helpers to keep JSON clean.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { CFG } from "./config.js";

// CJS require shim for the lazy `pg` import (we run as ESM via tsx); keeps pg
// optional at runtime for sqlite-only users.
const require = createRequire(import.meta.url);

/** number when exact, bigint when past 2^53 — never lossy. */
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
const DDL = `
  CREATE TABLE IF NOT EXISTS blocks (
    height BIGINT PRIMARY KEY,
    hash TEXT NOT NULL, prev TEXT, merkle TEXT,
    time BIGINT, bits BIGINT, nonce BIGINT, version INTEGER,
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
`;

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
  // store call (a microtask — the event loop cannot run I/O callbacks until the microtask
  // chain drains). Adding `await fetch(...)`/fs/timers inside a dbTx callback would let
  // readers interleave on this SAME connection and see uncommitted rows. Don't.
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    this.d.exec("BEGIN");
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
  constructor(url: string, schema: string) {
    const { Pool, types } = require("pg") as typeof import("pg");
    // Exact integer reads, same policy as the sqlite backend: int8 (OID 20) and the
    // NUMERIC (OID 1700) that SUM(bigint) yields come back as number within 2^53,
    // bigint past it (the sums here are integral — sats, counts, heights).
    const exactParser = (v: string) => exact(BigInt(v));
    const perPool = {
      getTypeParser: (oid: number, format?: string) =>
        oid === 20 || oid === 1700 ? exactParser : (types.getTypeParser as (o: number, f?: string) => unknown)(oid, format),
    } as unknown as import("pg").CustomTypesConfig;
    this.pool = new Pool({
      connectionString: url, max: CFG.pgPoolSize, types: perPool,
      // never queue forever: a saturated pool should error a request, not hang it
      connectionTimeoutMillis: 10_000,
      // server-side guards: no runaway query can starve the block writer, and an
      // abandoned BEGIN can't hold locks forever
      options: "-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
    });
    // pg-pool EMITS 'error' for connection failures on IDLE pooled clients (server
    // restart, idle kill, network blip). With no listener that's an uncaught exception
    // that takes the whole process down — log and let the pool replace the client.
    this.pool.on("error", (e) => console.error(`[pg pool] idle client error: ${e.message}`));
    this.schemaSafe = schema.replace(/[^a-zA-Z0-9_]/g, "");
    // every pooled connection joins the schema; errors here surface on the user query
    this.pool.on("connect", (client) => { client.query(`SET search_path TO ${this.schemaSafe}`).catch(() => {}); });
  }
  // Lazily (re)established: if the first connect/DDL fails (pg still starting, network
  // blip), the failure must NOT be cached forever — the next call retries from scratch,
  // so the indexer loop recovers as soon as Postgres does.
  private ready(): Promise<void> {
    if (this._ready) return this._ready;
    const p = (async () => {
      const c = await this.pool.connect();
      try {
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSafe}`);
        await c.query(`SET search_path TO ${this.schemaSafe}`);
        await c.query(DDL);
      } finally { c.release(); }
    })();
    this._ready = p;
    p.catch(() => { if (this._ready === p) this._ready = null; });
    return p;
  }
  async exec(sql: string): Promise<void> { await this.ready(); await this.pool.query(sql); }
  async run(sql: string, ...params: unknown[]): Promise<void> {
    await this.ready(); await this.pool.query(toPg(sql), params as unknown[]);
  }
  async get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    await this.ready();
    const r = await this.pool.query(toPg(sql), params as unknown[]);
    return r.rows[0] as T | undefined;
  }
  async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    await this.ready();
    const r = await this.pool.query(toPg(sql), params as unknown[]);
    return r.rows as T[];
  }
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    await this.ready();
    const c = await this.pool.connect();
    const cs: Store = {
      backend: "postgres",
      exec: async (sql) => { await c.query(sql); },
      run: async (sql, ...p) => { await c.query(toPg(sql), p as unknown[]); },
      get: async (sql, ...p) => (await c.query(toPg(sql), p as unknown[])).rows[0],
      all: async (sql, ...p) => (await c.query(toPg(sql), p as unknown[])).rows,
      tx: () => { throw new Error("nested tx"); },
      checkpoint: async () => {},
      close: async () => {},
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
  for (const t of ["address_history", "attestations", "proposals", "outputs", "txs", "blocks", "meta"]) {
    await s.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await s.exec(DDL);
}

export async function getMeta(k: string): Promise<string | null> {
  const r = await store().get<{ value: string }>("SELECT value FROM meta WHERE key=?", k);
  return r?.value ?? null;
}
export async function setMeta(k: string, v: string): Promise<void> {
  await store().run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, v);
}
