// Read-side queries backing the REST API. Pure functions over the indexed DB; every
// result is recomputable by anyone re-running the indexer (determinism is the audit).
//
// Integer columns arrive from the store as number-when-exact / bigint-past-2^53 (see
// db.ts); amt() turns the big ones into decimal strings so JSON never sees a BigInt.
import { store, joinSum } from "./db.js";

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
// A block's (txid, pos) list: its txs rows plus its tx_repeats rows, the positions whose txid has its row at an
// earlier place (indexer.ts writeBlock). `h` is the height expression, used twice: "?" binds the height twice.
export const BLOCK_TX_LIST = (h: string) => `(SELECT txid, pos FROM txs WHERE height=${h} UNION ALL SELECT txid, pos FROM tx_repeats WHERE height=${h})`;
export async function blockTxids(height: number): Promise<string[]> {
  return (await store().all<{ txid: string }>(`SELECT txid FROM ${BLOCK_TX_LIST("?")} b ORDER BY pos`, height, height)).map(r => r.txid);
}
export async function tx(txid: string): Promise<TxRow | null> {
  return jsonSafe(((await store().get<TxRow>("SELECT * FROM txs WHERE txid=?", txid)) as TxRow) ?? null);
}
/** A tx's height and the indexed tip, in one statement; null for an unknown txid. */
export async function txStatus(txid: string): Promise<{ height: number; tip_height: number } | null> {
  const r = await store().get<{ height: number; tip_height: number }>(
    "SELECT t.height, (SELECT MAX(height) FROM blocks) AS tip_height FROM txs t WHERE t.txid=?", txid);
  return r ? { height: Number(r.height), tip_height: Number(r.tip_height ?? -1) } : null;
}
// The tx rows of one block in block order: one query, where a per-txid lookup would hold one pool
// connection per tx of the block. Each row is the txid's one row (`tx`), so a position listed in tx_repeats
// carries the height and pos of the txid's first occurrence.
export async function blockTxs(height: number): Promise<TxRow[]> {
  return jsonSafeAll(await store().all<TxRow>(`SELECT t.* FROM ${BLOCK_TX_LIST("?")} b JOIN txs t ON t.txid = b.txid ORDER BY b.pos`, height, height));
}
// The routes' reads of a block's list by its hash, each one statement (one view on both backends): a block a reorg
// removes answers null, never an empty list or another block's list under its hash. A block holding no
// transaction is one row with a null txid.
const BY_HASH = "(SELECT height FROM blocks WHERE hash = ?)";
const blockListByHash = (cols: string, join: string) =>
  `SELECT b.height AS block_height, ${cols} FROM blocks b LEFT JOIN ${BLOCK_TX_LIST(BY_HASH)} l ON 1 = 1 ${join} WHERE b.hash = ? ORDER BY l.pos`;
export async function blockTxidsByHash(hash: string): Promise<string[] | null> {
  const h = hash.toLowerCase();
  const rows = await store().all<{ txid: string | null }>(blockListByHash("l.txid", ""), h, h, h);
  return rows.length ? rows.flatMap((r) => (r.txid == null ? [] : [r.txid])) : null;
}
export async function blockTxsByHash(hash: string): Promise<TxRow[] | null> {
  const h = hash.toLowerCase();
  const rows = await store().all<Record<string, unknown>>(blockListByHash("t.*", "LEFT JOIN txs t ON t.txid = l.txid"), h, h, h);
  return rows.length ? rows.flatMap(({ block_height: _b, ...t }) => (t.txid == null ? [] : [jsonSafe(t as unknown as TxRow)])) : null;
}

