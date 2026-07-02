// dbTx isolation guard (Plan 56 section 5 landmine; Plan 57 B1).
//
// The SQLite backend's read atomicity depends on an invariant enforced only by a comment at
// src/db.ts tx(): every await inside a dbTx callback must be a store call (microtask-only), so
// the event loop never runs HTTP readers between BEGIN and COMMIT on the shared connection.
// A future `await fetch(...)` / fs / timer inside a callback would let readers observe
// half-written blocks, and nothing caught it. This file is the missing guard, in two halves:
//
//   1. source scan: every dbTx call-site body in src/ is checked for real-I/O tokens.
//   2. runtime sentinel: a setImmediate armed at callback entry can only fire if the microtask
//      chain yields to the event loop; we run REAL writeBlock/unwindAbove transactions through
//      a wrapped store.tx and require the sentinel stayed silent. A negative control proves the
//      sentinel does fire on a deliberately yielding callback (so silence is meaningful).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { merkleRoot } from "@inversealtruism/csd-codec";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// ── half 1: source scan ──────────────────────────────────────────────────────
// B8c broadening (review finding F2): the original scan only DENYLISTED known I/O tokens, so an
// indirect await (`await getBlockFromNode(h)` whose fetch lives in another module) passed it.
// The scan is now allowlist-shaped: EVERY `await` inside a dbTx callback must await a call on
// the callback's own store parameter (`await d.run(...)` etc. — microtask-only by construction);
// any other awaited expression fails, direct or indirect. The token denylist stays as a second
// net (it also catches non-awaited timer scheduling). KNOWN REMAINING GAP (documented, accepted):
// a new file calling store().tx(...) inline without importing { tx } from "./db.js" is invisible
// to this scan; the runtime sentinel below only covers the writeBlock/unwind paths it drives.
const BANNED = [/\bfetch\s*\(/, /\brpc\./, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bsetImmediate\s*\(/, /node:fs/, /\breadFile/, /\bwriteFile/, /\bappendFile/, /\bsleep\s*\(/];

// Extract each `<alias>(async (param) ... => {` call site: its balanced-brace body + the
// callback's store-parameter name (so awaits can be checked against it).
function txCallbackSites(source: string, alias: string): { body: string; param: string | null }[] {
  const sites: { body: string; param: string | null }[] = [];
  const re = new RegExp(String.raw`\b${alias}\s*(?:<[^>]*>)?\(\s*async\s*\(?\s*([A-Za-z_$][\w$]*)?`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const open = source.indexOf("{", m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") { depth--; if (depth === 0) { sites.push({ body: source.slice(open, i + 1), param: m[1] ?? null }); break; } }
    }
  }
  return sites;
}

test("source scan: every await inside a dbTx callback targets the store param; no I/O tokens", () => {
  let sites = 0;
  for (const f of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(SRC, f), "utf8");
    // find what the db tx export is called locally in this file (import { tx as X } / { tx })
    const aliases = new Set<string>();
    const im = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/db\.js"/);
    const alias = im?.[1]?.match(/\btx(?:\s+as\s+(\w+))?/);
    if (alias) aliases.add(alias[1] ?? "tx");
    for (const alias of aliases) {
      for (const { body, param } of txCallbackSites(src, alias)) {
        sites++;
        assert.ok(param, `${f}: dbTx callback has no recognizable store parameter (scan pattern rotted?)`);
        // allowlist pass: every awaited expression must be a call on the store param
        for (const m of body.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\s*[.(]/g)) {
          assert.equal(m[1], param,
            `${f}: dbTx callback awaits '${m[0].trim()}…' — only 'await ${param}.<store call>' is microtask-safe inside a transaction (src/db.ts tx() isolation invariant); indirect I/O through a helper breaks read atomicity exactly like a direct fetch`);
        }
        // a bare 'await expr' that the allowlist regex can't attribute is also a failure (conservative)
        for (const m of body.matchAll(/\bawait\s+(?![A-Za-z_$][\w$]*\s*[.(])/g)) {
          assert.fail(`${f}: dbTx callback contains an await the scan cannot attribute to the store param (${JSON.stringify(body.slice(Math.max(0, m.index - 10), m.index + 30))}) — restructure to 'await ${param}.<call>'`);
        }
        for (const bad of BANNED) {
          assert.ok(!bad.test(body), `${f}: dbTx callback contains banned real-I/O token ${bad} (isolation invariant, src/db.ts tx())`);
        }
      }
    }
  }
  // anti-rot: the scan must keep finding the known call sites (indexer.ts writeBlock + unwind).
  assert.ok(sites >= 2, `expected >= 2 dbTx call sites in src/, found ${sites} (scan pattern rotted?)`);
});

// ── half 2: runtime sentinel over REAL transactions ──────────────────────────
const DB = `/tmp/csd-idx-dbtx-test-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch { /* absent */ } }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_dbtx";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";

const { writeBlock, unwindAbove } = await import("../src/indexer.js");
const { store, setMeta, resetStoreForTests, closeDb } = await import("../src/db.js");
await resetStoreForTests();
test.after(async () => { await closeDb(); for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch { /* gone */ } } });

// The isolation invariant (and so the sentinel) is SQLITE-specific: pg transactions run on a
// dedicated pooled connection where every store call is a real socket round-trip (macrotask), so
// the sentinel would fire on every pg tx by design while readers still cannot see uncommitted
// rows. The source scan above guards both backends; the runtime halves run on sqlite only
// (CI's test-postgres job runs this same glob with CSD_INDEX_PG set).
const SQLITE = store().backend === "sqlite";

const violations: string[] = [];
{
  const s = store();
  const orig = s.tx.bind(s);
  (s as { tx: typeof s.tx }).tx = (fn) =>
    orig(async (st) => {
      let turned = false;
      const h = setImmediate(() => { turned = true; });
      try { return await fn(st); }
      finally { clearImmediate(h); if (turned) violations.push("event loop turned inside a dbTx callback"); }
    });
}

// synthetic chain (same builders and `any` style as indexer.test.ts, minimal)
let nonce = 0;
const txid = (tag: string) => "0x" + Buffer.from(tag.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
const ADDR_A = "0x" + "a1".repeat(20);
function mkBlock(height: number, prev: string, txs: any[]): any {
  return {
    hash: "0x" + Buffer.from(`blk${height}_${nonce++}`.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0"),
    height, chainwork: String(height * 1000),
    header: { bits: 0x1e00ffff, merkle: merkleRoot(txs.map((t) => t.txid)), nonce, prev, time: 1700000000 + height, version: 1 },
    txs,
  };
}
const coinbase = (tag: string, to: string, value = 5_000_000_000) => ({
  txid: txid(tag), version: 1, locktime: 0, inputs: [{}], outputs: [{ script_pubkey: to.replace(/^0x/, ""), value }],
});

test("sentinel: real writeBlock + unwind transactions never yield to the event loop", { skip: !SQLITE }, async () => {
  const b0 = mkBlock(0, "0x" + "00".repeat(32), [coinbase("cb0", ADDR_A)]);
  await writeBlock(b0); await setMeta("indexed_height", "0");
  const cb1 = coinbase("cb1", ADDR_A);
  const spend = {
    txid: txid("spend1"), version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("cb0"), vout: 0, script_sig: "00" }],
    outputs: [{ script_pubkey: "b2".repeat(20), value: 4_000_000_000 }],
  };
  const b1 = mkBlock(1, b0.hash, [cb1, spend]);
  await writeBlock(b1); await setMeta("indexed_height", "1");
  await unwindAbove(0);
  assert.deepEqual(violations, [], "a dbTx callback yielded to the event loop (readers could see uncommitted rows)");
});

test("negative control: a yielding callback DOES trip the sentinel (silence above is meaningful)", { skip: !SQLITE }, async () => {
  const before = violations.length;
  // setImmediate (not setTimeout): queued FIFO behind the sentinel's own immediate, so the
  // sentinel deterministically fires first when the loop reaches the check phase.
  await store().tx(async () => { await new Promise((r) => setImmediate(r)); });
  assert.equal(violations.length, before + 1, "sentinel failed to detect a real event-loop turn");
});
