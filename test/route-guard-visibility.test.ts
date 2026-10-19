// I9 (Q-03): when the F6 local-anchored plausibility arm of ROUTE-1 fail-softs to inert, say so once.
//
// rpc.ts's expectedLocalTarget is the fifth expectedBitsFromWindow caller and is wrapped in a bare
// `catch { return null; }`. A throw there (a malformed local window row) silently disarms the LWMA arm of
// ROUTE-1 for the life of the process: contenderPlausible reads null as "test inactive" and returns true.
// The fail-soft itself is deliberate and STAYS (the PoW arm and the delta cap remain armed, and hard-
// failing here would break legitimate failover). What is fixed is only the silence, which is the same
// silently-disarmed-guard class as I1: one module-level flag, one log line, no behavior change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { bitsToTarget, targetToBigInt, bigIntToTarget, targetToBits } from "@inversealtruism/csd-codec";
import { realHeader, realTipHash } from "./fixtures/header-32803.js";

const REAL_BITS = realHeader.bits;
const HARDER_BITS = targetToBits(bigIntToTarget(targetToBigInt(bitsToTarget(REAL_BITS)) / 256n));

type Cfg = { height: number; work: bigint; up: boolean; header: any; tipHash: string };
function mockNode(init: Partial<Cfg> = {}) {
  const c: Cfg = { height: 0, work: 0n, up: true, header: realHeader, tipHash: realTipHash, ...init };
  const srv: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
    if (!c.up) { res.statusCode = 503; return res.end("{}"); }
    if (req.url === "/tip") return res.end(JSON.stringify({ ok: true, height: c.height, chainwork: String(c.work), tip: c.tipHash }));
    if (req.url?.startsWith("/block/height/")) return res.end(JSON.stringify({ ok: true, hash: c.tipHash, height: c.height, chainwork: String(c.work), header: c.header, txs: [] }));
    res.statusCode = 404; res.end("{}");
  });
  return { srv, set(p: Partial<Cfg>) { Object.assign(c, p); }, url: () => `http://127.0.0.1:${(srv.address() as any).port}` };
}

const A = mockNode(), B = mockNode();
await new Promise<void>((r) => A.srv.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => B.srv.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = A.url();
process.env.CSD_RPC_BACKENDS = `${A.url()},${B.url()}`;
process.env.CSD_RPC_WORK_ESCAPE = "1000";
process.env.CSD_RPC_POW_TIMEOUT = "800";
process.env.CSD_RPC_MAX_AHEAD = "128";
process.env.CSD_RPC_MAX_EASE = "16";
const DB = `/tmp/csd-idx-guardvis-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_INDEX_PG_SCHEMA = "t_guardvis";

const rpc = await import("../src/rpc.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");

const LOCAL_TIP = 50;
async function populateLocal(bits: number) {
  await resetStoreForTests();
  const s = store();
  const tipTime = Math.floor(Date.now() / 1000);
  for (let h = 0; h <= LOCAL_TIP; h++) {
    await s.run("INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
      h, "0x" + h.toString(16).padStart(64, "0"), null, null, tipTime - (LOCAL_TIP - h) * 120, bits, 0, 1, 0, String(h * 1000));
  }
}
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}
const f6Lines = (lines: string[]) => lines.filter((l) => l.includes("F6 plausibility"));

// ── PAIRED HAPPY-PATH: a healthy local window logs NOTHING and keeps the same verdicts ──
// (runs first on purpose: the flag is module-level and one-shot, so the quiet case must be proved before
// the throw case ever fires it)
test("HAPPY PATH: a healthy local anchor logs nothing and the LWMA arm still excludes a too-easy contender", async () => {
  await populateLocal(HARDER_BITS);                      // valid bits, local anchor 256x harder than realHeader
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true });
  B.set({ height: LOCAL_TIP + 5, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash });
  const cap = captureWarn();
  let s;
  try { s = await rpc.selectBackend(); } finally { cap.restore(); }
  assert.equal(s.active, A.url(), "the too-easy contender is still excluded (verdict unchanged)");
  assert.equal(f6Lines(cap.lines).length, 0, "a healthy poll prints NOTHING new");
});

test("HAPPY PATH: an honest ahead-secondary at the correct difficulty is still selected, silently", async () => {
  await populateLocal(REAL_BITS);
  A.set({ height: LOCAL_TIP - 10, work: 100n, up: true });
  B.set({ height: LOCAL_TIP + 5, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash });
  const cap = captureWarn();
  let s;
  try { s = await rpc.selectBackend(); } finally { cap.restore(); }
  assert.equal(s.active, B.url(), "honest failover intact");
  assert.equal(f6Lines(cap.lines).length, 0, "still silent");
});

// ── I9 RED-FIRST: a malformed local window row disarms the arm, and that must be VISIBLE exactly once ──
test("I9: a malformed local window row prints exactly ONE line, and the verdict path is unchanged", async () => {
  await populateLocal(0);                                // bits=0 is invalid compact bits: expectedBitsFromWindow throws
  A.set({ height: LOCAL_TIP, work: 1_000n, up: true });
  B.set({ height: LOCAL_TIP + 5, work: 9_000_000_000n, up: true, header: realHeader, tipHash: realTipHash });
  const cap = captureWarn();
  let s;
  try { s = await rpc.selectBackend(); } finally { cap.restore(); }
  const lines = f6Lines(cap.lines);
  assert.equal(lines.length, 1, "exactly one journal line");
  assert.ok(lines[0]!.includes("INERT"), "the line says the arm is inert, which is the whole point");
  assert.equal(s.active, B.url(),
    "verdict UNCHANGED: the LWMA arm fail-softs to inactive exactly as before, the PoW + delta-cap arms still ran");
});

test("I9: 100 subsequent polls add ZERO further lines (bounded, never a journal flood)", async () => {
  const cap = captureWarn();
  try {
    for (let i = 0; i < 100; i++) await rpc.selectBackend();
  } finally { cap.restore(); }
  assert.equal(f6Lines(cap.lines).length, 0, "one line per process, not one per poll");
});

test.after(async () => {
  A.srv.closeAllConnections?.(); B.srv.closeAllConnections?.(); A.srv.close(); B.srv.close(); await closeDb();
});
