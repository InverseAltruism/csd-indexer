// Honest failover through syncOnce with three backends (a primary and two secondaries) serving one chain of real
// headers with the chainwork the node computes for them: height 0 stands for mainnet block 32795, heights 1 to 160
// carry the 160 mainnet headers of test/fixtures/header-chain.ts. The operator's nodes rebuild their state after each
// restart, and meanwhile the index follows the chain through a secondary: a failover the previous release made has
// to be made here too, and as soon.
// The link proof refused a secondary whose tip the index had already stored, so once the index caught up with it the
// selection fell back to a primary that was rebuilding or stuck below (and held there each idle pass, or unwound to it
// with the chainwork guard off). A proof longer than its deadline restarted from the tip at every pass and never
// finished. The chainwork a contender reported counted in full, and the stored figure after a switch was the
// reported one, so an invented figure held the index against every honest node afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { workForBits } from "@inversealtruism/csd-codec";
import { REAL_CHAIN, WORK_AT_LAST, WORK_BEFORE_FIRST } from "./fixtures/header-chain.js";
import { tmpDb } from "./_tmpdb.js";

const id = (tag: string) => "0x" + createHash("sha256").update(tag).digest("hex");
type Blk = { hash: string; height: number; chainwork: string; header: Record<string, unknown>; txs: unknown[] };
const MINER = "0x" + "a1".repeat(20), ATTACKER = "0x" + "ee".repeat(20);
const cb = (tag: string, to = MINER) => [{ txid: id(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: to, value: 50 }] }];
const first = REAL_CHAIN[0]!;
const CHAIN: Blk[] = [{ hash: first.header.prev, height: 0, chainwork: String(WORK_BEFORE_FIRST),
  header: { version: 1, prev: "0x" + "00".repeat(32), merkle: id("g"), time: first.header.time - 120, bits: first.header.bits, nonce: 0 }, txs: cb("0") }];
for (const [i, r] of REAL_CHAIN.entries()) {
  CHAIN.push({ hash: r.hash, height: i + 1, chainwork: String(BigInt(CHAIN[i]!.chainwork) + workForBits(r.header.bits)), header: r.header, txs: cb(String(i + 1)) });
}

