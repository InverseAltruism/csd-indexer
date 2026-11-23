// ROUTE-1's link proof: a non-primary backend wins on height or work only with headers above a block the trusted view
// holds (the primary's tip or a stored block), each PoW-valid and hash-linked, at the heights the claim gives them.
// A backend that replays a header the index already holds, at a higher claimed height and with a huge claimed
// chainwork, passed the PoW and plausibility checks, won the selection and rewrote the index above the fork with its
// own blocks. The mocks serve REAL_CHAIN, 160 consecutive mainnet headers, so an honest contender proves real work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { tipHeaderPowOk } from "@inversealtruism/csd-light";
import { REAL_CHAIN } from "./fixtures/header-chain.js";
import { realTipHash } from "./fixtures/header-32803.js";
import { tmpDb } from "./_tmpdb.js";

const id = (tag: string) => "0x" + createHash("sha256").update(tag).digest("hex");
type Blk = { hash: string; height: number; chainwork: string; header: Record<string, unknown>; txs: unknown[] };
type Node = { tip: () => object; block: (h: number) => Blk | undefined };
function mock(n: Node) {
  let cur = n;
  const srv: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
    if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, ...cur.tip() }));
    const m = /^\/block\/height\/(\d+)$/.exec(req.url ?? ""), b = m ? cur.block(Number(m[1])) : undefined;
    if (!b) { res.statusCode = 404; return res.end("{}"); }
    res.end(JSON.stringify({ ok: true, ...b }));
  });
  return { srv, set(x: Node) { cur = x; }, url: () => `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}
const HONEST = "0x" + "a1".repeat(20), ATTACKER = "0x" + "ee".repeat(20);
const cb = (tag: string, to: string, value: number) => [{ txid: id(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: to, value }] }];
// A chain served by height: REAL_CHAIN[i] at height base + i, chainwork rising by 1000 a block.
function realAt(base: number, from: number, to: number, work0 = 0): Node {
  const block = (h: number): Blk | undefined => {
    const r = REAL_CHAIN[h - base];
    return h >= from && h <= to && r ? { hash: r.hash, height: h, chainwork: String(work0 + (h + 1) * 1000), header: r.header, txs: cb(`r-${h}`, HONEST, 50) } : undefined;
  };
  return { tip: () => { const b = block(to)!; return { height: to, tip: b.hash, chainwork: b.chainwork }; }, block };
}

const A = mock(realAt(0, 0, 0)), B = mock(realAt(0, 0, 0));
await new Promise<void>((r) => A.srv.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => B.srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = A.url();
process.env.CSD_RPC_BACKENDS = `${A.url()},${B.url()}`;
process.env.CSD_RPC_WORK_ESCAPE = "1000";
process.env.CSD_RPC_POW_TIMEOUT = "3000";
process.env.CSD_INDEX_DB = tmpDb("routelink");
process.env.CSD_INDEX_PG_SCHEMA = "t_routelink";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "2";
const rpc = await import("../src/rpc.js");
const { CFG } = await import("../src/config.js");
const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const q = await import("../src/queries.js");

test("the fixture: every header meets its bits and links to the one before", () => {
  REAL_CHAIN.forEach((r, i) => {
    assert.ok(tipHeaderPowOk(r.header, r.hash), `PoW at ${r.height}`);
    if (i) assert.equal(r.header.prev, REAL_CHAIN[i - 1]!.hash, `link at ${r.height}`);
  });
  assert.equal(REAL_CHAIN[7]!.hash, realTipHash, "block 32803 is the ROUTE-1 vector");
});

// Selection only: the index holds nothing, the primary's tip is REAL_CHAIN[20] at height 100.
async function select(b: Node): Promise<string> {
  await resetStoreForTests();
  A.set(realAt(80, 100, 100)); B.set(b);
  await rpc.selectBackend();                 // A, the primary, alone at first
  return (await rpc.selectBackend()).active;
}

test("honest: a secondary five real headers above the primary's tip wins", async () => {
  assert.equal(await select(realAt(80, 100, 105)), B.url());
});

// The index stores REAL_CHAIN[10..15] at 90..95; the primary's tip is elsewhere at 95.
async function storedThen(b: Node, workAt = (h: number): string | null => String(h * 1000)): Promise<string> {
  await resetStoreForTests();
  for (let h = 90; h <= 95; h++) {
    const r = REAL_CHAIN[h - 80]!;
    await store().run("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
      h, r.hash, r.header.prev, r.header.merkle, r.header.time, r.header.bits, r.header.nonce, 1, 1, workAt(h));
  }
  A.set({ tip: () => ({ height: 95, tip: id("primary-elsewhere"), chainwork: "95000" }), block: () => undefined });
  B.set(b);
  await rpc.selectBackend();
  return (await rpc.selectBackend()).active;
}

test("honest: a secondary on a branch from a stored block wins (the primary is behind it)", async () => {
  assert.equal(await storedThen(realAt(80, 90, 100)), B.url(), "links to the stored block 95 through five new headers");
});

test("honest: a branch from a stored block whose chainwork does not parse wins with its claimed work", async () => {
  assert.equal(await storedThen(realAt(80, 90, 100), (h) => (h === 95 ? null : String(h * 1000))), B.url());
});

test("replay: a stored block claimed at its own height with more work proves no new header", async () => {
  const n = realAt(80, 90, 95);
  assert.equal(await storedThen({ ...n, tip: () => ({ height: 95, tip: REAL_CHAIN[15]!.hash, chainwork: "9".repeat(30) }) }), A.url());
});

test("replay: the primary's own tip claimed 4 higher with a huge chainwork does not win", async () => {
  const tip = REAL_CHAIN[20]!;
  assert.equal(await select({ tip: () => ({ height: 104, tip: tip.hash, chainwork: "9".repeat(30) }),
    block: (h) => (h === 104 ? { hash: tip.hash, height: 104, chainwork: "9".repeat(30), header: tip.header, txs: [] } : undefined) }), A.url());
});

test("replay: the chain's real headers served 2 heights too high do not link and do not win", async () => {
  assert.equal(await select(realAt(82, 100, 106)), A.url());
});

test("replay: the primary's tip claimed at its own height with more work proves no new header", async () => {
  const n = realAt(80, 100, 100);
  assert.equal(await select({ ...n, tip: () => ({ height: 100, tip: REAL_CHAIN[20]!.hash, chainwork: "9".repeat(30) }) }), A.url());
});

test("a header that fails PoW in the middle of the walk breaks the proof", async () => {
  const n = realAt(80, 100, 105);
  assert.equal(await select({ ...n, block: (h) => {
    const b = n.block(h);
    return b && h === 102 ? { ...b, header: { ...b.header, nonce: Number(b.header.nonce) + 1 } } : b;
  } }), A.url());
});

test("with CSD_RPC_ROUTE_PLAUSIBILITY=0 the replay wins: the proof is what refuses it", async () => {
  CFG.routePlausibility = false;
  try {
    const tip = REAL_CHAIN[20]!;
    assert.equal(await select({ tip: () => ({ height: 104, tip: tip.hash, chainwork: "9".repeat(30) }),
      block: (h) => (h === 104 ? { hash: tip.hash, height: 104, chainwork: "9".repeat(30), header: tip.header, txs: [] } : undefined) }), B.url());
  } finally { CFG.routePlausibility = true; }
});

// The whole sequence through syncOnce: the index holds the honest chain 0..10 whose block 10 is the real 32803 header
// (and block 9 hashes to its prev); B serves the primary's blocks to 3, then blocks of its own paying ATTACKER, up to
// a claimed tip at 14 that is the replayed 32803 header, with a huge chainwork.
test("end to end: the replaying backend is not selected and the index stays the honest chain", async () => {
  await resetStoreForTests();
  const real = REAL_CHAIN[7]!;
  const honest: Blk[] = [];
  for (let h = 0, prev = "0x" + "00".repeat(32); h <= 10; h++) {
    const hash = h === 10 ? real.hash : h === 9 ? real.header.prev : id(`A-${h}`);
    const header = h === 10 ? real.header : { bits: real.header.bits, merkle: id(`A-mk-${h}`), nonce: 0, prev, time: real.header.time - (10 - h) * 120, version: 1 };
    honest.push({ hash, height: h, chainwork: String((h + 1) * 1000), header, txs: cb(`A-${h}`, HONEST, 50) });
    prev = hash;
  }
  const forged: Blk[] = honest.slice(0, 4);
  for (let h = 4, prev = honest[3]!.hash; h <= 14; h++) {
    const hash = h === 14 ? real.hash : h === 13 ? real.header.prev : id(`F-${h}`);
    const header = h === 14 ? real.header : { bits: real.header.bits, merkle: id(`F-mk-${h}`), nonce: 0, prev, time: real.header.time - (14 - h) * 120, version: 1 };
    forged.push({ hash, height: h, chainwork: "9".repeat(30), header, txs: cb(`F-${h}`, ATTACKER, 5_000_000) });
    prev = hash;
  }
  const serve = (c: Blk[]): Node => ({ tip: () => { const t = c[c.length - 1]!; return { height: t.height, tip: t.hash, chainwork: t.chainwork }; }, block: (h) => c[h] });
  A.set(serve(honest)); B.set(serve(honest));
  await syncOnce();
  assert.equal(await indexedHeight(), 10, "the honest chain is indexed");
  B.set(serve(forged));
  const r1 = await syncOnce(), r2 = await syncOnce();
  assert.equal(rpc.activeBackend(), A.url(), "the primary stays active");
  assert.equal(r1.reorgs + r2.reorgs, 0, "nothing is unwound");
  assert.equal(await indexedHeight(), 10);
  for (const h of [4, 9, 10]) assert.equal((await q.blockByHeight(h))?.hash, honest[h]!.hash, `height ${h} is the honest block`);
  assert.equal((await q.addressStats(ATTACKER)).utxo_count, 0, "no output of the forged branch is served");
});

test.after(async () => { A.srv.closeAllConnections?.(); B.srv.closeAllConnections?.(); A.srv.close(); B.srv.close(); await closeDb(); });
