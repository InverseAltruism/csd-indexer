// Honest failover through syncOnce with three backends (a primary and two secondaries) serving one chain of real
// headers with the chainwork the node computes for them: height 0 stands for mainnet block 32795, heights 1 to 160
// carry the 160 mainnet headers of test/fixtures/header-chain.ts. The operator's nodes rebuild their state after each
// restart, and meanwhile the index follows the chain through a secondary: each case is a failover the selection makes
// in the pass the situation appears, and the index follows the secondary from there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { workForBits } from "@inversealtruism/csd-codec";
import { tipHeaderPowOk } from "@inversealtruism/csd-light";
import { REAL_CHAIN, WORK_AT_LAST, WORK_BEFORE_FIRST } from "./fixtures/header-chain.js";
import { realTipHash } from "./fixtures/header-32803.js";
import { tmpDb } from "./_tmpdb.js";

const id = (tag: string) => "0x" + createHash("sha256").update(tag).digest("hex");
type Blk = { hash: string; height: number; chainwork: string; header: Record<string, unknown>; txs: unknown[] };
const MINER = "0x" + "a1".repeat(20);
const cb = (tag: string) => [{ txid: id(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: MINER, value: 50 }] }];
const first = REAL_CHAIN[0]!;
const CHAIN: Blk[] = [{ hash: first.header.prev, height: 0, chainwork: String(WORK_BEFORE_FIRST),
  header: { version: 1, prev: "0x" + "00".repeat(32), merkle: id("g"), time: first.header.time - 120, bits: first.header.bits, nonce: 0 }, txs: cb("0") }];
for (const [i, r] of REAL_CHAIN.entries()) {
  CHAIN.push({ hash: r.hash, height: i + 1, chainwork: String(BigInt(CHAIN[i]!.chainwork) + workForBits(r.header.bits)), header: r.header, txs: cb(String(i + 1)) });
}

