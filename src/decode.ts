// Pure decoding helpers: recover addresses from scripts and classify a tx by its
// CSD app action. No DB, no network: unit-testable in isolation.
//   script_pubkey (p2pkh)   = the 20-byte addr hash, hex
// The scriptSig parser lives in csd-crypto since 0.1.15 (Plan 57 B4/B8c): deriveAddr is the
// SDK's signerAddrFromScriptSig (SCANNER contract: >=198 bytes, trailing bytes tolerated, no
// signature verify), a drop-in for the byte-identical local copy this file carried. The swap is
// gated by csd-sdk's audit:scriptsig full-chain differential (zero deltas over every input).
// addrFromScriptPubkey is csd-crypto's since 0.1.19: the node's address parser (parse_addr20), which also
// accepts surrounding whitespace; the node's RPC writes every script_pubkey as 0x + 40 lowercase hex.
import { signerAddrFromScriptSig } from "@inversealtruism/csd-crypto";

/** Recover the signer's addr20 from a CSD_SIG_V1 script_sig. null if unparseable. */
export const deriveAddr = signerAddrFromScriptSig;

/** addr20 (lowercase 0x form) from an output script_pubkey; null for anything the node's parser refuses. */
export { addrFromScriptPubkey } from "@inversealtruism/csd-crypto";

export type AppType = "Propose" | "Attest" | "Coinbase" | "Transfer";

/** Classify a tx by its app field; `isCoinbase` is decided by the caller (pos 0). */
export function appType(tx: { app?: any }, isCoinbase: boolean): AppType {
  if (isCoinbase) return "Coinbase";
  const t = tx.app && typeof tx.app === "object" ? tx.app.type : undefined;
  if (t === "Propose") return "Propose";
  if (t === "Attest") return "Attest";
  return "Transfer";
}
