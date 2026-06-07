// L3 identity external-proof verification (NIP-05 liveness). The cryptographic binding
// (signature + commit-reveal) is checked by the resolver; THIS re-validates the optional
// external proofs on read — DNS `.well-known/csd.json`, a GitHub gist, or the on-record
// signature — so a handle that points at a lost domain silently downgrades. Results are
// cached briefly (proofs change slowly; we don't want to hammer external hosts).
import type { ChainRecord, ExternalProof, IdentityRevealContent } from "@inversealtruism/csd-registry";

export interface ProofStatus { type: string; ref?: string; ok: boolean }

const TTL_MS = 10 * 60 * 1000; // re-prove external proofs at most every 10 min
const cache = new Map<string, { at: number; ok: boolean }>();
const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");

// A proof passes if the external resource currently asserts THIS address (and, where
// present, this handle). Lenient match: the fetched body contains the address hex.
async function checkOne(p: ExternalProof, handle: string, address: string, f: typeof fetch): Promise<boolean> {
  if (p.type === "signed") return true; // the on-record sig is verified by the resolver
  let url: string | null = null;
  if (p.type === "dns") url = `https://${p.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}${p.path.startsWith("/") ? "" : "/"}${p.path}`;
  else if (p.type === "github-gist") url = p.url;
  if (!url) return false;
  const key = `${url}|${norm(address)}|${handle}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    const r = await f(url, { redirect: "follow" } as any);
    if (r.ok) {
      const body = (await r.text()).toLowerCase();
      // require the address; if the proof body mentions a handle field, require ours too
      ok = body.includes(norm(address)) && (!/handle|name/.test(body) || body.includes(handle.toLowerCase()));
    }
  } catch { ok = false; }
  cache.set(key, { at: Date.now(), ok });
  return ok;
}

/** Live status of every external proof on an identity reveal record. */
export async function proofStatuses(r: ChainRecord, f: typeof fetch = fetch): Promise<ProofStatus[]> {
  const c = r.content as IdentityRevealContent | null;
  if (!c || c.t !== "identity-reveal") return [];
  const proofs = c.proofs ?? [{ type: "signed" as const }];
  return Promise.all(proofs.map(async (p) => ({
    type: p.type,
    ref: p.type === "dns" ? `${p.domain}${p.path}` : p.type === "github-gist" ? p.url : undefined,
    ok: await checkOne(p, c.handle, c.address, f),
  })));
}

/** True if the record has at least one currently-valid proof (signed always counts). */
export async function externallyLive(r: ChainRecord, f: typeof fetch = fetch): Promise<boolean> {
  return (await proofStatuses(r, f)).some((s) => s.ok);
}
