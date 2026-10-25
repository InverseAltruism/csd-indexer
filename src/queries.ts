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
// (~1e17 sats) exceeds 2^53; a high-value address must never 500 the API or corrupt silently.
// THE one copy since B8c (analytics.ts imports it; was defined near-verbatim in both files:
// this pass-through-number variant is canonical: it never throws on a weird store value where
// the old big()-normalizing twin would RangeError on a non-integer number).
export function amt(v: number | bigint | null | undefined): number | string {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
}
// Raw-row JSON safety: the store returns bigint for any integer past 2^53 (e.g. an
// attacker-chosen expires_epoch in a Propose payload). A stray bigint crashes
// JSON.stringify; one poisoned row must never 500 a whole endpoint, so every raw row
// that goes straight to res.json passes through here (bigint → decimal string).
function jsonSafe<T>(row: T): T {
  if (row == null || typeof row !== "object") return row;
  const o = row as Record<string, unknown>;
  for (const k of Object.keys(o)) if (typeof o[k] === "bigint") o[k] = String(o[k]);
  return row;
}
const jsonSafeAll = <T>(rows: T[]): T[] => { rows.forEach(jsonSafe); return rows; };
// height params arrive from URLs; only a non-negative safe integer can match a row,
// and anything else must 404, not 500 (pg would reject 1e21/2.5 as an int8 param).
const heightOk = (h: number): boolean => Number.isSafeInteger(h) && h >= 0;

// Canonical tip-row reader (B8c): ONE query shape for the three tip readers this repo carried
// (tipHeight here, analytics' tipRow/tipKey). Selecting the full row costs the same index walk
// as MAX(height) and every caller derives what it needs.
export async function tipRow(): Promise<{ height: number; hash: string; time: number; chainwork: string } | null> {
  return ((await store().get("SELECT height, hash, time, chainwork FROM blocks ORDER BY height DESC LIMIT 1")) as never) ?? null;
}
export async function tipHeight(): Promise<number> {
  return (await tipRow())?.height ?? -1;
}
export async function blockByHeight(h: number): Promise<BlockRow | null> {
  if (!heightOk(h)) return null;
  return jsonSafe(((await store().get<BlockRow>("SELECT * FROM blocks WHERE height=?", h)) as BlockRow) ?? null);
}
export async function blockByHash(hash: string): Promise<BlockRow | null> {
  return jsonSafe(((await store().get<BlockRow>("SELECT * FROM blocks WHERE hash=?", hash.toLowerCase())) as BlockRow) ?? null);
}
export async function recentBlocks(limit = 25): Promise<BlockRow[]> {
  return jsonSafeAll(await store().all<BlockRow>("SELECT * FROM blocks ORDER BY height DESC LIMIT ?", limit));
}
export async function blockTxids(height: number): Promise<string[]> {
  return (await store().all<{ txid: string }>("SELECT txid FROM txs WHERE height=? ORDER BY pos", height)).map(r => r.txid);
}
export async function tx(txid: string): Promise<TxRow | null> {
  return jsonSafe(((await store().get<TxRow>("SELECT * FROM txs WHERE txid=?", txid)) as TxRow) ?? null);
}
// The tx rows of one block in block order: one query, where a per-txid lookup would hold one pool
// connection per tx of the block.
export async function blockTxs(height: number): Promise<TxRow[]> {
  return jsonSafeAll(await store().all<TxRow>("SELECT * FROM txs WHERE height=? ORDER BY pos", height));
}
// Tx rows with their outputs for a list of txids, in the list's order (an unknown txid is left out),
// in two queries whatever the list length. Callers pass a page (at most addressTxids' limit), so the
// IN list stays far below both engines' bind-parameter limits.
export async function txsWithOutputs(txids: string[]): Promise<(TxRow & { outputs: OutRow[] })[]> {
  if (txids.length === 0) return [];
  const marks = txids.map(() => "?").join(",");
  const rows = jsonSafeAll(await store().all<TxRow>(`SELECT * FROM txs WHERE txid IN (${marks})`, ...txids));
  const outs = await store().all<OutRow>(`SELECT * FROM outputs WHERE txid IN (${marks}) ORDER BY txid, vout`, ...txids);
  const byTx = new Map<string, OutRow[]>();
  for (const o of outs) {
    const list = byTx.get(o.txid) ?? [];
    list.push({ ...o, value: amt(o.value as never) });
    byTx.set(o.txid, list);
  }
  const byId = new Map(rows.map((r) => [r.txid, r]));
  return txids.flatMap((id) => {
    const t = byId.get(id);
    return t ? [{ ...t, outputs: byTx.get(id) ?? [] }] : [];
  });
}

