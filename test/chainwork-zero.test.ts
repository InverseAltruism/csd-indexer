// IDX-CHAINWORK-ZERO. I1 closed only the ABSENT-`chainwork` shape. A backend that SERVES `chainwork: "0"`
// still wrote the string "0", indexedChainwork() parsed it as a legitimate 0n, `ourWork > 0n` in the
// 2026-07-05 regression guard was false, the guard stayed inert, and reconcileTipWindow then walked a
// matching-but-SHORTER chain to converged = nodeTip with mismatched=false, so unwindAbove(nodeTip) deleted
// every row above it. The incident (~41k rows, /names emptied) reproduced identically POST-fix.
//
// Fix: a stored "0" at a height ABOVE scanFrom is UNREADABLE (null), which the existing fail-closed HOLD
// already handles. Bounded at `> scanFrom` so the honest paths below are untouched.
//
// Exit-code gated: every claim is an assertion, so `tsx --test` exits non-zero the moment the fix is
// reverted. A printed "HOLD:" line is observed, never treated as the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-cwzero-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });

type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
let TIP_WORK: string | null = null;   // override /tip chainwork (models a db-loss resync presenting less work)
let WORK_EPOCH = 0;

// Payload shape copied field-for-field from a LIVE node response (127.0.0.1:8789 /block/height/67630,
// recorded 2026-08-02): chainwork as a decimal STRING, header.version 1, header.nonce 2982576990 (a u32
// above int4 max), header.bits 439936688, the coinbase's all-zero prev_txid + vout 4294967295, and
// app.type "None". Only height/hash/prev/merkle/chainwork vary per test height, so the honest arms run
// through syncOnce on exactly the shape production sends.
const REAL = {
  bits: 439936688, nonce: 2982576990, time: 1785701851, version: 1,
  cw0: 31025002999875138599n, cwStep: 1296454103367758n,   // real h67630 chainwork and the real h67630->67631 delta
  coinbasePrev: "0x" + "0".repeat(64), coinbaseVout: 4294967295,
  scriptSig: "0x2e080100000000000061c2a81781000000",
  scriptPubkey: "0x40379fb123bec901080bb94deeda2f457062b7bd",
  value: 5000000000,
};
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");

/** `work` is the exact string the node serves for this block; null omits nothing, it serves "0". */
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
/** REAL positive chainwork, strictly increasing, each new chain out-working the last (heavier reorg). */
function realWork(height: number): string { return String(REAL.cw0 + REAL.cwStep * BigInt(height) + BigInt(WORK_EPOCH)); }
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
  if (m) { const b = CHAIN[Number(m[1])]; return b ? res.end(JSON.stringify({ ok: true, ...b })) : (res.statusCode = 404, res.end("{}")); }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;   // single mock backend; never poll the live fleet
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_cwzero";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "0";   // the floor must not MASK the guard behavior under test

const { syncOnce, indexedHeight, indexedChainwork } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const storedWork = async (h: number) =>
  ((await store().get("SELECT chainwork FROM blocks WHERE height=? AND orphaned=0", h)) as any)?.chainwork ?? null;
const propCount = async () => Number(((await store().get("SELECT COUNT(*) n FROM proposals")) as any).n);

// capture console.warn so a HOLD can be observed (or its ABSENCE asserted) without being mistaken for the gate
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}
const held = (lines: string[]) => lines.some((l) => l.includes("HOLD:"));

// ── PAIRED HAPPY-PATH: the real live payload shape, positive chainwork, unchanged end to end ──
test("HAPPY PATH: the live payload shape indexes, stores chainwork verbatim, and never HOLDs", async () => {
  await resetStoreForTests();
  TIP_WORK = null;
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd"], realWork);
  const cap = captureWarn();
  try { await syncOnce(); await syncOnce(); } finally { cap.restore(); }
  assert.equal(await indexedHeight(), 4, "the honest chain indexes to its tip");
  assert.equal(held(cap.lines), false, "no HOLD on honest traffic (the whole risk of this fix)");
  for (let h = 0; h <= 4; h++) {
    assert.equal(await storedWork(h), CHAIN[h]!.chainwork, `height ${h} chainwork stored verbatim`);
  }
  assert.equal(await indexedChainwork(), BigInt(CHAIN[4]!.chainwork), "own-work parses exactly, guard armed as today");
  assert.equal(await propCount(), 5, "every canonical proposal indexed");
});