// A node serves `chain` (default CHAIN) up to `tip`; null answers nothing. `lag` delays each block read.
type State = { tip: number | null; chain?: Blk[]; lag?: number };
const nodes = await Promise.all([0, 1, 2].map(async () => {
  const n = { state: { tip: null } as State, url: "" };
  const srv = createServer((req, res) => {
    const s = n.state, c = s.chain ?? CHAIN;
    if (s.tip == null) { req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
    if (req.url === "/tip") { const t = c[s.tip]!; return res.end(JSON.stringify({ ok: true, tip: t.hash, height: t.height, chainwork: t.chainwork })); }
    const m = /^\/block\/height\/(\d+)$/.exec(req.url ?? ""), h = m ? Number(m[1]) : -1, b = h <= s.tip ? c[h] : undefined;
    const send = () => { if (!b) { res.statusCode = 404; res.end("{}"); } else res.end(JSON.stringify({ ok: true, ...b })); };
    if (s.lag) setTimeout(send, s.lag); else send();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  n.url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return Object.assign(n, { srv });
}));
const [P, S1, S2] = nodes as [typeof nodes[0], typeof nodes[0], typeof nodes[0]];
const up = (tip: number, extra: Omit<State, "tip"> = {}): State => ({ tip, ...extra });
const down: State = { tip: null };

process.env.CSD_RPC = P.url;
process.env.CSD_RPC_BACKENDS = `${P.url},${S1.url},${S2.url}`;
process.env.CSD_INDEX_DB = tmpDb("routehonest");
process.env.CSD_INDEX_PG_SCHEMA = "t_routehonest";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "1";
const rpc = await import("../src/rpc.js");
const { CFG } = await import("../src/config.js");
const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warnings.push(String(a[0])); };
test.after(async () => {
  console.warn = realWarn;
  for (const n of nodes) { n.srv.closeAllConnections(); n.srv.close(); }
  await closeDb();
});

const name = (u: string) => (u === P.url ? "primary" : u === S1.url ? "sec1" : "sec2");
type Pass = { active: string; indexed: number; hold: boolean };
async function pass(): Promise<Pass> {
  warnings.length = 0;
  await syncOnce();
  return { active: name(rpc.activeBackend()), indexed: await indexedHeight(), hold: warnings.some((w) => w.includes("HOLD")) };
}
const storedWork = async (h: number) => (await store().get<{ chainwork: string }>("SELECT chainwork FROM blocks WHERE height=?", h))?.chainwork;
// The index at `h` from the primary alone, so the primary is the active backend.
async function start(h: number): Promise<void> {
  await resetStoreForTests();
  P.state = up(h); S1.state = down; S2.state = down;
  await pass();
  assert.equal(rpc.activeBackend(), P.url);
  assert.equal(await indexedHeight(), h);
}

test("the fixture: every header meets its bits and links to the one before", () => {
  REAL_CHAIN.forEach((r, i) => {
    assert.ok(tipHeaderPowOk(r.header, r.hash), `PoW at ${r.height}`);
    if (i) assert.equal(r.header.prev, REAL_CHAIN[i - 1]!.hash, `link at ${r.height}`);
  });
  assert.equal(REAL_CHAIN[7]!.hash, realTipHash, "block 32803 is the ROUTE-1 vector");
});

test("the fixture's real work: the node's chainwork at 32955 is its chainwork at 32795 plus every header's work", () => {
  assert.equal(BigInt(CHAIN[160]!.chainwork), WORK_AT_LAST);
});

test("the primary rebuilding far below: the index stays on the secondary and follows it, without a hold", async () => {
  await start(100);
  P.state = down; S1.state = up(101); S2.state = up(101);
  const failover = await pass();
  assert.deepEqual([failover.active, failover.indexed], ["sec1", 101]);
  P.state = up(20);
  for (let i = 0; i < 3; i++) {
    const p = await pass();
    assert.equal(p.active, "sec1", `idle pass ${i + 1}: the secondary the index caught up with stays active`);
    assert.equal(p.indexed, 101);
    assert.equal(p.hold, false, "no HOLD against the rebuilding primary");
  }
  S1.state = up(102); S2.state = up(102);
  assert.equal((await pass()).indexed, 102, "a new block on the secondaries is indexed in the pass it appears");
  assert.equal(rpc.activeBackend(), S1.url);
  assert.equal(await storedWork(102), CHAIN[102]!.chainwork, "the stored chainwork is the node's");
});

test("the same with CSD_INDEX_WORK_GUARD=0: the index does not unwind to the rebuilding primary", async () => {
  CFG.workGuard = false;
  try {
    await start(100);
    P.state = down; S1.state = up(101); S2.state = up(101);
    await pass();
    P.state = up(20);
    for (let i = 0; i < 2; i++) {
      const p = await pass();
      assert.equal(p.active, "sec1");
      assert.equal(p.indexed, 101, `idle pass ${i + 1}`);
    }
  } finally { CFG.workGuard = true; }
});

test("the primary back one block under the secondaries: each new block is indexed in the pass it appears", async () => {
  await start(100);
  P.state = down; S1.state = up(101); S2.state = up(101);
  await pass();
  P.state = up(100);
  assert.equal((await pass()).active, "sec1");
  for (let h = 102; h <= 104; h++) {
    S1.state = up(h); S2.state = up(h);
    const p = await pass();
    assert.equal(p.indexed, h, `block ${h}`);
    assert.equal(p.active, "sec1");
    assert.equal(p.hold, false);
  }
});

test("the primary down, one secondary stuck: the index follows the other", async () => {
  await start(100);
  P.state = down; S1.state = up(101); S2.state = up(100);
  assert.equal((await pass()).active, "sec1");
  S1.state = up(103); S2.state = up(102);
  assert.equal((await pass()).indexed, 103);
  for (let i = 0; i < 2; i++) assert.deepEqual([(await pass()).active, await indexedHeight()], ["sec1", 103]);
  S1.state = up(104);
  assert.equal((await pass()).indexed, 104);
  assert.equal(rpc.activeBackend(), S1.url);
});

test("the index and the primary far under a slow secondary: it is selected in the first pass and followed", async () => {
  await start(10);
  // The index and the primary at 12 (a first sync while the primary rebuilds), the secondary at 160, 5 ms a read.
  P.state = up(12); S1.state = up(160, { lag: 5 });
  const p = await pass();
  assert.equal(p.active, "sec1");
  assert.equal(p.indexed, 160);
  assert.equal(await storedWork(160), CHAIN[160]!.chainwork);
});

// A primary that answers /tip on a branch of its own and serves no block above the index, with `work` at `h`.
const alienTip = (h: number, work: string): State => {
  const c = CHAIN.slice();
  c[h] = { ...CHAIN[h]!, hash: id(`alien-${h}`), chainwork: work };
  for (let i = 13; i < h; i++) delete c[i];
  return up(h, { chain: c });
};

test("a primary on a branch of its own with less work: the heavier secondary wins after the work-escape", async () => {
  const escape = CFG.workEscapeCycles;
  CFG.workEscapeCycles = 2;
  try {
    await start(12);
    // The primary claims height 159 with the real work there, one block less than the secondary's 160.
    P.state = alienTip(159, CHAIN[159]!.chainwork); S2.state = up(160, { lag: 5 });
    const actives: string[] = [];
    for (let i = 0; i < 10 && actives.at(-1) !== "sec2"; i++) actives.push((await pass()).active);
    assert.equal(actives.at(-1), "sec2", `the heavier secondary wins: ${actives.join(" ")}`);
  } finally { CFG.workEscapeCycles = escape; }
});

// The stored tip row holds a chainwork the regression guard cannot read as work (a damaged row, or a node that once
// served it so): the guard holds on it and rewrites it from the active backend's block at that height. The primary
// answers from a rebuild far below and the secondaries are five blocks above.
for (const raw of ["0", "", "-1"]) {
  test(`a stored chainwork ${JSON.stringify(raw)} at the tip: the secondary is selected and the row is rewritten`, async () => {
    await start(100);
    await store().run("UPDATE blocks SET chainwork=? WHERE height=100", raw);
    P.state = up(20); S1.state = up(105); S2.state = up(105);
    const passes: Pass[] = [];
    for (let i = 0; i < 4; i++) passes.push(await pass());
    assert.equal(passes[0]!.active, "sec1", "the secondary is ranked with its claim");
    assert.equal(await indexedHeight(), 105);
    assert.equal(await storedWork(100), CHAIN[100]!.chainwork, "the row is rewritten from the secondary's block");
  });
}

test("the primary down over an index at 0: the index follows a secondary through all 160 real headers", async () => {
  await start(0);
  P.state = down; S1.state = up(160); S2.state = down;
  const p = await pass();
  assert.equal(p.active, "sec1");
  assert.equal(await indexedHeight(), 160);
  assert.equal(await storedWork(160), CHAIN[160]!.chainwork);
});
