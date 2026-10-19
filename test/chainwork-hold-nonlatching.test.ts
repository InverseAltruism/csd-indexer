// Two closes on the same guard, in one file because they share one branch of syncOnce.
//
// (1) IDX-CHAINWORK-NEG. IDX-CHAINWORK-ZERO classified a stored "0" above scanFrom as UNREADABLE, but
// wrote the test as `w === 0n` while its own stated rationale is "a figure we cannot read". Cumulative
// chainwork is a monotonically increasing unsigned quantity, so a stored NEGATIVE is impossible on any
// real chain, yet it parsed cleanly, left `ourWork > 0n` false, and reproduced the 2026-07-05 truncation
// through the identical path the zero case closes. Fixed by `w <= 0n`.
//
// (2) IDX-HOLD-NONLATCH. The fail-closed HOLD returns before reconcileTipWindow and the forward scan, and
// nothing else rewrites the tip row while held, so ONE transient poisoned payload froze ingestion
// permanently and the only exit was CSD_INDEX_WORK_GUARD=0, which disables the whole 2026-07-05 defense.
// Fixed by a hash-bound single-row self-heal from the currently selected backend: if the node still serves
// the SAME block with a readable positive chainwork, rewrite that one field and let the next poll
// re-evaluate. If it cannot, the UPDATE matches zero rows and the HOLD stands exactly as before.
//
// Exit-code gated: every claim is an assertion, so `tsx --test` exits non-zero the moment either fix is
// reverted. A printed HOLD line is observed, never treated as the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-cwhold-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });

type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
let OMIT_BLOCK_CHAINWORK = false;   // node re-serves our tip block but WITHOUT a readable chainwork
let TIP_WORK: string | null = null; // override /tip chainwork (models a db-loss resync presenting less work)
let WORK_EPOCH = 0;

// Payload shape copied field-for-field from a LIVE node response (127.0.0.1:8789 /block/height/67630,
// recorded 2026-08-02), so the honest arms run through syncOnce on exactly the shape production sends.
const REAL = {
  bits: 439936688, nonce: 2982576990, time: 1785701851, version: 1,
  cw0: 31025002999875138599n, cwStep: 1296454103367758n,   // real h67630 chainwork and the real h67630->67631 delta
  coinbasePrev: "0x" + "0".repeat(64), coinbaseVout: 4294967295,
  scriptSig: "0x2e080100000000000061c2a81781000000",
  scriptPubkey: "0x40379fb123bec901080bb94deeda2f457062b7bd",
  value: 5000000000,
};
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");

function blk(height: number, tag: string, prev: string, work: string): B {
  return {
    hash: h32(`blk-${tag}`), height, chainwork: work,
    header: { bits: REAL.bits, merkle: h32(`mk-${tag}`), nonce: REAL.nonce, prev, time: REAL.time + height * 60, version: REAL.version },
    txs: [
      { txid: h32(`cb-${tag}`), version: 1, locktime: height, app: { type: "None" },
        inputs: [{ prev_txid: REAL.coinbasePrev, vout: REAL.coinbaseVout, script_sig: REAL.scriptSig, script_sig_text: null }],
        outputs: [{ script_pubkey: REAL.scriptPubkey, value: REAL.value }] },
      { txid: h32(`prop-${tag}`), version: 1, locktime: 0,
        inputs: [{ prev_txid: h32("cb-g"), vout: 0, script_sig: REAL.scriptSig, script_sig_text: null }],
        outputs: [{ script_pubkey: "0x" + "c3".repeat(20), value: 1 }],
        app: { type: "Propose", domain: `dom-${tag}`, payload_hash: h32("ph"), uri: "u", expires_epoch: 9999 } },
    ],
  };
}
/** REAL positive chainwork, strictly increasing. */
function realWork(height: number): string { return String(REAL.cw0 + REAL.cwStep * BigInt(height) + BigInt(WORK_EPOCH)); }
/** The poison this file exists for: strictly NEGATIVE, which no chain can produce. */
function negWork(height: number): string { return String(-1000n - BigInt(height)); }
function buildChain(tags: string[], work: (h: number) => string): B[] {
  WORK_EPOCH++;
  const out: B[] = []; let prev = h32("genesis");
  tags.forEach((tag, i) => { const b = blk(i, tag, prev, work(i)); out.push(b); prev = b.hash; });
  return out;
}

