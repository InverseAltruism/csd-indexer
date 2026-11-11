// A txid the chain holds in two blocks has one row, at its first occurrence: the lowest height that holds it and
// its position there (csd-sdk `packages/cairnx/CONVENTION.md` section 32, M4). A later occurrence moves nothing
// and emits no event; tx_repeats lists it, so each block's transaction list stays whole and its proofs fold. The
// property that covers every sequence: after any unwind or re-write the tables equal a fresh index of the chain
// that is left. syncOnce runs against a mock node (the call shape production runs); the seeded walk drives
// writeBlock and unwindAbove as syncOnce does.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { verifyMerkleProof } from "@inversealtruism/csd-codec";
import { tmpDb } from "./_tmpdb.js";
import { type Blk, type Tx, DOMAIN, MINER, PAYEE, attest, block, coinbase, dump, mockNode, propose, repeatChain, spend } from "./_repeat-chain.js";
import type { IndexEvent } from "../src/events.js";
import type { Store } from "../src/db.js";

let CHAIN: Blk[] = [];
const node = await mockNode(() => CHAIN);
process.env.CSD_RPC = node.url;
process.env.CSD_INDEX_DB = tmpDb("first-occurrence");
process.env.CSD_INDEX_PG_SCHEMA = "t_first_occurrence";
delete process.env.CSD_INDEX_FROM;   // the default start, height 0 (test/first-occurrence-floor.test.ts starts above it)
process.env.CSD_CONFIRMATIONS_FINAL = "6";

const { syncOnce, writeBlock, unwindAbove, indexedHeight } = await import("../src/indexer.js");
const { store, setMeta, resetStoreForTests, closeDb } = await import("../src/db.js");
const { bus } = await import("../src/events.js");
const q = await import("../src/queries.js");
const { buildApp } = await import("../src/server.js");

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };
test.after(async () => { srv.close(); node.close(); await closeDb(); });

const { C1, Y, P, A, X2, X3, X5, D, S, main } = repeatChain();
const txidsOf = (b: Blk) => b.txs.map((t) => t.txid);
const one = async (sql: string, ...p: unknown[]) => JSON.parse(JSON.stringify(await store().get(sql, ...p) ?? null));
const all = async (sql: string, ...p: unknown[]) => JSON.parse(JSON.stringify(await store().all(sql, ...p)));
/** The node now serves `chain`; one pass must reach its tip, through a reorg when the index held another branch. */
async function sync(chain: Blk[]): Promise<number> {
  CHAIN = chain;
  const r = await syncOnce();
  assert.equal(await indexedHeight(), chain.length - 1, "one pass reached the node's tip");
  return r.blocks;
}

