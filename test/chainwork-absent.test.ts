// I1 (O-1 / IDXC-1): a backend that OMITS the OPTIONAL `chainwork` field on a block payload must write
// SQL NULL, not the string "0".
//
// writeBlock used to store `String(blk.chainwork ?? "0")`, so an absent field became a legitimate-looking
// stored zero. indexedChainwork() then parsed it cleanly to 0n, `ourWork > 0n` in the 2026-07-05 regression
// guard was false, and the guard never fired: a node presenting FAR LESS accumulated work could drive a
// reconcile + unwind and hard-delete canonical rows (the ~41k-row, /names-emptied incident shape) with its
// primary defense silently switched off. Absent chainwork is UNREADABLE, and indexedChainwork() already
// classifies SQL NULL as unreadable, so the existing (already-tested) fail-closed HOLD fires instead.
//
// This file is exit-code gated: every claim below is an assertion, so `tsx --test` exits non-zero the
// moment the one-token fix is reverted. A printed "HOLD:" line is NOT a gate and is not treated as one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";

const DB = `/tmp/csd-idx-cwabsent-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });

type B = { hash: string; height: number; chainwork: string; header: any; txs: any[] };
let CHAIN: B[] = [];
let OMIT_BLOCK_CHAINWORK = false;   // the defect's trigger: the field is OPTIONAL in the RPC contract
let TIP_WORK: string | null = null; // override the /tip chainwork (models a db-loss resync presenting less work)
let WORK_EPOCH = 0;
const h32 = (s: string) => "0x" + Buffer.from(s.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
function blk(height: number, tag: string, prev: string): B {
  return {
    hash: h32(`blk-${tag}`), height, chainwork: String(height * 1000 + WORK_EPOCH * 1_000_000_000),
    header: { bits: 0x1e00ffff, merkle: h32(`mk-${tag}`), nonce: 0, prev, time: 1700000000 + height, version: 1 },
    txs: [
      { txid: h32(`cb-${tag}`), inputs: [], outputs: [{ script_pubkey: "0x" + "a1".repeat(20), value: 5000000000 }] },
      { txid: h32(`prop-${tag}`), inputs: [{ prev_txid: h32("cb-g"), vout: 0 }], outputs: [{ script_pubkey: "0x" + "c3".repeat(20), value: 1 }],
        app: { type: "Propose", domain: `dom-${tag}`, payload_hash: h32("ph"), uri: "u", expires_epoch: 9999 } },
    ],
  };
}
function buildChain(tags: string[]): B[] {
  WORK_EPOCH++;
  const out: B[] = []; let prev = h32("genesis");
  tags.forEach((tag, i) => { const b = blk(i, tag, prev); out.push(b); prev = b.hash; });
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
    if (OMIT_BLOCK_CHAINWORK) delete body.chainwork;   // the field is simply not there
    return res.end(JSON.stringify(body));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;   // single mock backend; never poll the live fleet
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_cwabsent";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";

const { syncOnce, indexedHeight, indexedChainwork } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const storedWork = async (h: number) =>
  ((await store().get("SELECT chainwork FROM blocks WHERE height=? AND orphaned=0", h)) as any)?.chainwork ?? null;
const propCount = async () => Number(((await store().get("SELECT COUNT(*) n FROM proposals")) as any).n);

// capture console.warn so the HOLD can be observed WITHOUT being mistaken for the gate
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}

// ── PAIRED HAPPY-PATH: every real payload carries chainwork, and those rows are untouched ──
test("HAPPY PATH: a payload WITH chainwork stores the served string verbatim and the guard reads it", async () => {
  await resetStoreForTests();
  OMIT_BLOCK_CHAINWORK = false; TIP_WORK = null;
  CHAIN = buildChain(["g", "Pa", "Pb", "Pc", "Pd"]);
  await syncOnce();
  assert.equal(await indexedHeight(), 4);
  for (let h = 0; h <= 4; h++) {
    assert.equal(await storedWork(h), CHAIN[h]!.chainwork, `height ${h} chainwork stored verbatim (byte-identical to the payload)`);
  }
  assert.equal(await indexedChainwork(), BigInt(CHAIN[4]!.chainwork), "own-work parses exactly, guard armed as today");
});

test("HAPPY PATH: with chainwork present, a genuinely heavier reorg still reconciles (no new refusal)", async () => {
  const heavier = buildChain(["g", "Pa", "Pb", "Pz", "Py", "Px"]);   // diverges at 3, out-works the prior chain
  CHAIN = heavier;
  const r = await syncOnce();
  assert.ok(r.reorgs >= 1, "the honest heavier reorg is still adopted");
  assert.equal(await indexedHeight(), 5);
});

// ── I1 RED-FIRST: absent chainwork must read as UNREADABLE, not as a legitimate zero ──
test("I1: an omitted chainwork field stores SQL NULL and indexedChainwork() reports UNREADABLE", async () => {
  await resetStoreForTests();
  OMIT_BLOCK_CHAINWORK = true; TIP_WORK = null;
  CHAIN = buildChain(["g", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"]); // 0..10
  await syncOnce();
  assert.equal(await indexedHeight(), 10, "the pass still ingests the whole chain (no new refusal at ingest)");
  assert.equal(await storedWork(10), null, "absent chainwork is SQL NULL, NOT the string '0'");
  assert.equal(await indexedChainwork(), null, "null classifies as UNREADABLE, so the guard fails CLOSED");
  assert.equal(await propCount(), 11, "every canonical proposal indexed");
});

test("I1: a far-lower-work node then HOLDS instead of truncating the index (the 2026-07-05 shape)", async () => {
  // The node lost its db and is resyncing: SAME chain, only up to height 2, tip work far below ours.
  CHAIN = buildChain(["g", "P1", "P2"]);
  TIP_WORK = "1";
  const cap = captureWarn();
  let r;
  try { r = await syncOnce(); } finally { cap.restore(); }
  assert.equal(r.reorgs, 0, "reorgs=0");
  assert.equal(r.reorgDepth, 0, "depth=0");
  assert.equal(await indexedHeight(), 10, "indexed=10: the index was NOT truncated to the resync tip");
  assert.equal(await propCount(), 11, "canonical proposals intact (none deleted)");
  const storedHash10 = ((await store().get("SELECT hash FROM blocks WHERE height=10 AND orphaned=0")) as any)?.hash;
  assert.equal(storedHash10, h32("blk-P10"), "our canonical tip block still present");
  assert.ok(cap.lines.some((l) => l.includes("HOLD:") && l.includes("unreadable")),
    "the fail-closed HOLD is the reason (observed, not the gate: the gate is the assertions above)");
});

test("I1: CSD_INDEX_WORK_GUARD=0 is still the operator override for a persistently chainwork-less feed", async () => {
  // Honest caveat, asserted rather than only documented: the HOLD is fail-closed and would freeze ingestion
  // if a backend NEVER served chainwork. The documented escape hatch must actually work.
  process.env.CSD_INDEX_WORK_GUARD = "0";
  const { CFG } = await import("../src/config.js");
  const prev = CFG.workGuard;
  (CFG as { workGuard: boolean }).workGuard = false;
  try {
    CHAIN = buildChain(["g", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]); // 0..11
    TIP_WORK = null;
    await syncOnce();
    assert.equal(await indexedHeight(), 11, "with the guard overridden the loop advances again");
  } finally {
    (CFG as { workGuard: boolean }).workGuard = prev;
    delete process.env.CSD_INDEX_WORK_GUARD;
  }
});

test.after(async () => { server.close(); await closeDb(); });