const server: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
  const u = req.url || "";
  if (u === "/tip") {
    const t = CHAIN[CHAIN.length - 1];
    return res.end(JSON.stringify({ ok: true, tip: t?.hash ?? "", height: t?.height ?? 0, chainwork: TIP_WORK ?? t?.chainwork ?? "0" }));
  }
  const m = u.match(/^\/block\/height\/(\d+)$/);
  if (m) {
    const b = CHAIN[Number(m[1])];
    if (!b) { res.statusCode = 404; return res.end("{}"); }
    const body: Record<string, unknown> = { ok: true, ...b };
    if (OMIT_BLOCK_CHAINWORK) delete body.chainwork;
    return res.end(JSON.stringify(body));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;   // single mock backend; never poll the live fleet
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_cwhold";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "0";   // the floor must not MASK the guard behavior under test

const { syncOnce, indexedHeight, indexedChainwork } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const storedWork = async (h: number) =>
  ((await store().get("SELECT chainwork FROM blocks WHERE height=? AND orphaned=0", h)) as any)?.chainwork ?? null;
const propCount = async () => Number(((await store().get("SELECT COUNT(*) n FROM proposals")) as any).n);
/** poison the committed tip row directly: models a transient bad payload we already wrote */
const poison = async (h: number, v: string) => { await store().run("UPDATE blocks SET chainwork=? WHERE height=?", v, h); };

// capture console.warn so a HOLD can be observed (or its ABSENCE asserted) without being mistaken for the gate
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}
const held = (lines: string[]) => lines.some((l) => l.includes("HOLD"));

// ── PAIRED HAPPY-PATH: production's exact call shape, positive chainwork, branch never entered ──
test("HAPPY PATH: the live payload shape indexes, stores chainwork verbatim, and never enters the HOLD branch", async () => {
  await resetStoreForTests();
  OMIT_BLOCK_CHAINWORK = false; TIP_WORK = null;
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd"], realWork);
  const cap = captureWarn();
  try { await syncOnce(); await syncOnce(); } finally { cap.restore(); }
  assert.equal(await indexedHeight(), 4, "the honest chain indexes to its tip");
  assert.equal(held(cap.lines), false, "no HOLD and no self-heal on honest traffic (the whole risk of this fix)");
  for (let h = 0; h <= 4; h++) {
    assert.equal(await storedWork(h), CHAIN[h]!.chainwork, `height ${h} chainwork stored verbatim`);
  }
  assert.equal(await indexedChainwork(), BigInt(CHAIN[4]!.chainwork), "own-work parses exactly, guard armed as today");
  assert.equal(await propCount(), 5, "every canonical proposal indexed");
});

// ── (1) RED-FIRST: a stored NEGATIVE chainwork above scanFrom is UNREADABLE ──
test("IDX-CHAINWORK-NEG: a stored negative chainwork above scanFrom classifies as UNREADABLE", async () => {
  await resetStoreForTests();
  OMIT_BLOCK_CHAINWORK = false; TIP_WORK = null;
  CHAIN = buildChain(["g", "N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10"], negWork);   // 0..10
  await syncOnce();
  assert.equal(await indexedHeight(), 10, "the pass still ingests the whole chain (no new refusal at ingest)");
  assert.equal(await storedWork(10), negWork(10), "the negative is stored verbatim: this is a READ-side classification");
  assert.equal(await indexedChainwork(), null, "a negative at h=10 > scanFrom=0 is UNREADABLE, so the guard fails CLOSED");
  assert.equal(await propCount(), 11, "every canonical proposal indexed");
});

test("IDX-CHAINWORK-NEG: the 2026-07-05 shape HOLDs instead of truncating the index", async () => {
  // The node lost its db and is resyncing: SAME chain, only up to height 2, tip work far below ours.
  // Pre-fix a negative ourWork made `ourWork > 0n` false, the guard never fired, reconcileTipWindow
  // converged at 2 with mismatched=false and unwindAbove(2) deleted heights 3..10.
  CHAIN = buildChain(["g", "N1", "N2"], negWork);
  TIP_WORK = "1";
  const cap = captureWarn();
  let r;
  try { r = await syncOnce(); } finally { cap.restore(); }
  assert.equal(await indexedHeight(), 10, "indexed=10: the index was NOT truncated to the resync tip");
  assert.equal(await propCount(), 11, "canonical proposals intact (none deleted)");
  assert.equal(r.reorgs, 0, "reorgs=0");
  assert.equal(r.reorgDepth, 0, "depth=0");
  const storedHash10 = ((await store().get("SELECT hash FROM blocks WHERE height=10 AND orphaned=0", )) as any)?.hash;
  assert.equal(storedHash10, h32("blk-N10"), "our canonical tip block still present");
  // the node cannot re-serve height 10 at all while resyncing, so no self-heal is possible and the HOLD stands
  assert.equal(await storedWork(10), negWork(10), "and the poisoned row is untouched: nothing to heal from");
  assert.ok(cap.lines.some((l) => l.includes("HOLD:") && l.includes("unreadable")),
    "the fail-closed HOLD is the reason (observed, not the gate: the gate is the assertions above)");
});

