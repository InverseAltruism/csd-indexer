// Pure decode helpers. deriveAddr (csd-crypto's signerAddrFromScriptSig) is checked against a real on-chain scriptSig
// and its signer: every proposer and attester the indexer stores, and the resolver trusts, comes from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deriveAddr, addrFromScriptPubkey, appType } from "../src/decode.js";

// Input 0 of the cairnx:v1 Propose 0x43e9c34f7c8cead5808ada276835946a9307236c53fe9b932c17219a51c6d2c6, mined at height
// 65,507 (csd-sdk's GOLDEN_PROPOSE_TX carries the same tx). The node verified its signature against this pubkey, and
// the tx pays its change to the signer's address.
const REAL_SCRIPT_SIG =
  "0x40560c786b3fbbbb3ca566e586fc5b5cfaf78853fd55618ccebc1c9c5bd929b3225fbd6525c03919ebb289e5cb4a5abbb5d4e7ce79db6432de795acea25a5c1c6c21038e2468cae294322e242d476f20b581cd06def39782a4e76a12139b150338a35d";
const REAL_SIGNER = "0x44d92872a5b65d37d60ed532f41efe7c5aed59ec";

test("deriveAddr gives the known signer of a real on-chain scriptSig", () => {
  assert.equal(deriveAddr(REAL_SCRIPT_SIG), REAL_SIGNER);
  // the address is the pubkey's hash160, recomputed here with node:crypto (OpenSSL), not csd-crypto's @noble code
  const pub = Buffer.from(REAL_SCRIPT_SIG.slice(-66), "hex");
  assert.equal(REAL_SCRIPT_SIG.slice(-68, -66), "21");
  assert.equal("0x" + createHash("ripemd160").update(createHash("sha256").update(pub).digest()).digest("hex"), REAL_SIGNER);
});

test("deriveAddr rejects malformed script_sigs", () => {
  assert.equal(deriveAddr(null), null);
  assert.equal(deriveAddr(""), null);
  assert.equal(deriveAddr("0xdeadbeef"), null);            // too short
  assert.equal(deriveAddr("0x41" + "ab".repeat(64) + "21" + "02" + "cd".repeat(32)), null); // wrong sig len byte
  // B8c adoption pin: the SDK parser hex-VALIDATES the sig region (the retired local copy never
  // read those bytes, so a garbage sig region still attributed). Unreachable via node RPC
  // (script_sig is hex-encoded bytes) and proven delta-free over the full chain by csd-sdk's
  // audit:scriptsig; this fixture pins the accepted strictness locally.
  assert.equal(deriveAddr("0x40" + "zz".repeat(64) + "21" + "02" + "cd".repeat(32)), null); // non-hex sig region
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
