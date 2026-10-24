// The routes that replace cairn's chain.db scanner for the Uplink tally, its publisher, the network figures and
// the legacy projection: /blocks/at-or-after/:time, /proposals and /attestations. Each is pinned against the
// scanner's answer over the same chain, computed here from the fixture by the scanner's rules (cairn
// `lib/uplink-source.ts` and `lib/db.ts`): the cutoff is the lowest height whose time is at or after the slot
// among blocks at least 3 below the tip; rows come in (height, position in block) order. Reorgs go through the
// indexer's own writeBlock and unwindAbove.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";

const DB = `/tmp/csd-idx-feeds-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_feeds";
process.env.CSD_INDEX_FROM = "0";

const { writeBlock, unwindAbove } = await import("../src/indexer.js");
const { resetStoreForTests, closeDb } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
test.after(async () => { srv.close(); await closeDb(); for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true }); });

const U = "uplink:v1", OTHER = "cairnx:v1", DEPTH = 3;
const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
type Rec = { kind: "P"; txid: string; domain: string } | { kind: "A"; txid: string; of: string };
type Blk = { height: number; time: number; tag: string; recs: Rec[] };
const P = (n: number, domain = U): Rec => ({ kind: "P", txid: id(n), domain });
const A = (n: number, of: number): Rec => ({ kind: "A", txid: id(n), of: id(of) });

// Times are not monotonic (h3 < h2, h5 < h4). Within h2 and h5 the position order is the reverse of the
// txid order, so an ordering by txid would show.
const TIMES = [1000, 1100, 1250, 1200, 1300, 1290, 1400, 1500, 1600, 1700];
function chain(tag: string, recsAt: Record<number, Rec[]>, from = 0): Blk[] {
  return TIMES.map((time, height) => ({ height, time, tag: height < from ? "m" : tag, recs: recsAt[height] ?? [] }));
}
const MAIN: Record<number, Rec[]> = {
  2: [P(0x9002), P(0x9001)],
  3: [A(0xa002, 0x9002), A(0xa001, 0x9100)],
  4: [P(0x9003)],
  5: [A(0xa004, 0x9001), A(0xa003, 0x9002)],
  6: [P(0x9100, OTHER)],
  7: [A(0xa005, 0x9003)],
  8: [P(0x9004)],
  9: [A(0xa006, 0x9004)],
};

const h256 = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");
const hashOf = (b: Blk) => h256(`block-${b.tag}-${b.height}`);
function rpcBlock(b: Blk, prev: string) {
  const out = { script_pubkey: "0x" + "c3".repeat(20), value: 1 };
  const txs: unknown[] = [{ txid: h256(`coinbase-${b.tag}-${b.height}`), inputs: [], outputs: [out] }];
  for (const r of b.recs) {
    txs.push(r.kind === "P"
      ? { txid: r.txid, inputs: [], outputs: [out], app: { type: "Propose", domain: r.domain, payload_hash: id(1), uri: `u${r.txid.slice(-4)}`, expires_epoch: 9 } }
      : { txid: r.txid, inputs: [], outputs: [out], app: { type: "Attest", proposal_id: r.of, score: 100, confidence: 100 } });
  }
  return { hash: hashOf(b), height: b.height, chainwork: String(b.height + 1), header: { bits: 0x1e00ffff, merkle: id(2), nonce: 0, prev, time: b.time, version: 1 }, txs } as never;
}
async function load(blocks: Blk[], from = 0): Promise<void> {
  for (const b of blocks.slice(from)) await writeBlock(rpcBlock(b, b.height ? hashOf(blocks[b.height - 1]!) : id(0)));
}

// ── the scanner's answers ──
function scannerCutoff(blocks: Blk[], t: number): { height: number; time: number } | null {
  const tip = blocks.length - 1;
  const b = blocks.filter((x) => x.height <= tip - DEPTH && x.time >= t).sort((x, y) => x.height - y.height)[0];
  return b ? { height: b.height, time: b.time } : null;
}
const recsUpTo = (blocks: Blk[], maxH: number) => blocks.filter((b) => b.height <= maxH).flatMap((b) => b.recs.map((r) => ({ ...r, height: b.height })));
function scannerProposals(blocks: Blk[], maxH: number, domain: string | null): string[] {
  return recsUpTo(blocks, maxH).filter((r) => r.kind === "P" && (domain === null || r.domain === domain)).map((r) => r.txid);
}
// cairn's rows(): the domain's proposals, then each one's attestations in height order.
function scannerVotes(blocks: Blk[], maxH: number, domain: string): Map<string, string[]> {
  const recs = recsUpTo(blocks, maxH);
  return new Map(scannerProposals(blocks, maxH, domain).map((p) => [p, recs.filter((r) => r.kind === "A" && r.of === p).map((r) => r.txid)]));
}

// ── the consumer's side of each route ──
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any }; };
async function routeCutoff(t: number): Promise<{ height: number; time: number } | null> {
  const r = await get(`/blocks/at-or-after/${t}`);
  if (r.status === 404) return null;
  assert.equal(r.status, 200);
  return r.body.height <= r.body.tip_height - DEPTH ? { height: r.body.height, time: r.body.time } : null;
}
async function walk(path: string, q: string, snap: number, limit: number): Promise<{ at: { height: number; hash: string }; rows: any[] }> {
  const rows: any[] = [];
  let at: { height: number; hash: string } | null = null, after: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await get(`${path}?${q}&limit=${limit}&at=${at ? `${at.height}:${at.hash}` : snap}${after ? `&after=${after}` : ""}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    at ??= r.body.at;
    rows.push(...r.body.rows);
    if (!r.body.next) return { at: at!, rows };
    after = r.body.next;
  }
  throw new Error("walk did not end");
}