// A node serves `chain` (default CHAIN) up to `tip`; null answers nothing. `lag` delays each block read; `failOnce`
// fails the next read of one height, with a 503 or a closed connection. Each block read is recorded by height.
type State = { tip: number | null; chain?: Blk[]; lag?: number; failOnce?: { h: number; mode: "status" | "reset" } };
const nodes = await Promise.all([0, 1, 2].map(async () => {
  const n = { state: { tip: null } as State, reads: [] as number[], url: "" };
  const srv = createServer((req, res) => {
    const s = n.state, c = s.chain ?? CHAIN;
    if (s.tip == null) { req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
    if (req.url === "/tip") { const t = c[s.tip]!; return res.end(JSON.stringify({ ok: true, tip: t.hash, height: t.height, chainwork: t.chainwork })); }
    const m = /^\/block\/height\/(\d+)$/.exec(req.url ?? ""), h = m ? Number(m[1]) : -1, b = h <= s.tip ? c[h] : undefined;
    n.reads.push(h);
    if (s.failOnce?.h === h) {
      const mode = s.failOnce.mode;
      s.failOnce = undefined;
      if (mode === "reset") { req.socket.destroy(); return; }
      res.statusCode = 503; return res.end("{}");
    }
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
const q = await import("../src/queries.js");

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warnings.push(String(a[0])); };
test.after(async () => {
  console.warn = realWarn;
  for (const n of nodes) { n.srv.closeAllConnections(); n.srv.close(); }
  await closeDb();
});

const name = (u: string) => (u === P.url ? "primary" : u === S1.url ? "sec1" : "sec2");
type Pass = { active: string; indexed: number; hold: boolean; reads: number[][] };
async function pass(): Promise<Pass> {
  for (const n of nodes) n.reads = [];
  warnings.length = 0;
  await syncOnce();
  return { active: name(rpc.activeBackend()), indexed: await indexedHeight(), hold: warnings.some((w) => w.includes("HOLD")), reads: nodes.map((n) => n.reads) };
}
const storedWork = async (h: number) => (await store().get<{ chainwork: string }>("SELECT chainwork FROM blocks WHERE height=?", h))?.chainwork;
// The index at `h` from the primary alone, so the primary is the active backend.
async function start(h: number): Promise<void> {
  await resetStoreForTests();
  rpc.resetProofsForTests();
  P.state = up(h); S1.state = down; S2.state = down;
  await pass();
  assert.equal(rpc.activeBackend(), P.url);
  assert.equal(await indexedHeight(), h);
}

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

test("a proof longer than its deadline continues across passes and the secondary is selected", async () => {
  const deadline = CFG.powVerifyTimeoutMs;
  CFG.powVerifyTimeoutMs = 400;
  try {
    await start(10);
    // The index and the primary at 12 (a first sync while the primary rebuilds), the secondary at 160, 5 ms a read:
    // the proof is 148 headers, more than one deadline holds.
    P.state = up(12); S1.state = up(160, { lag: 5 });
    let proving = 0, proofReads = 0, p: Pass | undefined;
    for (let i = 0; i < 8 && (p = await pass()).active !== "sec1"; i++) {
      proving++; proofReads += p.reads[1]!.length;
      assert.ok(warnings.some((w) => /link proof .* to go/.test(w)), "a short proof is logged with what remains");
    }
    assert.equal(p?.active, "sec1", `selected after ${proving} passes that ended at the deadline`);
    assert.ok(proving >= 1, "the proof did not fit one deadline");
    assert.ok(proofReads <= 148 + 2 * proving, `no header read twice: ${proofReads} reads in ${proving} passes`);
    assert.equal(await indexedHeight(), 160);
    assert.equal(await storedWork(160), CHAIN[160]!.chainwork);
  } finally { CFG.powVerifyTimeoutMs = deadline; }
});

// Heights 101 to 150 carry real headers from 40 heights lower: a tip at 150 with valid PoW whose chain does not link.
const SHIFTED: Blk[] = CHAIN.slice(0, 151).map((b, h) => (h <= 100 ? b : { ...CHAIN[h - 40]!, height: h }));

test("a contender that changes its chain between passes gains nothing from the headers it proved before", async () => {
  const deadline = CFG.powVerifyTimeoutMs;
  CFG.powVerifyTimeoutMs = 400;
  try {
    await start(10);
    P.state = up(12); S1.state = up(150, { lag: 5 });
    const one = await pass();
    assert.equal(one.active, "primary");
    const reached = Math.min(...one.reads[1]!);
    assert.ok(reached > 13, `the first pass proved down to ${reached} only`);
    S1.state = up(150, { lag: 5, chain: SHIFTED });
    for (let i = 0; i < 4; i++) assert.equal((await pass()).active, "primary", "a tip on another chain does not join the headers proved for the first");
    assert.equal(await indexedHeight(), 12);
    S1.state = up(150, { lag: 5 });
    const three = await pass();
    assert.ok(three.reads[1]!.includes(149), "back on the first chain, the proof starts again from its tip");
  } finally { CFG.powVerifyTimeoutMs = deadline; }
});

test("an invented chainwork counts no more than the headers carry, and the index follows the honest nodes after", async () => {
  const escape = CFG.workEscapeCycles;
  CFG.workEscapeCycles = 3;
  try {
    await start(100);
    S2.state = up(100);
    // Block 101's real header, not yet on the primary, with an invented chainwork and a body of its own.
    const forged = CHAIN.slice(0, 101);
    forged.push({ ...CHAIN[101]!, chainwork: "9".repeat(30), txs: cb("f101", ATTACKER) });
    S1.state = up(101, { chain: forged });
    const actives: string[] = [];
    for (let i = 0; i < 5; i++) actives.push((await pass()).active);
    assert.ok(actives.includes("sec1"), `the work-escape selects it: ${actives.join(" ")}`);
    // Its body was written (block bodies are not checked against their headers, README "Honest limits"), and its
    // chainwork is the real one, not the invented one.
    assert.equal((await q.addressStats(ATTACKER)).utxo_count, 1);
    assert.equal(await storedWork(101), CHAIN[101]!.chainwork);
    S1.state = down; P.state = up(110); S2.state = up(110);
    const after = await pass();
    assert.equal(after.hold, false);
    assert.equal(await indexedHeight(), 110, "the honest nodes' heavier chain is followed");
    assert.equal(await storedWork(110), CHAIN[110]!.chainwork);
  } finally { CFG.workEscapeCycles = escape; }
});

// A primary that answers /tip on a branch of its own and serves no block above the index, with `work` at `h`.
const alienTip = (h: number, work: string): State => {
  const c = CHAIN.slice();
  c[h] = { ...CHAIN[h]!, hash: id(`alien-${h}`), chainwork: work };
  for (let i = 13; i < h; i++) delete c[i];
  return up(h, { chain: c });
};

test("a proof that took several passes ranks the contender with the work of every header it proved", async () => {
  const deadline = CFG.powVerifyTimeoutMs, escape = CFG.workEscapeCycles;
  CFG.powVerifyTimeoutMs = 400; CFG.workEscapeCycles = 2;
  try {
    await start(12);
    // The primary claims height 159 with the real work there, one block less than the secondary's 160.
    P.state = alienTip(159, CHAIN[159]!.chainwork); S2.state = up(160, { lag: 5 });
    const actives: string[] = [];
    for (let i = 0; i < 10 && actives.at(-1) !== "sec2"; i++) actives.push((await pass()).active);
    assert.equal(actives.at(-1), "sec2", `the heavier secondary wins once proved: ${actives.join(" ")}`);
    assert.ok(actives.length > 2, "its proof took more than one pass");
  } finally { CFG.powVerifyTimeoutMs = deadline; CFG.workEscapeCycles = escape; }
});

test("a contender is ranked with its proved work when it claims more and with its claim when it claims less", async () => {
  const escape = CFG.workEscapeCycles;
  CFG.workEscapeCycles = 2;
  try {
    for (const claim of ["9".repeat(30), "1"]) {
      await start(100);
      // The secondary serves the real 101 a block above the primary, claiming `claim`; the primary's work is the real
      // one at 100. Ranked with the proved work the secondary out-works the primary and the work-escape switches.
      const c = CHAIN.slice(0, 101);
      c.push({ ...CHAIN[101]!, chainwork: claim });
      if (claim === "1") { P.state = up(100); S1.state = up(101, { chain: c }); }
      else { P.state = alienTip(101, CHAIN[101]!.chainwork); S1.state = up(101, { chain: c }); }
      const actives: string[] = [];
      for (let i = 0; i < 5; i++) actives.push((await pass()).active);
      assert.deepEqual(actives, Array(5).fill("primary"), `claim ${claim.slice(0, 6)}: no more work than the primary's, no switch`);
    }
  } finally { CFG.workEscapeCycles = escape; }
});

// The stored tip row holds a chainwork the index cannot read as work (a backend once served it so; the guard holds
// on it and rewrites it from the active backend's block), the primary answers from a rebuild far below, and the
// secondaries are five blocks above. The link proof linked to that row and ranked the secondary at the row's figure
// plus five headers' work, under the primary, so the primary stayed active and the index held for good.
for (const raw of ["0", "", "-1"]) {
  test(`a stored chainwork ${JSON.stringify(raw)} under a secondary's proof: it is selected and the row is rewritten`, async () => {
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

test("with the guard off, blocks over a stored chainwork \"0\" are stored with the node's figures", async () => {
  CFG.workGuard = false;
  try {
    await start(100);
    await store().run("UPDATE blocks SET chainwork='0' WHERE height=100");
    P.state = down; S1.state = up(105); S2.state = up(100);
    await pass();
    assert.equal(rpc.activeBackend(), S1.url);
    assert.equal(await indexedHeight(), 105);
    for (const h of [101, 105]) assert.equal(await storedWork(h), CHAIN[h]!.chainwork, `height ${h}`);
  } finally { CFG.workGuard = true; }
});

test("every real header of the fixture served by a secondary is admitted, the steepest difficulty step included", async () => {
  await start(0);
  P.state = down; S1.state = up(160); S2.state = down;
  const p = await pass();
  assert.equal(p.active, "sec1");
  assert.equal(await indexedHeight(), 160);
  assert.ok(!warnings.some((w) => w.includes("REFUSING")), "no block refused");
  assert.equal(await storedWork(160), CHAIN[160]!.chainwork);
});

// The only backend that answers serves block 101 with a header that claims bits 0x03000001 (a target of 1, no proof
// of work can meet it) and a chainwork 2^128 above block 100's. Stored as "parent's work plus that header's work",
// no honest backend would ever present as much, and the regression guard held against every one of them.
test("a served block whose header fails proof of work is not written, and the index follows the honest nodes after", async () => {
  await start(100);
  const bad = CHAIN.slice(0, 101);
  bad.push({ ...CHAIN[101]!, header: { ...CHAIN[101]!.header, bits: 0x03000001 }, chainwork: String(BigInt(CHAIN[100]!.chainwork) + 2n ** 128n) });
  P.state = down; S2.state = down; S1.state = up(101, { chain: bad });
  const one = await pass();
  assert.equal(one.indexed, 100, "the block is not written");
  assert.ok(warnings.some((w) => w.includes("REFUSING block 101")), "the pass ends with a logged line");
  const two = await pass();
  assert.equal(two.indexed, 100);
  assert.deepEqual(two.reads[1], [], "the backend left is not read while it answers that tip");
  P.state = up(110); S2.state = up(110);
  const three = await pass();
  assert.equal(three.hold, false);
  assert.equal(await indexedHeight(), 110);
  assert.equal(await storedWork(110), CHAIN[110]!.chainwork);
});

// Once a block is read twice in a pass that selects the secondary: by its proof and by the sync that follows.
const readOnce = (reads: number[], from: number, to: number) => {
  for (let h = from; h <= to; h++) assert.equal(reads.filter((x) => x === h).length, 1, `height ${h} read once`);
};

for (const mode of ["status", "reset"] as const) {
  test(`a long proof keeps what it proved over a failed read (${mode === "status" ? "a 503" : "a closed connection"}) while its tip advances`, async () => {
    await start(12);
    S1.state = up(150, { failOnce: { h: 100, mode } });                 // proves 150 down to 101, then a read fails
    assert.equal((await pass()).active, "primary");
    S1.state = up(151, { failOnce: { h: 150, mode } });                 // a block more; the read under it fails
    assert.equal((await pass()).active, "primary");
    S1.state = up(152, { failOnce: { h: 151, mode } });                 // and again
    assert.equal((await pass()).active, "primary");
    S1.state = up(153);
    const four = await pass();
    assert.equal(four.active, "sec1");
    readOnce(four.reads[1]!, 101, 149);                                  // the headers proved before are not read again
    assert.equal(await indexedHeight(), 153);
  });
}

test("the primary's tip moving inside a kept proof: a stored block under it still links it", async () => {
  await start(12);
  S1.state = up(158, { failOnce: { h: 60, mode: "status" } });         // kept: 158 down to 61
  assert.equal((await pass()).active, "primary");
  P.state = up(100);                                                    // the primary's tip moves to 100, inside
  const two = await pass();
  assert.equal(two.active, "sec1");
  readOnce(two.reads[1]!, 61, 157);
});

test("the primary's tip moving inside a kept proof near its top: the walk meets it there", async () => {
  await start(12);
  S2.state = up(157, { failOnce: { h: 60, mode: "status" } });
  assert.equal((await pass()).active, "primary");
  P.state = up(147);                                                    // 10 heights under the top, 48 over the index
  const two = await pass();
  assert.equal(two.active, "sec2");
  readOnce(two.reads[2]!, 13, 60);                                      // linked at the primary's tip, not at 12
});

test("a secondary's block is stored with its own figure when it is under the bound", async () => {
  await start(100);
  const low = CHAIN.slice(0, 101);
  low.push({ ...CHAIN[101]!, chainwork: String(BigInt(CHAIN[100]!.chainwork) + 1n) });
  P.state = down; S2.state = down; S1.state = up(101, { chain: low });
  await pass();
  assert.equal(await indexedHeight(), 101);
  assert.equal(await storedWork(101), low[101]!.chainwork);
});

test("a secondary's first block, with nothing stored under it, is stored with the node's figure", async () => {
  const from = CFG.scanFrom;
  CFG.scanFrom = 1;                                                     // height 1 is the first real header
  try {
    await resetStoreForTests();
    rpc.resetProofsForTests();
    P.state = down; S2.state = down; S1.state = up(5);
    await pass();
    assert.equal(await indexedHeight(), 5);
    assert.equal(await storedWork(1), CHAIN[1]!.chainwork);
    assert.equal(await storedWork(5), CHAIN[5]!.chainwork);
  } finally { CFG.scanFrom = from; }
});

// A header on block 100 that meets its own bits at the proof-of-work limit (nonce ground once), bits far easier than
// the chain's: cheap to make, and a backend serving such blocks could write a chain of its own at no cost.
const EASY_101 = { version: 1, prev: CHAIN[100]!.hash, merkle: "0xfa751eeb3c31f6208a7180a44b748ed18e240500c0388d03ae24dce208dedd60",
  time: 1781488021, bits: 0x1e00ffff, nonce: 1727327 };
const EASY_101_HASH = "0x0000001e0083f7a5aa282ffa6d9635a71268d7fb10d198cd04ca07693d5960fd";

test("a served block that meets its own bits at the proof-of-work limit, far under the chain's, is not written", async () => {
  await start(100);
  const easy = CHAIN.slice(0, 101);
  easy.push({ hash: EASY_101_HASH, height: 101, chainwork: String(BigInt(CHAIN[100]!.chainwork) + workForBits(EASY_101.bits)), header: EASY_101, txs: cb("e101") });
  P.state = down; S2.state = down; S1.state = up(101, { chain: easy });
  assert.equal((await pass()).indexed, 100);
  assert.ok(warnings.some((w) => w.includes("REFUSING block 101")));
  S1.state = up(111);                                                   // a new tip on the real chain: read again
  assert.equal((await pass()).indexed, 111);
});

test("the primary's tip just under a kept proof links it with no header read again", async () => {
  await start(12);
  S1.state = up(158, { failOnce: { h: 89, mode: "status" } });          // kept: 158 down to 90
  assert.equal((await pass()).active, "primary");
  P.state = up(89);
  const two = await pass();
  assert.equal(two.active, "sec1");
  readOnce(two.reads[1]!, 90, 157);
});

test("the primary's tip moving above a kept proof's top: the walk joins the proof", async () => {
  await start(12);
  S2.state = up(158, { failOnce: { h: 60, mode: "status" } });          // kept: 158 down to 61
  assert.equal((await pass()).active, "primary");
  // The primary claims 159 on a branch of its own, with less work than the secondary's tip at 160.
  P.state = alienTip(159, CHAIN[158]!.chainwork); S2.state = up(160);
  const two = await pass();
  assert.ok(!two.reads[2]!.some((h) => h >= 61 && h <= 157), "the kept headers are not read again");
});
