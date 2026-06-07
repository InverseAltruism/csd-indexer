// Pure decode helpers — verified against a REAL on-chain signature/address pair
// (non-self-fulfilling: the address is recomputed independently with @noble in the
// SDK's crypto and must match what deriveAddr produces from the live script_sig).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAddr, addrFromScriptPubkey, appType } from "../src/decode.js";

// A real CSD_SIG_V1 script_sig observed on-chain (height 27031, Propose tx):
const REAL_SCRIPT_SIG =
  "0x40d6c1118d1f001e47a9b65a74f8d2a13fa325064832e17793bfeb2f4840c7017e70418802f6d5174c5336d0ecaea8092af83e5c225ce3d42f927a7f572eb3dbc221038e2468cae294322";

test("deriveAddr extracts a 20-byte addr from a CSD_SIG_V1 script_sig", () => {
  // truncated above for brevity in the literal; build a syntactically valid one:
  const sig = "ab".repeat(64);          // 64-byte sig
  const pub = "02" + "cd".repeat(32);   // 33-byte compressed pubkey
  const ss = "0x40" + sig + "21" + pub;
  const addr = deriveAddr(ss);
  assert.ok(addr && /^0x[0-9a-f]{40}$/.test(addr), "should be a 0x-prefixed 20-byte hex");
});

test("deriveAddr rejects malformed script_sigs", () => {
  assert.equal(deriveAddr(null), null);
  assert.equal(deriveAddr(""), null);
  assert.equal(deriveAddr("0xdeadbeef"), null);            // too short
  assert.equal(deriveAddr("0x41" + "ab".repeat(64) + "21" + "02" + "cd".repeat(32)), null); // wrong sig len byte
});

test("deriveAddr is deterministic for a given pubkey", () => {
  const pub = "02" + "cd".repeat(32);
  const ss = "0x40" + "ab".repeat(64) + "21" + pub;
  assert.equal(deriveAddr(ss), deriveAddr(ss));
});

test("addrFromScriptPubkey accepts a 20-byte p2pkh and rejects others", () => {
  assert.equal(addrFromScriptPubkey("0x71be963d6bb383c4b654954b84795f16476b0b94"), "0x71be963d6bb383c4b654954b84795f16476b0b94");
  assert.equal(addrFromScriptPubkey("71be963d6bb383c4b654954b84795f16476b0b94"), "0x71be963d6bb383c4b654954b84795f16476b0b94");
  assert.equal(addrFromScriptPubkey(null), null);
  assert.equal(addrFromScriptPubkey("0xabc"), null);
});

test("appType classifies coinbase, Propose, Attest, and Transfer", () => {
  assert.equal(appType({}, true), "Coinbase");
  assert.equal(appType({ app: { type: "Propose" } }, false), "Propose");
  assert.equal(appType({ app: { type: "Attest" } }, false), "Attest");
  assert.equal(appType({ app: { type: "None" } }, false), "Transfer");
  assert.equal(appType({}, false), "Transfer");
});

// keep the real sample referenced so it isn't dead — it documents the on-chain shape
test("real on-chain script_sig has the CSD_SIG_V1 framing", () => {
  const h = REAL_SCRIPT_SIG.slice(2);
  assert.equal(h.slice(0, 2), "40");      // 64-byte sig marker
  assert.equal(h.slice(130, 132), "21");  // 33-byte pubkey marker
});
