// Read-side queries backing the REST API. Pure functions over the indexed DB; every
// result is recomputable by anyone re-running the indexer (determinism is the audit).
//
// Integer columns arrive from the store as number-when-exact / bigint-past-2^53 (see
// db.ts); amt() turns the big ones into decimal strings so JSON never sees a BigInt.
import { store } from "./db.js";

export interface BlockRow { height: number; hash: string; prev: string; merkle: string; time: number; bits: number; nonce: number; version: number; tx_count: number; chainwork: string; }
export interface TxRow { txid: string; height: number; pos: number; app_type: string; signer: string; fee: number; time: number; n_in: number; n_out: number; coinbase: number; }
export interface OutRow { txid: string; vout: number; addr: string; value: number | string; height: number; spent_txid: string | null; spent_height: number | null; }

// Serialize a sats amount: a JS number when it fits exactly, else a decimal string. CSD max supply
// (~1e17 sats) exceeds 2^53 — a high-value address must never 500 the API or corrupt silently.
// THE one copy since B8c (analytics.ts imports it; was defined near-verbatim in both files —
// this pass-through-number variant is canonical: it never throws on a weird store value where
// the old big()-normalizing twin would RangeError on a non-integer number).
export function amt(v: number | bigint | null | undefined): number | string {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
}
// Raw-row JSON safety: the store returns bigint for any integer past 2^53 (e.g. an
// attacker-chosen expires_epoch in a Propose payload). A stray bigint crashes
// JSON.stringify — one poisoned row must never 500 a whole endpoint, so every raw row
// that goes straight to res.json passes through here (bigint → decimal string).
function jsonSafe<T>(row: T): T {
  if (row == null || typeof row !== "object") return row;
  const o = row as Record<string, unknown>;
  for (const k of Object.keys(o)) if (typeof o[k] === "bigint") o[k] = String(o[k]);
  return row;
}
const jsonSafeAll = <T>(rows: T[]): T[] => { rows.forEach(jsonSafe); return rows; };
// height params arrive from URLs — only a non-negative safe integer can match a row,
// and anything else must 404, not 500 (pg would reject 1e21/2.5 as an int8 param).
const heightOk = (h: number): boolean => Number.isSafeInteger(h) && h >= 0;

// Canonical tip-row reader (B8c): ONE query shape for the three tip readers this repo carried
// (tipHeight here, analytics' tipRow/tipKey). Selecting the full row costs the same index walk
// as MAX(height) and every caller derives what it needs.
export async function tipRow(): Promise<{ height: number; hash: string; time: number; chainwork: string } | null> {
  return ((await store().get("SELECT height, hash, time, chainwork FROM blocks WHERE orphaned=0 ORDER BY height DESC LIMIT 1")) as never) ?? null;
}
export async function tipHeight(): Promise<number> {
  return (await tipRow())?.height ?? -1;
}
export async function blockByHeight(h: number): Promise<BlockRow | null> {
  if (!heightOk(h)) return null;
  return jsonSafe(((await store().get<BlockRow>("SELECT * FROM blocks WHERE height=? AND orphaned=0", h)) as BlockRow) ?? null);
}
export async function blockByHash(hash: string): Promise<BlockRow | null> {
  return jsonSafe(((await store().get<BlockRow>("SELECT * FROM blocks WHERE hash=? AND orphaned=0", hash.toLowerCase())) as BlockRow) ?? null);
}
export async function recentBlocks(limit = 25): Promise<BlockRow[]> {
  return jsonSafeAll(await store().all<BlockRow>("SELECT * FROM blocks WHERE orphaned=0 ORDER BY height DESC LIMIT ?", limit));
}
export async function blockTxids(height: number): Promise<string[]> {
  return (await store().all<{ txid: string }>("SELECT txid FROM txs WHERE height=? ORDER BY pos", height)).map(r => r.txid);
}
export async function tx(txid: string): Promise<TxRow | null> {
  return jsonSafe(((await store().get<TxRow>("SELECT * FROM txs WHERE txid=?", txid)) as TxRow) ?? null);
}
export async function txOutputs(txid: string): Promise<OutRow[]> {
  const rows = await store().all<OutRow>("SELECT * FROM outputs WHERE txid=? ORDER BY vout", txid);
  return rows.map((r) => ({ ...r, value: amt(r.value as never) }));
}