// Tx rows with their outputs, in one statement: `page` is a statement whose rows are (txid, ord), the txids in the
// answer's order (an unknown txid is left out). One statement is one view on both backends, so a reorg's commit
// cannot land between a tx row and its outputs (an `outputs: []` for a tx that has outputs). Callers pass a page (at
// most addressTxids' limit), so an IN list stays far below both engines' bind-parameter limits.
const OUT_COLS = ["vout", "addr", "value", "height", "spent_txid", "spent_height"] as const;
async function txsWithOutputsOf(page: string, params: unknown[]): Promise<(TxRow & { outputs: OutRow[] })[]> {
  const raw = await store().all<Record<string, unknown>>(
    `SELECT t.*, ${OUT_COLS.map((c) => `o.${c} AS out_${c}`).join(", ")} FROM (${page}) p JOIN txs t ON t.txid = p.txid ` +
    "LEFT JOIN outputs o ON o.txid = t.txid ORDER BY p.ord, o.vout", ...params);
  const out: (TxRow & { outputs: OutRow[] })[] = [];
  for (const r of raw) {
    const row: Record<string, unknown> = {}, o: Record<string, unknown> = { txid: r.txid };
    for (const [k, v] of Object.entries(r)) if (k.startsWith("out_")) o[k.slice(4)] = v; else row[k] = v;
    if (out[out.length - 1]?.txid !== row.txid) out.push({ ...jsonSafe(row as unknown as TxRow), outputs: [] });
    if (o.vout != null) out[out.length - 1]!.outputs.push({ ...(o as unknown as OutRow), value: amt(o.value as never) });
  }
  return out;
}
export async function txsWithOutputs(txids: string[]): Promise<(TxRow & { outputs: OutRow[] })[]> {
  if (txids.length === 0) return [];
  return txsWithOutputsOf(txids.map((_, i) => `SELECT CAST(? AS TEXT) AS txid, ${i} AS ord`).join(" UNION ALL "), txids);
}

// Esplora-style address tx list: distinct txids touching addr, newest-first.
// CAIRN-IDX PAGINATION-DATALOSS-1: the keyset cursor is the FULL (height, txid) tuple matching the
// `height DESC, txid ASC` order; a height-only cursor silently DROPS the remaining same-height txids when
// one block has more than `limit` txids touching the address (a busy treasury/faucet/exchange address):
// page 1 fills with `limit` rows all at height H, the next page `height < H` skips the rest of H forever.
// Mirrors the (height, txid) keyset attestationsFor already uses. `cursorHeight` is the cursor's height expression.
const addressPageSql = (cursorHeight: string | null) =>
  "SELECT DISTINCT txid, height FROM address_history WHERE addr=?" +
  (cursorHeight == null ? "" : ` AND (height < ${cursorHeight} OR (height = ${cursorHeight} AND txid > ?))`) +
  " ORDER BY height DESC, txid LIMIT ?";
export async function addressTxids(
  addr: string,
  cursor: { height: number; txid: string } | null,
  limit = 25,
): Promise<{ txid: string; height: number }[]> {
  const a = addr.toLowerCase();
  if (cursor == null) return await store().all(addressPageSql(null), a, limit) as never;
  return await store().all(addressPageSql("?"), a, cursor.height, cursor.height, cursor.txid.toLowerCase(), limit) as never;
}
/** An address's tx page with outputs in one statement: newest first, or after the last-seen txid `last` of the
 *  previous page; a `last` that is not in the address's history answers no rows (end of pages). */
