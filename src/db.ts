// Relational store (node:sqlite — built into Node 22, no native dep). CSD's payload
// is relational (per-attester rows, address history, domain rankings, UTXO spends),
// which a relational engine models far better than a KV index — so we extend Cairn's
// sqlite scanner rather than adopt electrs's RocksDB (see docs/ecosystem/03).
//
// Reorg invariant: EVERY row carries `height`, so unwinding orphaned blocks is
// `DELETE ... WHERE height > ancestor` + un-spending outputs whose spender was
// orphaned. Nothing deeper than CONFIRMATIONS_FINAL is ever touched.
import { DatabaseSync } from "node:sqlite";
import { CFG } from "./config.js";

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  const d = new DatabaseSync(CFG.db);
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = OFF;

    -- One row per canonical block. prev links the chain (reorg detection); merkle
    -- is the header root that merkle proofs fold up to; orphaned marks a block that
    -- was unwound (kept for audit, excluded from queries).
    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL, prev TEXT, merkle TEXT,
      time INTEGER, bits INTEGER, nonce INTEGER, version INTEGER,
      tx_count INTEGER, chainwork TEXT, orphaned INTEGER DEFAULT 0
    );

    -- One row per tx. pos = position within the block (powers merkle proofs). app_type
    -- is Propose/Attest/Coinbase/Transfer; signer = hash160(pubkey) from input[0]; fee
    -- = sum(inputs)-sum(outputs), resolved against our own outputs table.
    CREATE TABLE IF NOT EXISTS txs (
      txid TEXT PRIMARY KEY, height INTEGER NOT NULL, pos INTEGER NOT NULL,
      app_type TEXT, signer TEXT, fee INTEGER, time INTEGER, n_in INTEGER, n_out INTEGER, coinbase INTEGER DEFAULT 0
    );

    -- Every output ever created. spent_txid set when consumed (UTXO model). addr is
    -- the p2pkh addr20. This backs /address/:a/utxo and fee resolution.
    CREATE TABLE IF NOT EXISTS outputs (
      txid TEXT NOT NULL, vout INTEGER NOT NULL, addr TEXT, value INTEGER,
      height INTEGER NOT NULL, spent_txid TEXT, spent_height INTEGER,
      PRIMARY KEY (txid, vout)
    );

    -- Every (address, txid) touch with a signed delta — backs /address/:a/txs.
    -- direction: 'in' (received) or 'out' (spent). One row per output / per spent input.
    CREATE TABLE IF NOT EXISTS address_history (
      addr TEXT NOT NULL, txid TEXT NOT NULL, height INTEGER NOT NULL,
      pos INTEGER, direction TEXT, delta INTEGER,
      PRIMARY KEY (addr, txid, direction, delta, pos)
    );

    -- Propose events (full, not aggregate).
    CREATE TABLE IF NOT EXISTS proposals (
      txid TEXT PRIMARY KEY, domain TEXT, payload_hash TEXT, uri TEXT,
      expires_epoch INTEGER, proposer TEXT, fee INTEGER, height INTEGER, time INTEGER
    );

    -- The per-attester data the node deliberately omits (aggregate-only on-chain).
    CREATE TABLE IF NOT EXISTS attestations (
      txid TEXT PRIMARY KEY, proposal_id TEXT, attester TEXT, score INTEGER,
      confidence INTEGER, fee INTEGER, height INTEGER, time INTEGER
    );

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE INDEX IF NOT EXISTS idx_txs_height       ON txs(height);
    CREATE INDEX IF NOT EXISTS idx_txs_signer       ON txs(signer);
    CREATE INDEX IF NOT EXISTS idx_out_addr         ON outputs(addr);
    CREATE INDEX IF NOT EXISTS idx_out_spent        ON outputs(spent_txid);
    CREATE INDEX IF NOT EXISTS idx_addrhist_addr    ON address_history(addr, height);
    CREATE INDEX IF NOT EXISTS idx_prop_domain      ON proposals(domain);
    CREATE INDEX IF NOT EXISTS idx_att_proposal     ON attestations(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_att_attester     ON attestations(attester);
  `);
  _db = d;
  return d;
}

// node:sqlite's DatabaseSync has no .transaction() helper (unlike better-sqlite3),
// so wrap BEGIN/COMMIT/ROLLBACK by hand. Synchronous: fn must not await.
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try { const r = fn(); d.exec("COMMIT"); return r; }
  catch (e) { try { d.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
}

export function closeDb(): void { if (_db) { _db.close(); _db = null; } }
export function checkpoint(): void { try { db().exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* busy */ } }

export function getMeta(k: string): string | null {
  const r = db().prepare("SELECT value FROM meta WHERE key=?").get(k) as { value: string } | undefined;
  return r?.value ?? null;
}
export function setMeta(k: string, v: string): void {
  db().prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);
}
