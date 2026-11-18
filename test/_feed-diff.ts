// Not a suite. The differential check of the chain-order feeds' page statement: every request goes through the real
// app twice against one database, once as it runs (src/queries.ts feedPageStatement) and once with the store asked to
// run a reference statement in its place (by default the one it replaced, _feed-page-legacy.ts), and the two answers
// must have the same status and the same body bytes. The swap happens only when the route sent exactly the statement
// and binds feedPageStatement builds for the request the harness meant, and a request in which the page statement
// did not run exactly once throws, so a harness that misreads the route cannot compare a statement with itself.
// Used by test/feed-page-equivalence.test.ts on a fixture chain and by `_backend-bench.mjs --feeds --diff` at scale.
import { feedPageStatement, FEED_LIMIT_MAX, type FeedKind, type FeedQuery } from "../src/queries.js";
import { PG_INTEGER_MAX, type Store } from "../src/db.js";
import { legacyFeedPageStatement } from "./_feed-page-legacy.js";

export type FeedStatement = (kind: FeedKind, o: FeedQuery) => { sql: string; params: unknown[] };
export interface DiffOptions {
  base: string;
  store: Store;
  domains: (string | null)[]; // null: no domain filter
  limits: number[];
  formats: (1 | 2 | null)[]; // null: the request carries no format
  /** Pages per walk below FEED_LIMIT_MAX, where a walk that reaches it stops and counts as capped; a walk at
   *  FEED_LIMIT_MAX runs to the end, and the walk the start cursors come from is one of those. */
  maxPages?: number;
  /** More `at` values to walk from the start and from a cursor, such as a snapshot a reorg has since replaced. */
  extraAts?: string[];
  reference?: FeedStatement;
  /** Run in place of the statement the route sends, in the pass that stands for the route (both arms of a domain's attestation page). */
  ours?: FeedStatement;
  log?: (line: string) => void;
}
export interface DiffResult {
  pages: number;
  walks: { full: number; capped: number };
  firstPages: number;
  statuses: Record<string, number>;
  differences: { url: string; ours: string; reference: string }[];
  /** Rows of a walk not strictly after the walk's previous row in (height, pos): a tie or a step back. */
  outOfOrder: number;
}
interface Req { kind: FeedKind; domain: string | null; at: string | null; after: string | null; limit: number; format: 1 | 2 | null }
interface Pos { height: number; pos: number }

const AT = /^(\d+)(?::(0x[0-9a-fA-F]{64}))?$/;
function query(r: Req): FeedQuery {
  const at = r.at === null ? null : AT.exec(r.at);
  const after = r.after === null ? null : r.after.split(":").map(Number);
  return {
    domain: r.domain,
    at: at ? { height: Number(at[1]), hash: at[2] ?? null } : null,
    after: after ? { height: after[0]!, pos: after[1]! } : null,
    limit: Math.min(r.limit, FEED_LIMIT_MAX),
    format: r.format ?? 1,
  };
}
function url(r: Req): string {
  const q = [
    ...(r.domain === null ? [] : [`domain=${encodeURIComponent(r.domain)}`]),
    ...(r.at === null ? [] : [`at=${r.at}`]),
    ...(r.after === null ? [] : [`after=${r.after}`]),
    `limit=${r.limit}`,
    ...(r.format === null ? [] : [`format=${r.format}`]),
  ];
  return `/${r.kind}?${q.join("&")}`;
}