// Esplora-style address tx list: distinct txids touching addr, newest-first.
// CAIRN-IDX PAGINATION-DATALOSS-1: the keyset cursor is the FULL (height, txid) tuple matching the
// `height DESC, txid ASC` order; a height-only cursor silently DROPS the remaining same-height txids when
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

// Coinbase lifetime totals read from the maintained coinbase_totals table (db.ts), one row per address, with
// the indexed tip in the same statement so the figures and their height are one view on both backends.
// indexed_height is null on an empty index.
export interface CoinbaseTotal { address: string; outputs: number; value: number | string }
export async function addressCoinbase(addr: string): Promise<{ indexed_height: number | null } & CoinbaseTotal> {
  const a = addr.toLowerCase();
  const r = await store().get<{ indexed_height: number | null; outputs: number | bigint | null; value: number | bigint | null }>(
    "SELECT b.h AS indexed_height, c.outputs, c.value FROM (SELECT MAX(height) AS h FROM blocks) b LEFT JOIN coinbase_totals c ON c.addr = ?", a);
  return { address: a, outputs: Number(r?.outputs ?? 0), value: amt(r?.value), indexed_height: r?.indexed_height ?? null };
}
export const COINBASE_MINERS_LIMIT_MAX = 1000;
export async function coinbaseMiners(limit: number): Promise<{ indexed_height: number | null; miners: CoinbaseTotal[] }> {
  const rows = await store().all<{ indexed_height: number | null; addr: string | null; outputs: number | bigint | null; value: number | bigint | null }>(
    "SELECT b.h AS indexed_height, c.addr, c.outputs, c.value FROM (SELECT MAX(height) AS h FROM blocks) b " +
    "LEFT JOIN coinbase_totals c ON 1 = 1 ORDER BY c.outputs DESC, c.addr ASC LIMIT ?", limit);
  return {
    indexed_height: rows[0]?.indexed_height ?? null,
    miners: rows.filter((r) => r.addr != null).map((r) => ({ address: r.addr!, outputs: Number(r.outputs), value: amt(r.value) })),
  };
}