// ── (2) RED-FIRST: the HOLD is NON-LATCHING when the node re-serves our tip block ──
test("IDX-HOLD-NONLATCH: a hash-matched readable payload self-heals the poisoned row and ingestion RESUMES", async () => {
  await resetStoreForTests();
  OMIT_BLOCK_CHAINWORK = false; TIP_WORK = null;
  CHAIN = buildChain(["g", "H1", "H2", "H3", "H4"], realWork);   // 0..4, honest and healthy
  await syncOnce();
  assert.equal(await indexedHeight(), 4, "precondition: healthy index at height 4");

  // one transient bad payload, already committed. Pre-fix this froze ingestion forever.
  await poison(4, "0");
  assert.equal(await indexedChainwork(), null, "precondition: own work now reads UNREADABLE");

  const cap1 = captureWarn();
  let r1;
  try { r1 = await syncOnce(); } finally { cap1.restore(); }
  assert.equal(r1.blocks, 0, "this pass still HOLDs: no reconcile, no unwind, no forward scan");
  assert.equal(r1.reorgs, 0, "and no reorg");
  assert.equal(await storedWork(4), CHAIN[4]!.chainwork,
    "the ONE field is rewritten from the hash-matched node payload (this is the fix)");
  assert.equal(await indexedChainwork(), BigInt(CHAIN[4]!.chainwork), "own work is readable again");
  assert.ok(cap1.lines.some((l) => l.includes("HOLD(self-heal)")),
    "self-heal is the reason (observed, not the gate)");

  // NON-LATCHING is the headline claim: the very next poll ingests forward again.
  const prev4 = CHAIN[4]!;
  CHAIN = [...CHAIN, blk(5, "H5", prev4.hash, realWork(5))];
  CHAIN = [...CHAIN, blk(6, "H6", CHAIN[5]!.hash, realWork(6))];
  const cap2 = captureWarn();
  try { await syncOnce(); } finally { cap2.restore(); }
  assert.equal(await indexedHeight(), 6, "NON-LATCHING: the next poll ingests forward (pre-fix it stayed at 4 forever)");
  assert.equal(held(cap2.lines), false, "and that poll holds nothing at all");
  assert.equal(await propCount(), 7, "every canonical proposal indexed");
});

// ── (2) HOLD-PRESERVED: the fail-closed posture is unchanged when the node cannot vouch for our tip ──
test("IDX-HOLD-NONLATCH: a HASH-MISMATCHED node block heals nothing and the HOLD stands", async () => {
  await resetStoreForTests();
  OMIT_BLOCK_CHAINWORK = false; TIP_WORK = null;
  CHAIN = buildChain(["g", "M1", "M2", "M3", "M4"], realWork);
  await syncOnce();
  assert.equal(await indexedHeight(), 4);
  await poison(4, "0");

  // the node now serves a DIFFERENT block at height 4 (its own tip disagrees with ours)
  const forked = blk(4, "M4-alt", CHAIN[3]!.hash, realWork(4));
  assert.notEqual(forked.hash, CHAIN[4]!.hash, "precondition: the node's height-4 hash differs from ours");
  CHAIN = [...CHAIN.slice(0, 4), forked];

  const cap = captureWarn();
  try { await syncOnce(); await syncOnce(); } finally { cap.restore(); }
  assert.equal(await storedWork(4), "0", "the UPDATE matched zero rows: the poisoned row is UNTOUCHED");
  assert.equal(await indexedChainwork(), null, "own work still UNREADABLE");
  assert.equal(await indexedHeight(), 4, "the HOLD stands: nothing unwound, nothing ingested");
  assert.equal(held(cap.lines), true, "held on both passes");
});

test("IDX-HOLD-NONLATCH: an UNREADABLE node chainwork heals nothing and the HOLD stands", async () => {
  await resetStoreForTests();
  OMIT_BLOCK_CHAINWORK = false; TIP_WORK = null;
  CHAIN = buildChain(["g", "U1", "U2", "U3", "U4"], realWork);
  await syncOnce();
  assert.equal(await indexedHeight(), 4);
  await poison(4, "0");

  OMIT_BLOCK_CHAINWORK = true;   // same block, same hash, but no readable figure to heal from
  const cap = captureWarn();
  try { await syncOnce(); await syncOnce(); } finally { cap.restore(); }
  assert.equal(await storedWork(4), "0", "nothing to heal from: the poisoned row is UNTOUCHED");
  assert.equal(await indexedChainwork(), null, "own work still UNREADABLE");
  assert.equal(await indexedHeight(), 4, "the HOLD stands (fail-closed exactly as before)");
  assert.ok(cap.lines.some((l) => l.includes("HOLD:") && l.includes("unreadable")),
    "and it is the ORIGINAL fail-closed HOLD message, not the self-heal one");
  assert.equal(cap.lines.some((l) => l.includes("HOLD(self-heal)")), false, "no self-heal was claimed");
  OMIT_BLOCK_CHAINWORK = false;
});

test.after(async () => { server.close(); await closeDb(); });