export async function addressTxPage(addr: string, last: string | null, limit = 25): Promise<(TxRow & { outputs: OutRow[] })[]> {
  const a = addr.toLowerCase();
  const rank = "ROW_NUMBER() OVER (ORDER BY height DESC, txid) AS ord";
  if (last == null) return txsWithOutputsOf(`SELECT txid, ${rank} FROM (${addressPageSql(null)}) x`, [a, limit]);
  const l = last.toLowerCase();
  const cur = "(SELECT height FROM address_history WHERE addr=? AND txid=? LIMIT 1)";
  return txsWithOutputsOf(`SELECT txid, ${rank} FROM (${addressPageSql(cur)}) x`, [a, a, l, a, l, l, limit]);
}
// Height at which a given txid touches an address (for resolving an Esplora last-seen-txid page cursor).
export async function addressTxidHeight(addr: string, txid: string): Promise<number | null> {
  const r = await store().get<{ height: number }>(
    "SELECT height FROM address_history WHERE addr=? AND txid=? LIMIT 1", addr.toLowerCase(), txid.toLowerCase());
  return r ? Number(r.height) : null;
}
// An address's unspent outputs, one page at a time in (height, txid, vout) order; `after` is the last row of the
// previous page. A page shorter than UTXO_PAGE is the last. The `height >= ?` term repeats what the keyset implies so
// a planner walking idx_out_height starts at the cursor instead of below it.
export const UTXO_PAGE = 1000;
export interface UtxoCursor { height: number; txid: string; vout: number }
export async function addressUtxos(addr: string, after: UtxoCursor | null): Promise<OutRow[]> {
  const a = addr.toLowerCase();
  const rows = after == null
    ? await store().all<OutRow>("SELECT * FROM outputs WHERE addr=? AND spent_txid IS NULL ORDER BY height, txid, vout LIMIT ?", a, UTXO_PAGE)
    : await store().all<OutRow>(
      "SELECT * FROM outputs WHERE addr=? AND spent_txid IS NULL AND height >= ? AND (height > ? OR (height = ? AND (txid > ? OR (txid = ? AND vout > ?)))) " +
      "ORDER BY height, txid, vout LIMIT ?", a, after.height, after.height, after.height, after.txid, after.txid, after.vout, UTXO_PAGE);
  return rows.map((r) => ({ ...r, value: amt(r.value as never) }));
}
// One primary-key read of address_totals (db.ts), the table the block writer keeps equal to the aggregate over the
// address's outputs and address_history rows, so the cost does not grow with the address's output count.
export async function addressStats(addr: string): Promise<{ funded: number | string; spent: number | string; balance: number | string; tx_count: number; utxo_count: number }> {
  const r = await store().get<Record<"unspent" | "funded_hi" | "funded_lo" | "spent_hi" | "spent_lo" | "txs", number | bigint>>(
    "SELECT unspent, funded_hi, funded_lo, spent_hi, spent_lo, txs FROM address_totals WHERE addr=?", addr.toLowerCase());
  const funded = joinSum(r?.funded_hi, r?.funded_lo), spent = joinSum(r?.spent_hi, r?.spent_lo);
  return { funded: amt(funded), spent: amt(spent), balance: amt(funded - spent), tx_count: Number(r?.txs ?? 0), utxo_count: Number(r?.unspent ?? 0) };
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
/** Feed row formats: 1 is the record row, 2 adds `outputs`, the row's transaction's outputs. */
export const FEED_FORMATS = [1, 2] as const;
export type FeedFormat = (typeof FEED_FORMATS)[number];
export type FeedKind = "proposals" | "attestations";
export interface FeedAt { height: number; hash: string }
export interface FeedCursor { height: number; pos: number }
export type FeedPage =
  | { ok: true; at: FeedAt; rows: Record<string, unknown>[] }
  | { ok: false; reason: "empty-index" | "snapshot-gone" };

export interface FeedQuery { domain: string | null; at: { height: number; hash: string | null } | null; after: FeedCursor | null; limit: number; format?: FeedFormat }

/** A domain with fewer proposals and fewer attestations than one full page has its attestation pages read from its
 *  proposals (feedRows). */
export const FEED_DOMAIN_SMALL = FEED_LIMIT_MAX;

type Fragment = { sql: string; params: unknown[] };
const PROPOSAL_COLS = "p.txid, p.domain, p.payload_hash, p.uri, p.expires_epoch, p.proposer, p.fee, p.height, p.time, t.pos";
const ATTESTATION_COLS = "a.txid, a.proposal_id, a.attester, a.score, a.confidence, a.fee, a.height, a.time, t.pos";

// One feed's rows after the cursor and at or below the snapshot height, in (height, pos) order, at most `limit`. The
// position is the txs row's: no two rows of one feed share (height, pos), since a record and its txs row are written
// in one turn at one block position, so (height, pos) is a total order. Proposals, and attestations without a domain,
// walk a db.ts FEED_INDEX_DDL index over the record table's height from the cursor (`height >= ?` repeats what the
// cursor implies, so the walk starts there), sort only by pos within a height and stop at the limit.
// An attestation's domain is its proposal's, which no attestations index holds, so with a domain there are two arms,
// and `g` gives one of them the page's limit and the other 0, a limit both engines read once before the arm runs
// and stop at (a WHERE term with a subquery SQLite would test on every row). A domain with fewer than `small`
// proposals and fewer than `small` attestations (each count stops at `small`) is read from its proposals: at most
// `small` index seeks and rows whatever the chain's size, and as many again to count them. A larger one walks attestations by height and probes each
// one's proposal, so a page reads every domain's attestations in its height range: about the page for a domain that
// holds a fair share of them, up to all of them for one with many proposals and few attestations. The CROSS JOINs fix
// SQLite's join order, which without per-domain statistics reads every domain from its proposals; Postgres orders each
// arm's joins by its own statistics.
function feedRows(kind: FeedKind, o: FeedQuery, snap: Fragment, small: number): { with: Fragment | null; rows: Fragment } {
  const after = o.after ?? { height: -1, pos: -1 };
  // `height` is the record's height column, `limit` the LIMIT clause with one bind for the page's limit.
  const page = (height: string, limit = "LIMIT ?"): Fragment => ({
    sql: `${height} >= ? AND ${height} <= ${snap.sql} AND (${height} > ? OR (${height} = ? AND t.pos > ?)) ORDER BY ${height}, t.pos ${limit}`,
    params: [after.height, ...snap.params, after.height, after.height, after.pos, o.limit],
  });
  const arm = (n: 0 | 1) => `LIMIT CASE WHEN (SELECT small FROM g) = ${n} THEN ? ELSE 0 END`;
  const d = o.domain;
  if (kind === "proposals") {
    const w = page("p.height");
    return { with: null, rows: {
      sql: `SELECT ${PROPOSAL_COLS} FROM proposals p JOIN txs t ON t.txid = p.txid WHERE ${d === null ? "" : "p.domain = ? AND "}${w.sql}`,
      params: [...(d === null ? [] : [d]), ...w.params],
    } };
  }
  if (d === null) {
    const w = page("a.height");
    return { with: null, rows: { sql: `SELECT ${ATTESTATION_COLS} FROM attestations a JOIN txs t ON t.txid = a.txid WHERE ${w.sql}`, params: w.params } };
  }
  // The unary plus keeps both engines off idx_att_height in the by-proposal arm: each proposal's attestations come
  // from its idx_att_proposal_hk seek, fewer than `small` rows in all, where a height walk reads every domain's.
  const wh = page("a.height", arm(0)), wb = page("+a.height", arm(1));
  const count = (from: string) => `(SELECT COUNT(*) FROM (SELECT 1 FROM ${from} LIMIT ${small}) c)`;
  return {
    with: {
      sql: `WITH g(small) AS (SELECT CASE WHEN ${count("proposals WHERE domain = ?")} < ${small} THEN CASE WHEN ` +
        `${count("proposals p JOIN attestations a ON a.proposal_id = p.txid WHERE p.domain = ?")} < ${small} THEN 1 ELSE 0 END ELSE 0 END) `,
      params: [d, d],
    },
    rows: {
      sql: `SELECT * FROM (SELECT ${ATTESTATION_COLS} FROM attestations a CROSS JOIN proposals p JOIN txs t ON t.txid = a.txid ` +
        `WHERE p.txid = a.proposal_id AND p.domain = ? AND ${wh.sql}) h UNION ALL ` +
        `SELECT * FROM (SELECT ${ATTESTATION_COLS} FROM proposals p CROSS JOIN attestations a JOIN txs t ON t.txid = a.txid ` +
        `WHERE a.proposal_id = p.txid AND p.domain = ? AND ${wb.sql}) b`,
      params: [d, ...wh.params, d, ...wb.params],
    },
  };
}

/** The one statement feedPage runs for a page, with its binds. `small` is FEED_DOMAIN_SMALL but for tests of each arm. */
export function feedPageStatement(kind: FeedKind, o: FeedQuery, small = FEED_DOMAIN_SMALL): { sql: string; params: unknown[] } {
  const snap: Fragment = o.at ? { sql: "?", params: [o.at.height] } : { sql: "(SELECT MAX(height) FROM blocks)", params: [] };
  const { with: w, rows } = feedRows(kind, o, snap, small);
  const page =
    `${w?.sql ?? ""}SELECT s.height AS at_height, s.hash AS at_hash, r.* FROM blocks s LEFT JOIN (${rows.sql}) r ` +
    `ON 1 = 1 WHERE s.height = ${snap.sql} ORDER BY r.height, r.pos`;
  const sql = o.format === 2
    ? `SELECT f.*, x.vout AS out_vout, x.addr AS out_addr, x.value AS out_value FROM (${page}) f ` +
      "LEFT JOIN outputs x ON x.txid = f.txid ORDER BY f.height, f.pos, x.vout"
    : page;
  return { sql, params: [...(w?.params ?? []), ...rows.params, ...snap.params] };
}

/**
 * One page of proposals or attestations (optionally only those of one domain's proposals) in chain order,
 * (height, position in block), limited to rows at or below a snapshot block. The snapshot is the tip when
 * `at` is null, else the block at `at.height`, which must still carry `at.hash`: every row at or below it
 * then comes from the chain that hash commits to, so a keyset walk under one snapshot neither skips nor
 * repeats, and a reorg at or below the snapshot answers snapshot-gone instead of a mixed list. The snapshot
 * check and the rows are one statement (one view on both backends); the LEFT JOIN keeps the snapshot row
 * when no record matches, so an empty page and a missing snapshot block stay distinguishable.
 * The cursor, the snapshot bound and the LIMIT apply inside the row source (feedRows). The snapshot height, the
 * bound `at.height` or the tip subquery, is both the row source's bound and the snapshot row's key; one statement
 * reads one view, so the two are one height. A page reads its own rows and the rest of the heights at its two ends,
 * except a domain's attestation page, which reads per feedRows.
 * Format 2 joins each page row to its transaction's outputs in that same statement, after the LIMIT, so the
 * limit counts records and a row's outputs are never split across pages.
 */
export async function feedPage(kind: FeedKind, o: FeedQuery): Promise<FeedPage> {
  const withOutputs = o.format === 2;
  const { sql, params } = feedPageStatement(kind, o);
  const raw = await store().all<Record<string, unknown>>(sql, ...params);
  const first = raw[0];
  if (!first) return { ok: false, reason: o.at ? "snapshot-gone" : "empty-index" };
  const at = { height: Number(first.at_height), hash: String(first.at_hash) };
  if (o.at?.hash != null && at.hash !== o.at.hash.toLowerCase()) return { ok: false, reason: "snapshot-gone" };
  if (!withOutputs) {
    const rows = raw.filter((r) => r.txid != null).map(({ at_height: _h, at_hash: _x, ...r }) => jsonSafe(r));
    return { ok: true, at, rows };
  }
  // One statement row per output (or one with null output columns for a transaction without outputs), ordered so
  // a record's rows are adjacent and in vout order.
  const rows: Record<string, unknown>[] = [];
  let last: unknown = null, outputs: { addr: string | null; value: number | string }[] = [];
  for (const { at_height: _h, at_hash: _x, out_vout, out_addr, out_value, ...r } of raw) {
    if (r.txid == null) continue;
    if (r.txid !== last) { last = r.txid; outputs = []; rows.push({ ...jsonSafe(r), outputs }); }
    if (out_vout != null) outputs.push({ addr: (out_addr as string | null) ?? null, value: amt(out_value as number | bigint | null) });
  }
  return { ok: true, at, rows };
}