test("syncOnce: a coinbase, a Propose and an Attest held by two blocks keep the lower height in every table, and emit once", async () => {
  await resetStoreForTests();
  const events: IndexEvent[] = [];
  const off = bus.onEvent((e) => events.push(e));
  try { await sync(main); } finally { off(); }

  assert.deepEqual(await all("SELECT txid, height, pos FROM txs WHERE txid IN (?,?,?) ORDER BY height", C1.txid, P.txid, A.txid),
    [{ txid: C1.txid, height: 1, pos: 0 }, { txid: P.txid, height: 2, pos: 1 }, { txid: A.txid, height: 3, pos: 1 }]);
  assert.deepEqual(await all("SELECT txid, height, spent_txid, spent_height FROM outputs WHERE txid IN (?,?,?) ORDER BY height", C1.txid, P.txid, A.txid), [
    { txid: C1.txid, height: 1, spent_txid: P.txid, spent_height: 2 },
    { txid: P.txid, height: 2, spent_txid: A.txid, spent_height: 3 },
    { txid: A.txid, height: 3, spent_txid: D.txid, spent_height: 4 },   // S spends it again at 6: the row keeps D
  ]);
  assert.deepEqual(await one("SELECT height FROM proposals WHERE txid=?", P.txid), { height: 2 });
  assert.deepEqual(await one("SELECT height FROM attestations WHERE txid=?", A.txid), { height: 3 });
  assert.deepEqual(await all("SELECT DISTINCT txid, height FROM address_history WHERE txid IN (?,?,?) ORDER BY height", C1.txid, P.txid, A.txid),
    [{ txid: C1.txid, height: 1 }, { txid: P.txid, height: 2 }, { txid: A.txid, height: 3 }]);
  assert.deepEqual(await all("SELECT height, pos, txid FROM tx_repeats ORDER BY height, pos"),
    [{ height: 4, pos: 0, txid: C1.txid }, { height: 5, pos: 2, txid: P.txid }, { height: 5, pos: 3, txid: A.txid }]);
  // C1's output is counted once: the miner's coinbase txids are those of heights 0, 1, 2, 3, 5 and 6
  assert.deepEqual(await one("SELECT outputs, value FROM coinbase_totals WHERE addr=?", MINER), { outputs: 6, value: 300 });
  // S is a first occurrence: written whole, although the output it spends keeps its first spender
  assert.deepEqual(await one("SELECT height, fee FROM txs WHERE txid=?", S.txid), { height: 6, fee: 2 });
  assert.equal((await get(`/tx/${P.txid}/status`)).body.block_height, 2);
  assert.deepEqual((await get(`/address/${PAYEE}/txs`)).body.filter((t: any) => t.txid === P.txid).map((t: any) => t.height), [2],
    "an address lists the txid once");

  // the bus: one record event per txid, at the first occurrence; every block announced with its full count
  assert.deepEqual(events.flatMap((e) => (e.kind === "proposal" ? [[e.txid, e.height]] : [])), [[P.txid, 2]]);
  assert.deepEqual(events.flatMap((e) => (e.kind === "attestation" ? [[e.txid, e.height]] : [])), [[A.txid, 3]]);
  assert.deepEqual(events.flatMap((e) => (e.kind === "block" ? [[e.height, e.tx_count]] : [])), main.map((b) => [b.height, b.txs.length]));

  // the chain-order feeds: once, at the first place, at a snapshot above the second block and between the two
  const feed = async (path: string, at: number) => (await get(`${path}?domain=${encodeURIComponent(DOMAIN)}&at=${at}`)).body.rows.map((r: any) => [r.txid, r.height, r.pos]);
  for (const at of [6, 5, 4, 3, 2]) assert.deepEqual(await feed("/proposals", at), [[P.txid, 2, 1]], `proposals at ${at}`);
  assert.deepEqual(await feed("/proposals", 1), [], "below the first occurrence");
  for (const at of [6, 5, 4, 3]) assert.deepEqual(await feed("/attestations", at), [[A.txid, 3, 1]], `attestations at ${at}`);
  assert.deepEqual(await feed("/attestations", 2), []);
  assert.deepEqual((await get(`/domain/${encodeURIComponent(DOMAIN)}/proposals?from=0`)).body.map((r: any) => [r.txid, r.height]), [[P.txid, 2]]);
  assert.deepEqual((await get(`/proposal/${P.txid}`)).body.attestations.map((a: any) => [a.txid, a.height]), [[A.txid, 3]]);
});

test("syncOnce: every block lists all its transactions and each proof folds to that block's header root", async () => {
  await resetStoreForTests();
  await sync(main);
  for (const b of main) {
    assert.deepEqual(await q.blockTxids(b.height), txidsOf(b), `blockTxids ${b.height}`);
    assert.deepEqual((await get(`/block/${b.hash}/txids`)).body, txidsOf(b), `/txids ${b.height}`);
    const rows = (await get(`/block/${b.hash}/txs`)).body;
    assert.deepEqual(rows.map((t: any) => t.txid), txidsOf(b), `/txs ${b.height}`);
    for (const row of rows) assert.deepEqual(row, JSON.parse(JSON.stringify(await q.tx(row.txid))), "each row is the txid's one row");
  }
  // a transaction no other block holds, from each block; then each repeated txid, proven in its first block
  const cases: [Tx, Blk][] = [[Y, main[1]!], [X2, main[2]!], [X3, main[3]!], [D, main[4]!], [X5, main[5]!], [S, main[6]!],
    [C1, main[1]!], [P, main[2]!], [A, main[3]!]];
  for (const [t, b] of cases) {
    const proof = (await get(`/tx/${t.txid}/merkle-proof`)).body;
    assert.equal(proof.block_height, b.height);
    assert.equal(proof.merkle_root, b.header.merkle, "the stored header root");
    assert.ok(verifyMerkleProof(t.txid, proof.pos, proof.merkle, b.header.merkle), `the proof in block ${b.height} folds`);
  }
});

