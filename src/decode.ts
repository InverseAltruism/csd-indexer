// Pure decoding helpers: recover addresses from scripts and classify a tx by its
// CSD app action. No DB, no network — unit-testable in isolation. Mirrors the
// convention Cairn's scanner uses (and that the SDK's crypto.hash160 implements):
//   address = hash160(pubkey33) = ripemd160(sha256(pubkey))
//   script_sig (CSD_SIG_V1) = [0x40][sig 64B][0x21][pubkey 33B]
//   script_pubkey (p2pkh)   = the 20-byte addr hash, hex
import { createHash } from "node:crypto";

function hash160(buf: Buffer): string {
  const sha = createHash("sha256").update(buf).digest();
  return "0x" + createHash("ripemd160").update(sha).digest("hex");
}

/** Recover the signer's addr20 from a CSD_SIG_V1 script_sig. null if unparseable. */
export function deriveAddr(scriptSig: string | null | undefined): string | null {
  if (!scriptSig) return null;
  const h = (scriptSig.startsWith("0x") ? scriptSig.slice(2) : scriptSig).toLowerCase();
  if (h.length < 2 + 128 + 2 + 66) return null;
  if (h.slice(0, 2) !== "40") return null;       // 0x40 → 64-byte sig follows
  if (h.slice(130, 132) !== "21") return null;   // 0x21 → 33-byte pubkey follows
  const pub = h.slice(132, 132 + 66);
  if (!/^[0-9a-f]{66}$/.test(pub)) return null;
  try { return hash160(Buffer.from(pub, "hex")); } catch { return null; }
}

/** addr20 from a p2pkh output script_pubkey (already the 20-byte hash, hex). */
export function addrFromScriptPubkey(spk: string | null | undefined): string | null {
  if (!spk) return null;
  const h = spk.startsWith("0x") ? spk.slice(2) : spk;
  return /^[0-9a-f]{40}$/i.test(h) ? "0x" + h.toLowerCase() : null;
}

export type AppType = "Propose" | "Attest" | "Coinbase" | "Transfer";

/** Classify a tx by its app field; `isCoinbase` is decided by the caller (pos 0). */
export function appType(tx: { app?: any }, isCoinbase: boolean): AppType {
  if (isCoinbase) return "Coinbase";
  const t = tx.app && typeof tx.app === "object" ? tx.app.type : undefined;
  if (t === "Propose") return "Propose";
  if (t === "Attest") return "Attest";
  return "Transfer";
}