// ── CSD-specific (the reason this exists) ──
export async function proposal(id: string): Promise<any> { return jsonSafe((await store().get("SELECT * FROM proposals WHERE txid=?", id)) ?? null); }
export async function proposalsByDomain(domain: string, limit = 100, from?: number): Promise<any[]> {
  // clamp: callers (e.g. metaprotocol resolvers) may ask for the full domain history:
  // a resolver fed a truncated feed would silently lose its oldest records (deploys!)
  const lim = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), 10_000);
  // `from` = height cursor: rows at height >= from in ASCENDING order, so a resolver can page
  // the ENTIRE domain history deterministically (page until a short page; de-dup by txid at the
  // `from` boundary). Without `from`, the legacy newest-first window is preserved.
  //
  // I5 (O-4): this cursor is a PUBLIC GET (reachable through cairn's EXPLORER_READ allowlist), so it gets
  // heightOk, not a bare Number.isFinite, and it CLAMPS rather than refuses. Two defects that fixed:
  //   * `?from=1e21` passed isFinite and bound 1e21 as an int8 param, which pg REJECTS -> HTTP 500 (sqlite
  //     answered 200-empty, so the two backends disagreed on a public read).
  //   * `?from=abc` fell THROUGH to the legacy DESCENDING window while `?from=0` is ASCENDING, so one
  //     malformed cursor silently flipped the ordering contract and a consumer applying the short-page
  //     rule truncated its feed.
  // The presence of `from` now decides the branch and an unusable value clamps to 0: always ASCENDING, a
  // SUPERSET of what was asked for, never a truncation, and never a new 4xx on a currently-200 public GET.
  if (from !== undefined) {
    const f = Number(from);
    return jsonSafeAll(await store().all("SELECT * FROM proposals WHERE domain=? AND height>=? ORDER BY height ASC, txid ASC LIMIT ?",
      domain, heightOk(f) ? f : 0, lim));
  }
  return jsonSafeAll(await store().all("SELECT * FROM proposals WHERE domain=? ORDER BY height DESC, txid ASC LIMIT ?", domain, lim));
}
export async function attestationsFor(
  proposalId: string,
  opts: { limit?: number; afterHeight?: number; afterTxid?: string } = {},
): Promise<any[]> {
  // Bound the row count PER REQUEST (a hot proposal can accrue unlimited attests; inlined into
  // /proposal/:id one popular item could balloon every response). But the CairnX resolver REQUIRES the
  // COMPLETE list to replay fills/cancels/partial-fills deterministically; a silent truncation would
  // diverge ledger state; so this also supports a keyset cursor (afterHeight, afterTxid) over the same
  // (height, txid) ASC order, letting a consumer page through ALL rows in bounded chunks. txids are
  // lowercase 0x-hex, so byte-wise `txid > ?` matches the ORDER BY under every collation.
  const n = Number(opts.limit);
  const lim = Math.min(Math.max(1, Number.isFinite(n) ? Math.floor(n) : 5_000), 50_000); // 0/NaN→5000, <1→1
  const cols = "proposal_id, attester, score, confidence, fee, txid, height, time";
  // I5 (O-4): same public-cursor treatment as proposalsByDomain's `from`. An `?after_height=1e21` passed the
  // route's isFinite check and bound 1e21 as an int8 param, which pg REJECTS -> HTTP 500 on a public GET.
  // An unusable cursor now DROPS to the uncursored ascending page below: a superset of the requested page,
  // never a truncation, and no new 4xx on a read that answers 200 today.
  const ah = Number(opts.afterHeight);
  if (opts.afterHeight !== undefined && opts.afterTxid !== undefined && heightOk(ah)) {
    return jsonSafeAll(await store().all(
      `SELECT ${cols} FROM attestations WHERE proposal_id=? AND (height > ? OR (height = ? AND txid > ?)) ORDER BY height, txid LIMIT ?`,
      proposalId, ah, ah, String(opts.afterTxid).toLowerCase(), lim));
  }
  return jsonSafeAll(await store().all(
    `SELECT ${cols} FROM attestations WHERE proposal_id=? ORDER BY height, txid LIMIT ?`, proposalId, lim));
}
export async function attestationCountFor(proposalId: string): Promise<number> {
  return Number((await store().get<{ n: number }>("SELECT COUNT(*) n FROM attestations WHERE proposal_id=?", proposalId))?.n ?? 0);
}
// /address/:a/reputation aggregates over at most this many of an attester's newest attestations.
export const REPUTATION_WINDOW = 200;
export async function attestationsBy(addr: string, limit: number): Promise<any[]> {
  return jsonSafeAll(await store().all("SELECT * FROM attestations WHERE attester=? ORDER BY height DESC, txid ASC LIMIT ?", addr.toLowerCase(), limit));
}
export async function domains(): Promise<{ domain: string; proposals: number }[]> {
  const rows = await store().all<{ domain: string; proposals: number | bigint }>("SELECT domain, COUNT(*) proposals FROM proposals GROUP BY domain ORDER BY proposals DESC, domain ASC");
  return rows.map((r) => ({ domain: r.domain, proposals: Number(r.proposals) }));
}
export async function counts(): Promise<{ blocks: number; txs: number; proposals: number; attestations: number }> {
  const c = async (t: string, w = "") => Number((await store().get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} ${w}`))?.n ?? 0);
  return { blocks: await c("blocks"), txs: await c("txs"), proposals: await c("proposals"), attestations: await c("attestations") };
}

// ── chain-order feeds (the reads that replace cairn's chain.db scanner) ──
// The lowest-height block whose time is at or after `time`, with the tip in the same statement so a
// caller's depth rule (cutoff at least N below the tip) reads one consistent view. Block times are not
// monotonic, so this is a MIN over heights, not the block after the last one at or before `time`. The unary
// plus keeps sqlite from answering MIN by walking the height key from genesis; the time index is read instead
// (test/schema-indexes.test.ts).
export const BLOCK_AT_OR_AFTER_SQL =
  "SELECT b.height, b.hash, b.time, (SELECT MAX(height) FROM blocks) AS tip_height FROM blocks b " +
  "WHERE b.height = (SELECT MIN(+height) FROM blocks WHERE time >= ?)";
export async function blockAtOrAfter(time: number): Promise<{ height: number; hash: string; time: number; tip_height: number } | null> {
  if (!heightOk(time)) return null;
  return jsonSafe((await store().get(BLOCK_AT_OR_AFTER_SQL, time)) as never) ?? null;
}

export const FEED_LIMIT_MAX = 1000;
export type FeedKind = "proposals" | "attestations";
export interface FeedAt { height: number; hash: string }
export interface FeedCursor { height: number; pos: number }
export type FeedPage =
  | { ok: true; at: FeedAt; rows: Record<string, unknown>[] }
  | { ok: false; reason: "empty-index" | "snapshot-gone" };

const FEED_SOURCE: Record<FeedKind, (domain: boolean) => string> = {
  proposals: (domain) =>
    "SELECT p.txid, p.domain, p.payload_hash, p.uri, p.expires_epoch, p.proposer, p.fee, p.height, p.time, t.pos " +
    `FROM proposals p JOIN txs t ON t.txid = p.txid${domain ? " WHERE p.domain = ?" : ""}`,
  attestations: (domain) =>
    "SELECT a.txid, a.proposal_id, a.attester, a.score, a.confidence, a.fee, a.height, a.time, t.pos " +
    `FROM attestations a JOIN txs t ON t.txid = a.txid${domain ? " JOIN proposals p ON p.txid = a.proposal_id WHERE p.domain = ?" : ""}`,
};

/**
 * One page of proposals or attestations (optionally only those of one domain's proposals) in chain order,
 * (height, position in block), limited to rows at or below a snapshot block. The snapshot is the tip when
 * `at` is null, else the block at `at.height`, which must still carry `at.hash`: every row at or below it
 * then comes from the chain that hash commits to, so a keyset walk under one snapshot neither skips nor
 * repeats, and a reorg at or below the snapshot answers snapshot-gone instead of a mixed list. The snapshot
 * check and the rows are one statement (one view on both backends); the LEFT JOIN keeps the snapshot row
 * when no record matches, so an empty page and a missing snapshot block stay distinguishable.
 */
export async function feedPage(
  kind: FeedKind, o: { domain: string | null; at: { height: number; hash: string | null } | null; after: FeedCursor | null; limit: number },
): Promise<FeedPage> {
  const after = o.after ?? { height: -1, pos: -1 };
  const snap = o.at ? "?" : "(SELECT MAX(height) FROM blocks)";
  const sql =
    `SELECT s.height AS at_height, s.hash AS at_hash, r.* FROM blocks s LEFT JOIN (${FEED_SOURCE[kind](o.domain !== null)}) r ` +
    `ON r.height <= s.height AND (r.height > ? OR (r.height = ? AND r.pos > ?)) WHERE s.height = ${snap} ORDER BY r.height, r.pos LIMIT ?`;
  const params: unknown[] = [];
  if (o.domain !== null) params.push(o.domain);
  params.push(after.height, after.height, after.pos);
  if (o.at) params.push(o.at.height);
  params.push(o.limit);
  const raw = await store().all<Record<string, unknown>>(sql, ...params);
  const first = raw[0];
  if (!first) return { ok: false, reason: o.at ? "snapshot-gone" : "empty-index" };
  const at = { height: Number(first.at_height), hash: String(first.at_hash) };
  if (o.at?.hash != null && at.hash !== o.at.hash.toLowerCase()) return { ok: false, reason: "snapshot-gone" };
  const rows = raw.filter((r) => r.txid != null).map(({ at_height: _h, at_hash: _x, ...r }) => jsonSafe(r));
  return { ok: true, at, rows };
}