test("cutoff: the lowest height at or after the time, with the tip for the depth rule, equals the scanner's", async () => {
  await resetStoreForTests();
  const blocks = chain("m", MAIN);
  await load(blocks);
  // 1210: h3 (1200) is the last block at or before, but h2 (1250) is the lowest at or after.
  // 1295: h5 (1290) sits between, h4 (1300) is the answer. 1650: h9, within 3 of the tip. 1800: none.
  for (const t of [0, 1000, 1210, 1250, 1295, 1350, 1400, 1650, 1800]) {
    assert.deepEqual(await routeCutoff(t), scannerCutoff(blocks, t), `t=${t}`);
  }
  const r = await get("/blocks/at-or-after/1210");
  assert.deepEqual(r.body, { height: 2, hash: hashOf(blocks[2]!), time: 1250, tip_height: 9 });
  assert.equal((await get("/blocks/at-or-after/-5")).status, 400);
});

test("proposals and attestations: chain order, field set and domain filter equal the scanner's at a snapshot", async () => {
  await resetStoreForTests();
  const blocks = chain("m", MAIN);
  await load(blocks);
  const snap = 6;
  const atQ = `domain=${encodeURIComponent(U)}`;
  const props = await walk("/proposals", atQ, snap, 1);
  assert.deepEqual(props.at, { height: snap, hash: hashOf(blocks[snap]!) });
  assert.deepEqual(props.rows.map((r) => r.txid), scannerProposals(blocks, snap, U));
  assert.deepEqual(Object.keys(props.rows[0]).sort(),
    ["domain", "expires_epoch", "fee", "height", "payload_hash", "pos", "proposer", "time", "txid", "uri"]);
  assert.deepEqual(props.rows.map((r) => [r.height, r.pos, r.time]), [[2, 1, 1250], [2, 2, 1250], [4, 1, 1300]]);
  // every domain: the legacy projection's and the network figures' read
  assert.deepEqual((await walk("/proposals", "", snap, 2)).rows.map((r) => r.txid), scannerProposals(blocks, snap, null));

  const atts = await walk("/attestations", atQ, snap, 1);
  assert.deepEqual(Object.keys(atts.rows[0]).sort(),
    ["attester", "confidence", "fee", "height", "pos", "proposal_id", "score", "time", "txid"]);
  assert.deepEqual(atts.rows.map((r) => r.txid), [id(0xa002), id(0xa004), id(0xa003)], "(height, position) order");
  const grouped = new Map(scannerProposals(blocks, snap, U).map((p) => [p, atts.rows.filter((a) => a.proposal_id === p).map((a) => a.txid)]));
  assert.deepEqual(grouped, scannerVotes(blocks, snap, U));
});