// The rule rests on how syncOnce calls writeBlock: heights ascending without a gap from the start height, and
// no height below the stored tip. `watchBlockWrites` records each block row written and the highest height stored
// just before it.
function watchBlockWrites(): { writes: { height: number; tipBefore: number | null }[]; stop: () => void } {
  const s = store();
  const original = s.tx;
  const writes: { height: number; tipBefore: number | null }[] = [];
  const watched = (d: Store): Store => new Proxy(d, {
    get: (target, prop) => {
      const v: unknown = Reflect.get(target, prop, target);
      if (prop !== "run") return typeof v === "function" ? v.bind(target) : v;
      return async (sql: string, ...p: unknown[]) => {
        if (/^\s*INSERT INTO blocks\b/.test(sql)) {
          const r = await target.get<{ h: number | null }>("SELECT MAX(height) AS h FROM blocks");
          writes.push({ height: Number(p[0]), tipBefore: r?.h == null ? null : Number(r.h) });
        }
        return target.run(sql, ...p);
      };
    },
  });
  s.tx = <T>(fn: (d: Store) => Promise<T>) => original.call(s, (d: Store) => fn(watched(d))) as Promise<T>;
  return { writes, stop: () => { s.tx = original; } };
}

test("syncOnce: through reorgs each block is written one above the stored tip, and the tables equal a fresh sync", async () => {
  // Each branch carries more work than the one it replaces, as a node's switch does.
  const q5 = block(main[4]!, "q5", [coinbase("q5"), X5], 10_000);
  const r4 = block(main[3]!, "r4", [coinbase("r4"), D], 100_000), r5 = block(r4, "r5", [coinbase("r5")], 100_000);
  const n2 = block(main[1]!, "n2", [coinbase("n2"), X2], 1_000_000), n3 = block(n2, "n3", [coinbase("n3"), P], 1_000_000);
  const n4 = block(n3, "n4", [coinbase("n4"), spend("z", X2, 40), P], 1_000_000);
  const o2 = block(main[1]!, "o2", [coinbase("o2"), X2], 10_000_000), o3 = block(o2, "o3", [coinbase("o3")], 10_000_000);
  const plan: [string, Blk[]][] = [
    ["each txid twice", main],
    ["the second occurrences of P and A removed, and S's spend of A's output", [...main.slice(0, 5), q5]],
    ["the second occurrence of C1 removed", [...main.slice(0, 4), r4, r5]],
    ["both occurrences of P removed, P mined again once", [...main.slice(0, 2), n2, n3]],
    ["P mined again twice", [...main.slice(0, 2), n2, n3, n4]],
    // a shorter branch: no block is written at the height that listed P's second occurrence
    ["both removed, P not mined at all", [...main.slice(0, 2), o2, o3]],
  ];
  const fresh: Record<string, unknown[]>[] = [];
  for (const [, chain] of plan) { await resetStoreForTests(); await sync(chain); fresh.push(await dump(store())); }

  await resetStoreForTests();
  const watch = watchBlockWrites();
  try {
    let synced = 0;
    for (const [i, [note, chain]] of plan.entries()) {
      synced += await sync(chain);
      assert.deepEqual(await dump(store()), fresh[i], `${note}: the tables differ from a fresh sync of the same chain`);
      if (chain[chain.length - 1] !== n4) continue;
      // a tip pointer one behind the stored tip (a stop between the block's commit and the pointer's write):
      // the tip block, which lists a repeat, is written again in place
      await setMeta("indexed_height", String(n4.height - 1));
      const appends = watch.writes.length;
      assert.equal(await sync(chain), 1);
      assert.deepEqual(watch.writes.splice(appends), [{ height: n4.height, tipBefore: n4.height }], "only the tip block was written again");
      assert.deepEqual(await dump(store()), fresh[i], "the tip written again: the tables differ from a fresh sync");
    }
    assert.equal(watch.writes.length, synced, "every block syncOnce reported was seen");
    assert.equal(watch.writes[0]?.height, 0, "an empty index starts at height 0");
    for (const w of watch.writes) assert.equal(w.tipBefore, w.height === 0 ? null : w.height - 1, `block ${w.height} written over a stored tip of ${w.tipBefore}`);
  } finally { watch.stop(); }
});

// ── fresh equals incremental, by seeded walk ──
// A step is a block write (an append, the tip block written again, or another block written at the tip height)
// or an unwind, the calls syncOnce makes; `chain` is what the index holds afterwards. meta is left out: syncOnce
// writes it, not writeBlock.
type Step = { op: "write" | "unwind"; chain: Blk[]; note: string };
const state = () => dump(store(), ["meta"]);
async function assertEqualsFresh(steps: Step[], compare: (s: Step, i: number) => boolean): Promise<number> {
  const fresh = new Map<string, Record<string, unknown[]>>();
  const key = (c: Blk[]) => c.map((b) => b.hash).join(",");
  for (const [i, s] of steps.entries()) {
    if (!compare(s, i) || fresh.has(key(s.chain))) continue;
    await resetStoreForTests();
    for (const b of s.chain) await writeBlock(b);
    fresh.set(key(s.chain), await state());
  }
  await resetStoreForTests();
  let compared = 0;
  for (const [i, s] of steps.entries()) {
    if (s.op === "unwind") await unwindAbove(s.chain.length - 1); else await writeBlock(s.chain[s.chain.length - 1]!);
    if (!compare(s, i)) continue;
    assert.deepEqual(await state(), fresh.get(key(s.chain)), `step ${i} (${s.note}): the tables differ from a fresh index of the same chain`);
    compared++;
  }
  return compared;
}

