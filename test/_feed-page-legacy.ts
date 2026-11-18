// The chain-order feeds' page statement as 0.3.12 first shipped it, kept as the reference the differential check
// (test/_feed-diff.ts) runs beside src/queries.ts feedPageStatement. Only the harness imports it: the record source
// below is materialized whole for every page, so the server must never run it. Same input, same binds order, same
// result columns as the statement that replaced it.
import type { FeedKind, FeedQuery } from "../src/queries.js";

const FEED_SOURCE: Record<FeedKind, (domain: boolean) => string> = {
  proposals: (domain) =>
    "SELECT p.txid, p.domain, p.payload_hash, p.uri, p.expires_epoch, p.proposer, p.fee, p.height, p.time, t.pos " +
    `FROM proposals p JOIN txs t ON t.txid = p.txid${domain ? " WHERE p.domain = ?" : ""}`,
  attestations: (domain) =>
    "SELECT a.txid, a.proposal_id, a.attester, a.score, a.confidence, a.fee, a.height, a.time, t.pos " +
    `FROM attestations a JOIN txs t ON t.txid = a.txid${domain ? " JOIN proposals p ON p.txid = a.proposal_id WHERE p.domain = ?" : ""}`,
};

export function legacyFeedPageStatement(kind: FeedKind, o: FeedQuery): { sql: string; params: unknown[] } {
  const after = o.after ?? { height: -1, pos: -1 };
  const snap = o.at ? "?" : "(SELECT MAX(height) FROM blocks)";
  const page =
    `SELECT s.height AS at_height, s.hash AS at_hash, r.* FROM blocks s LEFT JOIN (${FEED_SOURCE[kind](o.domain !== null)}) r ` +
    `ON r.height <= s.height AND (r.height > ? OR (r.height = ? AND r.pos > ?)) WHERE s.height = ${snap} ORDER BY r.height, r.pos LIMIT ?`;
  const sql = o.format === 2
    ? `SELECT f.*, x.vout AS out_vout, x.addr AS out_addr, x.value AS out_value FROM (${page}) f ` +
      "LEFT JOIN outputs x ON x.txid = f.txid ORDER BY f.height, f.pos, x.vout"
    : page;
  const params: unknown[] = [];
  if (o.domain !== null) params.push(o.domain);
  params.push(after.height, after.height, after.pos);
  if (o.at) params.push(o.at.height);
  params.push(o.limit);
  return { sql, params };
}