export async function feedDiff(o: DiffOptions): Promise<DiffResult> {
  const reference = o.reference ?? legacyFeedPageStatement;
  const res: DiffResult = { pages: 0, walks: { full: 0, capped: 0 }, firstPages: 0, statuses: {}, differences: [], outOfOrder: 0 };
  const s = o.store as unknown as { all: (sql: string, ...p: unknown[]) => Promise<unknown[]>; get: (sql: string, ...p: unknown[]) => Promise<unknown> };
  const all = s.all.bind(o.store);
  let pending: { sql: string; params: unknown[]; swap: { sql: string; params: unknown[] } | null; hits: number } | null = null;
  s.all = async (sql, ...p) => {
    if (pending && sql === pending.sql && JSON.stringify(p) === JSON.stringify(pending.params)) {
      pending.hits++;
      if (pending.swap) return await all(pending.swap.sql, ...pending.swap.params);
    }
    return await all(sql, ...p);
  };

  const once = async (r: Req, swap: boolean) => {
    const st = feedPageStatement(r.kind, query(r));
    pending = { ...st, swap: swap ? reference(r.kind, query(r)) : (o.ours?.(r.kind, query(r)) ?? null), hits: 0 };
    const answer = await fetch(o.base + url(r));
    const body = await answer.text();
    const hits = pending.hits;
    pending = null;
    if (hits !== 1) throw new Error(`${url(r)}: the page statement ran ${hits} times (status ${answer.status} ${body.slice(0, 120)})`);
    return { status: answer.status, body };
  };
  const pair = async (r: Req) => {
    const ours = await once(r, false), ref = await once(r, true);
    res.pages++;
    res.statuses[ours.status] = (res.statuses[ours.status] ?? 0) + 1;
    if (ours.status !== ref.status || ours.body !== ref.body) {
      res.differences.push({ url: url(r), ours: `${ours.status} ${ours.body.slice(0, 400)}`, reference: `${ref.status} ${ref.body.slice(0, 400)}` });
    }
    return ours;
  };
  const walk = async (r: Req): Promise<Pos[]> => {
    const rows: Pos[] = [];
    for (let after = r.after, n = 1; ; n++) {
      const a = await pair({ ...r, after });
      const body = a.status === 200 ? (JSON.parse(a.body) as { rows: Pos[]; next: string | null }) : null;
      for (const x of body?.rows ?? []) {
        const last = rows[rows.length - 1];
        if (last && !(x.height > last.height || (x.height === last.height && x.pos > last.pos))) res.outOfOrder++;
        rows.push({ height: x.height, pos: x.pos });
      }
      if (!body?.next) { res.walks.full++; return rows; }
      if (o.maxPages !== undefined && r.limit < FEED_LIMIT_MAX && n >= o.maxPages) { res.walks.capped++; return rows; }
      after = body.next;
    }
  };

  try {
    const block = async (sql: string, ...p: unknown[]) => (await s.get(sql, ...p)) as { height: number; hash: string } | undefined;
    const tip = await block("SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1");
    for (const kind of ["proposals", "attestations"] as const) {
      for (const domain of o.domains) {
        const req = (at: string | null, after: string | null, limit: number, format: 1 | 2 | null): Req => ({ kind, domain, at, after, limit, format });
        const first = async (at: string | null) => {
          for (const limit of o.limits) for (const format of o.formats) { await pair(req(at, null, limit, format)); res.firstPages++; }
        };
        if (!tip) { await first(null); await first("0"); continue; }
        const mid = await block("SELECT height, hash FROM blocks WHERE height = ?", Math.floor(tip.height * 0.6));
        for (const snap of mid && mid.height !== tip.height ? [tip, mid] : [tip]) {
          const at = `${snap.height}:${snap.hash}`;
          const rows = await walk(req(at, null, FEED_LIMIT_MAX, null));
          const p = (x: Pos | undefined) => (x ? `${x.height}:${x.pos}` : null);
          // after the first row of a height that holds more rows of this feed, near the middle of the walk
          const half = Math.floor(rows.length / 2);
          const inHeight = [...rows.keys()].filter((i) => rows[i + 1]?.height === rows[i]!.height)
            .sort((x, y) => Math.abs(x - half) - Math.abs(y - half))[0];
          const fixed = [
            null,
            p(inHeight === undefined ? undefined : rows[inHeight]),
            p(rows[rows.length - 1]), // after the last row: an empty page
            `${snap.height + 1}:0`, // past the snapshot
            // the largest position the route accepts; a larger one is refused before any statement runs, the same for
            // both (test/feed-cursor-range.test.ts), so the harness has no statement to compare there
            `${rows[half]?.height ?? snap.height}:${PG_INTEGER_MAX}`,
          ];
          for (const limit of o.limits) {
            const tail = p(rows[rows.length - 2 * limit - 2]); // about two pages before the end
            const starts = [...new Set([...fixed, tail].filter((x, i) => x !== null || i === 0))];
            for (const format of o.formats) {
              for (const after of starts) {
                if (after === null && limit === FEED_LIMIT_MAX && format === null) continue; // the walk above
                await walk(req(at, after, limit, format));
              }
            }
          }
          o.log?.(`  ${kind} domain=${domain === null ? "(none)" : JSON.stringify(domain)} at=${snap.height}: ${rows.length} rows, ` +
            `${res.pages} pages compared so far, ${res.differences.length} differences`);
          await first(String(snap.height));
        }
        await first(null);
        // a snapshot no longer on the chain (another hash at its height), one above the tip, the tip's hash in capitals
        const gone = `${tip.height}:${tip.hash.slice(0, -1)}${tip.hash.endsWith("0") ? "1" : "0"}`;
        for (const at of [gone, `${tip.height + 1}:${tip.hash}`, `${tip.height}:0x${tip.hash.slice(2).toUpperCase()}`, ...(o.extraAts ?? [])]) {
          for (const after of [null, "0:0"]) await walk(req(at, after, o.limits[0]!, o.formats[0]!));
        }
        await first(String(tip.height + 1));
      }
    }
  } finally {
    s.all = all;
  }
  return res;
}