// mulberry32: deterministic, so a failure reproduces from the seed
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Random blocks on top of `below`: the coinbase or any other transaction may be one the chain (or the block)
// already holds, a new transaction spends output 0 of one the chain holds, spent before or not, and may be a
// Propose or an Attest. Then random appends, unwinds of one to four blocks, the tip written again and the tip
// replaced in place.
function walk(seed: number, count: number): Step[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  let serial = 0;
  const tag = () => `walk-${seed}-${serial++}`;
  const next = (below: Blk[]): Blk => {
    const held = below.flatMap((b) => b.txs);
    const coinbases = below.map((b) => b.txs[0]!), proposals = held.filter((t) => t.app?.type === "Propose");
    const txs = [coinbases.length && r() < 0.3 ? pick(coinbases) : coinbase(tag())];
    for (let n = Math.floor(r() * 4); n > 0; n--) {
      const k = r(), of = pick([...held, ...txs]), value = 1 + Math.floor(r() * 40);
      txs.push(k < 0.3 ? of : k < 0.5 ? propose(tag(), of, value) : k < 0.7 && proposals.length ? attest(tag(), of, value, pick(proposals)) : spend(tag(), of, value));
    }
    return block(below[below.length - 1] ?? null, tag(), txs);
  };
  const steps: Step[] = [];
  let chain: Blk[] = [];
  for (let i = 0; i < count; i++) {
    const x = r();
    if (chain.length === 0 || x < 0.5) { chain = [...chain, next(chain)]; steps.push({ op: "write", chain, note: "append" }); }
    else if (x < 0.8) { chain = chain.slice(0, Math.max(0, chain.length - 1 - Math.floor(r() * 4))); steps.push({ op: "unwind", chain, note: "unwind" }); }
    else if (x < 0.9) steps.push({ op: "write", chain, note: "the tip written again" });
    else { chain = [...chain.slice(0, -1), next(chain.slice(0, -1))]; steps.push({ op: "write", chain, note: "the tip replaced in place" }); }
  }
  return steps;
}

test("fresh equals incremental: seeded walks of appends, unwinds and tip re-writes over chains with repeated txids", async () => {
  for (const seed of [11, 13]) {
    const steps = walk(seed, 40);
    // an append onto tables already found equal runs the same statements on both sides, so the other steps are compared
    const compare = (s: Step, i: number) => s.note !== "append" || i === steps.length - 1;
    const twice = (s: Step) => new Set(s.chain.flatMap(txidsOf)).size < s.chain.flatMap(txidsOf).length;
    const telling = steps.filter((s, i) => compare(s, i) && twice(s)).length;
    assert.ok(telling >= 10, `seed ${seed}: only ${telling} compared steps left a chain that holds a txid twice`);
    assert.ok(await assertEqualsFresh(steps, compare) >= telling);
  }
});

test("an index created before tx_repeats gains the table at start, keeps its rows and then lists a repeat", async () => {
  const honest = main.slice(0, 4);
  await resetStoreForTests();
  await sync(honest);
  assert.deepEqual(await all("SELECT * FROM tx_repeats"), [], "HAPPY PATH: a chain with no repeated txid writes no tx_repeats row");
  for (const b of honest) {
    assert.deepEqual(await q.blockTxids(b.height), txidsOf(b));
    assert.deepEqual((await q.blockTxs(b.height)).map((t) => [t.txid, t.height, t.pos]), b.txs.map((t, pos) => [t.txid, b.height, pos]));
  }
  const before = await dump(store(), ["tx_repeats"]);
  await store().exec("DROP TABLE tx_repeats");   // every other table and row as the release before this table wrote them
  await closeDb();
  assert.deepEqual(await dump(store()), { ...before, tx_repeats: [] }, "the next start created the table and changed no row");
  await sync(main.slice(0, 5));
  assert.deepEqual(await all("SELECT height, pos, txid FROM tx_repeats"), [{ height: 4, pos: 0, txid: C1.txid }]);
  assert.deepEqual(await q.blockTxids(4), txidsOf(main[4]!));
  assert.deepEqual(await one("SELECT height FROM txs WHERE txid=?", C1.txid), { height: 1 });
});
