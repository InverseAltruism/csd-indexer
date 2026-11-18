// The chain-order feeds' page statement reads one page's rows (src/queries.ts feedPageStatement); the statement it
// replaced read every row of the feed for each page. This pins that the answers did not change: test/_feed-diff.ts
// sends every request shape the routes accept through the real app twice, with each statement, and compares status
// and body bytes. The chain is written through writeBlock and holds what the reads treat specially: several rows of
// one domain in one block in the reverse of txid order, empty blocks, an attestation of a proposal no block holds and
// one of a proposal later in the chain, a repeated txid, a proposal without outputs and one with the empty domain,
// outputs without an address and values past 2^53. The same runs after a reorg, with the replaced snapshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("feed-equiv");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_feed_equiv";
process.env.CSD_INDEX_FROM = "0";

const { writeBlock, unwindAbove } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");
const { feedDiff } = await import("./_feed-diff.js");
const { legacyFeedPageStatement } = await import("./_feed-page-legacy.js");
const { feedPageStatement } = await import("../src/queries.js");

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
test.after(async () => { srv.close(); await closeDb(); });

const X = "cairnx:v1", U = "uplink:v1", S = "tiny:v1";
const DOMAINS = [X, U, S, "none:v1", "", null];
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const h256 = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");
type Out = { script_pubkey: string; value: number | string };
type Rec = { p: number; domain: string; outs?: Out[]; expires?: string } | { a: number; of: number; outs?: Out[] };
const P = (p: number, domain = X, more: Partial<{ outs: Out[]; expires: string }> = {}): Rec => ({ p, domain, ...more });
const A = (a: number, of: number, outs?: Out[]): Rec => ({ a, of, ...(outs ? { outs } : {}) });
const pay = (b: string, value: number | string): Out => ({ script_pubkey: "0x" + b.repeat(20), value });

const CHAIN: Rec[][] = [
  [],
  [P(0x9102), P(0x9101), P(0x9201, U)],
  [A(0xa101, 0x9101), A(0xa102, 0x9999), A(0xa103, 0x9301)],
  [],
  [P(0x9103), A(0xa104, 0x9102), A(0xa105, 0x9201), P(0x9401, "")],
  [P(0x9105), P(0x9104), A(0xa106, 0x9105), A(0xa107, 0x9104)],
  [P(0x9301, S), P(0x9101)],
  [A(0xa108, 0x9103, [pay("7a", "18014398509481985"), { script_pubkey: "0x12", value: 1 }]), P(0x9106, X, { outs: [], expires: "18446744073709551615" })],
  [P(0x9109), P(0x9108), P(0x9107), A(0xa10a, 0x9301), A(0xa109, 0x9107)],
  [],
  [P(0x9202, U), A(0xa10b, 0x9108, [pay("5e", 1_000_000), pay("fe", 10_000), pay("b0", 7)])],
  [P(0x910a), A(0xa10c, 0x910a)],
];
const hashOf = (tag: string, h: number) => h256(`block-${tag}-${h}`);
function rpcBlock(tag: string, height: number, recs: Rec[]) {
  const change = pay("c3", 1);
  const txs: unknown[] = [{ txid: h256(`coinbase-${tag}-${height}`), inputs: [], outputs: [change] }];
  for (const r of recs) {
    txs.push("p" in r
      ? { txid: id(r.p), inputs: [], outputs: r.outs ?? [change], app: { type: "Propose", domain: r.domain, payload_hash: id(1), uri: `u${r.p}`, expires_epoch: r.expires ?? 9 } }
      : { txid: id(r.a), inputs: [], outputs: r.outs ?? [change], app: { type: "Attest", proposal_id: id(r.of), score: 100, confidence: 90 } });
  }
  const prev = height ? hashOf(height - 1 < 7 ? "m" : tag, height - 1) : id(0);
  return { hash: hashOf(tag, height), height, chainwork: String(height + 1), header: { bits: 0x1e00ffff, merkle: id(2), nonce: 0, prev, time: 1000 + height * 100, version: 1 }, txs } as never;
}
async function load(tag: string, chain: Rec[][], from = 0): Promise<void> {
  for (let h = from; h < chain.length; h++) await writeBlock(rpcBlock(h < 7 ? "m" : tag, h, chain[h]!));
}
const opts = { base, store: store(), domains: DOMAINS, limits: [1, 2, 7, 1000], formats: [null, 1, 2] as (1 | 2 | null)[] };

test("an empty index answers alike under both statements", async () => {
  await resetStoreForTests();
  const r = await feedDiff(opts);
  assert.deepEqual(r.differences, []);
  assert.deepEqual(Object.keys(r.statuses).sort(), ["409", "503"]);
});

test("every request shape answers the same bytes under both statements, before and after a reorg", async () => {
  await resetStoreForTests();
  await load("m", CHAIN);
  assert.equal(Number((await store().get<{ n: number }>("SELECT COUNT(*) AS n FROM tx_repeats"))!.n), 1, "the repeated txid");
  const r = await feedDiff(opts);
  assert.deepEqual(r.differences, []);
  assert.equal(r.outOfOrder, 0, "every walk is strictly increasing in (height, pos)");
  assert.ok(r.pages >= 2500 && r.walks.full >= 1250, JSON.stringify(r));
  assert.ok(r.statuses["200"]! > 0 && r.statuses["409"]! > 0, JSON.stringify(r.statuses));

  // A reorg below the tip: heights 7 and up replaced, with other rows at heights the old walks paged through.
  const stale = [`11:${hashOf("m", 11)}`, `8:${hashOf("m", 8)}`];
  await unwindAbove(6);
  const replaced = [...CHAIN.slice(0, 7), [P(0x9501), P(0x9502, S)], [A(0xa501, 0x9502), A(0xa502, 0x9101)], [], [P(0x9503)]];
  await load("y", replaced, 7);
  const after = await feedDiff({ ...opts, extraAts: stale });
  assert.deepEqual(after.differences, []);
  assert.ok(after.pages >= 2400 && after.statuses["409"]! >= 200, JSON.stringify(after));
});

// FEED_DOMAIN_SMALL sends every fixture domain to the by-proposal arm; these send each domain to one arm.
test("a domain's attestation pages answer the same bytes from either arm", async () => {
  await resetStoreForTests();
  await load("m", CHAIN);
  for (const small of [0, 1_000_000_000]) {
    const r = await feedDiff({ ...opts, ours: (kind, o) => feedPageStatement(kind, o, small) });
    assert.deepEqual(r.differences, [], `small=${small}`);
    assert.equal(r.outOfOrder, 0);
    assert.ok(r.pages >= 2500, JSON.stringify(r));
  }
});

test("the comparison fails when the reference statement orders differently", async () => {
  await resetStoreForTests();
  await load("m", CHAIN);
  const r = await feedDiff({
    ...opts, domains: [X], limits: [7], formats: [null],
    reference: (kind, o) => {
      const st = legacyFeedPageStatement(kind, o);
      return { ...st, sql: st.sql.replace("ORDER BY r.height, r.pos", "ORDER BY r.height DESC, r.pos") };
    },
  });
  assert.ok(r.differences.length > 0, "a reordered page must show as a difference");
});