test("HAPPY PATH: a genuinely heavier reorg still reconciles (no new refusal)", async () => {
  CHAIN = buildChain(["g", "Pa", "Pb", "Pz", "Py", "Px"], realWork);   // diverges at 3, out-works the prior chain
  const cap = captureWarn();
  let r;
  try { r = await syncOnce(); } finally { cap.restore(); }
  assert.ok(r.reorgs >= 1, "the honest heavier reorg is still adopted");
  assert.equal(await indexedHeight(), 5);
  assert.equal(held(cap.lines), false, "and it is adopted WITHOUT a HOLD");
});

// ── UX CARVE-OUT: a legitimately zero-work height AT the scan floor behaves exactly as before ──
test("HAPPY PATH: a genesis at scanFrom carrying chainwork '0' reads 0n and does NOT freeze ingestion", async () => {
  await resetStoreForTests();
  TIP_WORK = null;
  CHAIN = buildChain(["zg"], () => "0");                      // node tip IS genesis, cumulative work 0
  const cap1 = captureWarn();
  try { await syncOnce(); await syncOnce(); } finally { cap1.restore(); }
  assert.equal(await indexedHeight(), 0, "genesis ingests");
  assert.equal(await storedWork(0), "0", "the served '0' is stored verbatim");
  assert.equal(await indexedChainwork(), 0n, "AT scanFrom a stored '0' is still a real zero, not unreadable");
  assert.equal(held(cap1.lines), false, "no HOLD: a zero-work genesis must not fail closed");

  // and the loop keeps advancing once real-work blocks arrive on top of it
  const zg = CHAIN[0]!;
  let prev = zg.hash;
  CHAIN = [zg];
  for (const [i, tag] of ["z1", "z2", "z3"].entries()) {
    const b = blk(i + 1, tag, prev, realWork(i + 1)); CHAIN.push(b); prev = b.hash;
  }
  const cap2 = captureWarn();
  try { await syncOnce(); } finally { cap2.restore(); }
  assert.equal(await indexedHeight(), 3, "ingestion advances from a zero-work genesis");
  assert.equal(held(cap2.lines), false, "still no HOLD");
});

// ── RED-FIRST: a served "0" above scanFrom is UNREADABLE, and the incident cannot re-run ──
test("IDX-CHAINWORK-ZERO: a served chainwork '0' above scanFrom classifies as UNREADABLE", async () => {
  await resetStoreForTests();
  TIP_WORK = null;
  CHAIN = buildChain(["g", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"], () => "0");   // 0..10
  await syncOnce();
  assert.equal(await indexedHeight(), 10, "the pass still ingests the whole chain (no new refusal at ingest)");
  assert.equal(await storedWork(10), "0", "the '0' is stored verbatim: this is a READ-side classification, not a write change");
  assert.equal(await indexedChainwork(), null, "a '0' at h=10 > scanFrom=0 is UNREADABLE, so the guard fails CLOSED");
  assert.equal(await propCount(), 11, "every canonical proposal indexed");
});

test("IDX-CHAINWORK-ZERO: the 2026-07-05 shape HOLDs instead of truncating the index", async () => {
  // The node lost its db and is resyncing: SAME chain, only up to height 2, tip work far below ours.
  // Pre-fix ourWork was 0n, so `ourWork > 0n` was false, the guard never fired, reconcileTipWindow
  // converged at 2 with mismatched=false and unwindAbove(2) deleted heights 3..10.
  CHAIN = buildChain(["g", "P1", "P2"], () => "0");
  TIP_WORK = "1";
  const cap = captureWarn();
  let r;
  try { r = await syncOnce(); } finally { cap.restore(); }
  assert.equal(await indexedHeight(), 10, "indexed=10: the index was NOT truncated to the resync tip");
  assert.equal(await propCount(), 11, "canonical proposals intact (none deleted)");
  assert.equal(r.reorgs, 0, "reorgs=0");
  assert.equal(r.reorgDepth, 0, "depth=0");
  const storedHash10 = ((await store().get("SELECT hash FROM blocks WHERE height=10 AND orphaned=0")) as any)?.hash;
  assert.equal(storedHash10, h32("blk-P10"), "our canonical tip block still present");
  assert.ok(cap.lines.some((l) => l.includes("HOLD:") && l.includes("unreadable")),
    "the fail-closed HOLD is the reason (observed, not the gate: the gate is the assertions above)");
});

test.after(async () => { server.close(); await closeDb(); });