test("reorg: above the snapshot a walk neither skips nor repeats; at or below it the next page is refused", async () => {
  await resetStoreForTests();
  const blocks = chain("m", MAIN);
  await load(blocks);
  const snap = 6, q = `domain=${encodeURIComponent(U)}`;
  const at = `${snap}:${hashOf(blocks[snap]!)}`;
  const want = scannerProposals(blocks, snap, U);

  const p1 = await get(`/proposals?${q}&at=${at}&limit=1`);
  assert.deepEqual(p1.body.rows.map((r: any) => r.txid), want.slice(0, 1));
  // a reorg above the snapshot that adds a domain proposal at h7
  await unwindAbove(snap);
  const above = chain("x", { ...MAIN, 7: [P(0x9005)] }, snap + 1);
  await load(above, snap + 1);
  const rest: string[] = [];
  for (let after = p1.body.next; after;) {
    const r = await get(`/proposals?${q}&at=${at}&limit=1&after=${after}`);
    assert.equal(r.status, 200);
    rest.push(...r.body.rows.map((x: any) => x.txid));
    after = r.body.next;
  }
  assert.deepEqual([...p1.body.rows.map((r: any) => r.txid), ...rest], want, "same rows, once each, in order");

  // a reorg below the snapshot: h4 onwards replaced, h4's proposal gone
  const p1b = await get(`/attestations?${q}&at=${at}&limit=1`);
  assert.equal(p1b.status, 200);
  await unwindAbove(3);
  const below = chain("y", { ...MAIN, 4: [] }, 4);
  await load(below, 4);
  for (const path of ["/proposals", "/attestations"]) {
    const r = await get(`${path}?${q}&at=${at}&limit=1&after=${p1b.body.next}`);
    assert.equal(r.status, 409, path);
    assert.match(r.body.error, /no longer on the indexed chain/);
  }
  // starting again pins the new chain and reads its rows
  const again = await walk("/proposals", q, snap, 1);
  assert.equal(again.at.hash, hashOf(below[snap]!));
  assert.deepEqual(again.rows.map((r) => r.txid), scannerProposals(below, snap, U));
});

test("a malformed cursor or snapshot is refused rather than read as the first page", async () => {
  await resetStoreForTests();
  assert.equal((await get("/proposals")).status, 503, "empty index");
  await load(chain("m", MAIN));
  for (const q of ["after=5", "after=a:1", "at=6:0x12", "at=-1", "domain=a&domain=b"]) {
    assert.equal((await get(`/proposals?${q}`)).status, 400, q);
  }
  assert.equal((await get("/attestations?at=99")).status, 409, "a snapshot above the indexed tip");
});

test("a cursor without a hashed snapshot is refused; with one it pages", async () => {
  await resetStoreForTests();
  const blocks = chain("m", MAIN);
  await load(blocks);
  const q = `domain=${encodeURIComponent(U)}`, hash = hashOf(blocks[6]!);
  for (const path of ["/proposals", "/attestations"]) {
    const first = await get(`${path}?${q}&at=6:${hash}&limit=1`);
    assert.equal(first.status, 200, path);
    const after = first.body.next;
    for (const at of ["", "&at=6"]) {
      const r = await get(`${path}?${q}${at}&limit=1&after=${after}`);
      assert.equal(r.status, 400, `${path} after${at}`);
      assert.match(r.body.error, /after needs at=<height>:<block hash>/);
    }
    assert.equal((await get(`${path}?${q}&at=6:${hash}&limit=1&after=${after}`)).status, 200, `${path} honest page 2`);
  }
});
