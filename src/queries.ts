// Read-side queries backing the REST API. Pure functions over the indexed DB; every
// result is recomputable by anyone re-running the indexer (determinism is the audit).
import { db } from "./db.js";

export interface BlockRow { height: number; hash: string; prev: string; merkle: string; time: number; bits: number; nonce: number; version: number; tx_count: number; chainwork: string; }
export interface TxRow { txid: string; height: number; pos: number; app_type: string; signer: string; fee: number; time: number; n_in: number; n_out: number; coinbase: number; }
export interface OutRow { txid: string; vout: number; addr: string; value: number; height: number; spent_txid: string | null; spent_height: number | null; }

export function tipHeight(): number {
  const r = db().prepare("SELECT MAX(height) h FROM blocks WHERE orphaned=0").get() as { h: number | null };
  return r.h ?? -1;
}
export function blockByHeight(h: number): BlockRow | null {
  return (db().prepare("SELECT * FROM blocks WHERE height=? AND orphaned=0").get(h) as unknown as BlockRow) ?? null;
}
export function blockByHash(hash: string): BlockRow | null {
  return (db().prepare("SELECT * FROM blocks WHERE hash=? AND orphaned=0").get(hash.toLowerCase()) as unknown as BlockRow) ?? null;
}
export function recentBlocks(limit = 25): BlockRow[] {
  return db().prepare("SELECT * FROM blocks WHERE orphaned=0 ORDER BY height DESC LIMIT ?").all(limit) as unknown as BlockRow[];
}
export function blockTxids(height: number): string[] {
  return (db().prepare("SELECT txid FROM txs WHERE height=? ORDER BY pos").all(height) as { txid: string }[]).map(r => r.txid);
}
export function tx(txid: string): TxRow | null {
  return (db().prepare("SELECT * FROM txs WHERE txid=?").get(txid) as unknown as TxRow) ?? null;
}
export function txOutputs(txid: string): OutRow[] {
  return db().prepare("SELECT * FROM outputs WHERE txid=? ORDER BY vout").all(txid) as unknown as OutRow[];
}

// Esplora-style address tx list: distinct txids touching addr, newest-first, cursor by height.
export function addressTxids(addr: string, beforeHeight: number | null, limit = 25): { txid: string; height: number }[] {
  const a = addr.toLowerCase();
  if (beforeHeight == null) {
    return db().prepare("SELECT DISTINCT txid, height FROM address_history WHERE addr=? ORDER BY height DESC, txid LIMIT ?").all(a, limit) as any;
  }
  return db().prepare("SELECT DISTINCT txid, height FROM address_history WHERE addr=? AND height<? ORDER BY height DESC, txid LIMIT ?").all(a, beforeHeight, limit) as any;
}
export function addressUtxos(addr: string): OutRow[] {
  // bounded result + BigInt-safe value read (a single >2^53-sat output must not throw)
  const st = db().prepare("SELECT * FROM outputs WHERE addr=? AND spent_txid IS NULL ORDER BY height LIMIT 100000");
  st.setReadBigInts(true);
  const rows = st.all(addr.toLowerCase()) as any[];
  // setReadBigInts makes ALL integer columns BigInt → convert small ones back to Number (vout/
  // height) and keep value BigInt-safe via amt(); a stray BigInt would crash JSON.stringify.
  return rows.map((r) => ({
    ...r,
    vout: Number(r.vout),
    value: amt(r.value as bigint),
    height: Number(r.height),
    spent_height: r.spent_height == null ? null : Number(r.spent_height),
  })) as unknown as OutRow[];
}
// Serialize a sats amount: a JS number when it fits exactly, else a decimal string. CSD max supply
// (~1e17 sats) exceeds 2^53, and node:sqlite THROWS ERR_OUT_OF_RANGE reading an integer past
// MAX_SAFE_INTEGER — so we read these as BigInt and never let a high-value address 500 the API.
function amt(v: bigint): number | string {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
}
export function addressStats(addr: string): { funded: number | string; spent: number | string; balance: number | string; tx_count: number } {
  const a = addr.toLowerCase();
  const sumBig = (sql: string): bigint => {
    const st = db().prepare(sql);
    st.setReadBigInts(true);
    return (st.get(a) as { v: bigint }).v;
  };
  const funded = sumBig("SELECT COALESCE(SUM(value),0) v FROM outputs WHERE addr=?");
  const spent = sumBig("SELECT COALESCE(SUM(value),0) v FROM outputs WHERE addr=? AND spent_txid IS NOT NULL");
  const txc = (db().prepare("SELECT COUNT(DISTINCT txid) n FROM address_history WHERE addr=?").get(a) as { n: number }).n;
  return { funded: amt(funded), spent: amt(spent), balance: amt(funded - spent), tx_count: txc };
}

// ── CSD-specific (the reason this exists) ──
export function proposal(id: string): any { return db().prepare("SELECT * FROM proposals WHERE txid=?").get(id) ?? null; }
export function proposalsByDomain(domain: string, limit = 100): any[] {
  // clamp: callers (e.g. metaprotocol resolvers) may ask for the full domain history —
  // a resolver fed a truncated feed would silently lose its oldest records (deploys!)
  const lim = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), 10_000);
  return db().prepare("SELECT * FROM proposals WHERE domain=? ORDER BY height DESC LIMIT ?").all(domain, lim) as any[];
}
export function attestationsFor(proposalId: string): any[] {
  return db().prepare("SELECT proposal_id, attester, score, confidence, fee, txid, height, time FROM attestations WHERE proposal_id=? ORDER BY height").all(proposalId) as any[];
}
export function attestationsBy(addr: string, limit = 200): any[] {
  return db().prepare("SELECT * FROM attestations WHERE attester=? ORDER BY height DESC LIMIT ?").all(addr.toLowerCase(), limit) as any[];
}
export function domains(): { domain: string; proposals: number }[] {
  return db().prepare("SELECT domain, COUNT(*) proposals FROM proposals GROUP BY domain ORDER BY proposals DESC").all() as any[];
}
export function counts(): { blocks: number; txs: number; proposals: number; attestations: number } {
  const c = (t: string, w = "") => (db().prepare(`SELECT COUNT(*) n FROM ${t} ${w}`).get() as { n: number }).n;
  return { blocks: c("blocks", "WHERE orphaned=0"), txs: c("txs"), proposals: c("proposals"), attestations: c("attestations") };
}