// Esplora-style address tx list: distinct txids touching addr, newest-first.
// CAIRN-IDX PAGINATION-DATALOSS-1: the keyset cursor is the FULL (height, txid) tuple matching the
// `height DESC, txid ASC` order — a height-only cursor silently DROPS the remaining same-height txids when
// one block has more than `limit` txids touching the address (a busy treasury/faucet/exchange address):
// page 1 fills with `limit` rows all at height H, the next page `height < H` skips the rest of H forever.
// Mirrors the (height, txid) keyset attestationsFor already uses.
export async function addressTxids(
  addr: string,
  cursor: { height: number; txid: string } | null,
  limit = 25,
): Promise<{ txid: string; height: number }[]> {
  const a = addr.toLowerCase();
  if (cursor == null) {
    return await store().all("SELECT DISTINCT txid, height FROM address_history WHERE addr=? ORDER BY height DESC, txid LIMIT ?", a, limit) as never;
  }
  return await store().all(
    "SELECT DISTINCT txid, height FROM address_history WHERE addr=? AND (height < ? OR (height = ? AND txid > ?)) ORDER BY height DESC, txid LIMIT ?",
    a, cursor.height, cursor.height, cursor.txid.toLowerCase(), limit) as never;
}
// Height at which a given txid touches an address (for resolving an Esplora last-seen-txid page cursor).
export async function addressTxidHeight(addr: string, txid: string): Promise<number | null> {
  const r = await store().get<{ height: number }>(
    "SELECT height FROM address_history WHERE addr=? AND txid=? LIMIT 1", addr.toLowerCase(), txid.toLowerCase());
  return r ? Number(r.height) : null;
}
export async function addressUtxos(addr: string): Promise<OutRow[]> {
  // bounded result; value already arrives exact (number or bigint) from the store
  const rows = await store().all<OutRow>("SELECT * FROM outputs WHERE addr=? AND spent_txid IS NULL ORDER BY height, txid, vout LIMIT 100000", addr.toLowerCase());
  return rows.map((r) => ({ ...r, value: amt(r.value as never) }));
}
export async function addressStats(addr: string): Promise<{ funded: number | string; spent: number | string; balance: number | string; tx_count: number }> {
  const a = addr.toLowerCase();
  const funded = (await store().get<{ v: number | bigint }>("SELECT COALESCE(SUM(value),0) v FROM outputs WHERE addr=?", a))?.v ?? 0;
  const spent = (await store().get<{ v: number | bigint }>("SELECT COALESCE(SUM(value),0) v FROM outputs WHERE addr=? AND spent_txid IS NOT NULL", a))?.v ?? 0;
  const txc = (await store().get<{ n: number }>("SELECT COUNT(DISTINCT txid) n FROM address_history WHERE addr=?", a))?.n ?? 0;
  return { funded: amt(funded), spent: amt(spent), balance: amt(BigInt(funded) - BigInt(spent)), tx_count: Number(txc) };
}

// ── CSD-specific (the reason this exists) ──
export async function proposal(id: string): Promise<any> { return jsonSafe((await store().get("SELECT * FROM proposals WHERE txid=?", id)) ?? null); }
export async function proposalsByDomain(domain: string, limit = 100, from?: number): Promise<any[]> {
  // clamp: callers (e.g. metaprotocol resolvers) may ask for the full domain history —
  // a resolver fed a truncated feed would silently lose its oldest records (deploys!)
  const lim = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), 10_000);
  // `from` = height cursor: rows at height >= from in ASCENDING order, so a resolver can page
  // the ENTIRE domain history deterministically (page until a short page; de-dup by txid at the
  // `from` boundary). Without `from`, the legacy newest-first window is preserved.
  if (from !== undefined && Number.isFinite(Number(from))) {
    return jsonSafeAll(await store().all("SELECT * FROM proposals WHERE domain=? AND height>=? ORDER BY height ASC, txid ASC LIMIT ?",
      domain, Math.max(0, Math.floor(Number(from))), lim));
  }
  return jsonSafeAll(await store().all("SELECT * FROM proposals WHERE domain=? ORDER BY height DESC, txid ASC LIMIT ?", domain, lim));
}
export async function attestationsFor(
  proposalId: string,
  opts: { limit?: number; afterHeight?: number; afterTxid?: string } = {},
): Promise<any[]> {
  // Bound the row count PER REQUEST (a hot proposal can accrue unlimited attests; inlined into
  // /proposal/:id one popular item could balloon every response). But the CairnX resolver REQUIRES the
  // COMPLETE list to replay fills/cancels/partial-fills deterministically — a silent truncation would
  // diverge ledger state — so this also supports a keyset cursor (afterHeight, afterTxid) over the same
  // (height, txid) ASC order, letting a consumer page through ALL rows in bounded chunks. txids are
  // lowercase 0x-hex, so byte-wise `txid > ?` matches the ORDER BY under every collation.
  const n = Number(opts.limit);
  const lim = Math.min(Math.max(1, Number.isFinite(n) ? Math.floor(n) : 5_000), 50_000); // 0/NaN→5000, <1→1
  const cols = "proposal_id, attester, score, confidence, fee, txid, height, time";
  if (opts.afterHeight !== undefined && opts.afterTxid !== undefined) {
    return jsonSafeAll(await store().all(
      `SELECT ${cols} FROM attestations WHERE proposal_id=? AND (height > ? OR (height = ? AND txid > ?)) ORDER BY height, txid LIMIT ?`,
      proposalId, Math.floor(Number(opts.afterHeight)), Math.floor(Number(opts.afterHeight)), String(opts.afterTxid), lim));
  }
  return jsonSafeAll(await store().all(
    `SELECT ${cols} FROM attestations WHERE proposal_id=? ORDER BY height, txid LIMIT ?`, proposalId, lim));
}
export async function attestationsBy(addr: string, limit = 200): Promise<any[]> {
  return jsonSafeAll(await store().all("SELECT * FROM attestations WHERE attester=? ORDER BY height DESC, txid ASC LIMIT ?", addr.toLowerCase(), limit));
}
export async function domains(): Promise<{ domain: string; proposals: number }[]> {
  const rows = await store().all<{ domain: string; proposals: number | bigint }>("SELECT domain, COUNT(*) proposals FROM proposals GROUP BY domain ORDER BY proposals DESC, domain ASC");
  return rows.map((r) => ({ domain: r.domain, proposals: Number(r.proposals) }));
}
export async function counts(): Promise<{ blocks: number; txs: number; proposals: number; attestations: number }> {
  const c = async (t: string, w = "") => Number((await store().get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} ${w}`))?.n ?? 0);
  return { blocks: await c("blocks", "WHERE orphaned=0"), txs: await c("txs"), proposals: await c("proposals"), attestations: await c("attestations") };
}
