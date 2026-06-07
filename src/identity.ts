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

// SSRF guard. The proof URLs come from attacker-controlled on-chain `identity-reveal` content, so
// reaching them unguarded lets a GET /identity/:handle pivot to internal services / cloud metadata.
// gist proofs are pinned to GitHub's hosts; dns proofs may target any PUBLIC host but never a
// private/loopback/link-local IP, redirects are not followed, and there's a hard timeout.
const GIST_HOSTS = new Set(["gist.github.com", "gist.githubusercontent.com", "raw.githubusercontent.com", "api.github.com"]);
const FETCH_TIMEOUT_MS = 5000;
const MAX_PROOF_BYTES = 256 * 1024;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv4 literal in private/loopback/link-local/CGNAT ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
    if (a === 169 && b === 254) return true;     // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 loopback / ULA / link-local (also catches bracketed forms)
  const h6 = h.replace(/^\[|\]$/g, "");
  if (h6 === "::1" || h6 === "::" || h6.startsWith("fc") || h6.startsWith("fd") || h6.startsWith("fe80") || h6.startsWith("::ffff:")) return true;
  return false;
}

function proofUrlAllowed(u: string, kind: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (kind === "github-gist") return GIST_HOSTS.has(url.hostname.toLowerCase());
  return !isPrivateHost(url.hostname);
}

async function safeFetch(url: string, f: typeof fetch): Promise<{ ok: boolean; body: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // redirect:"manual" — a 3xx is treated as failure rather than silently following inward.
    const r = await f(url, { redirect: "manual", signal: ctrl.signal } as any);
    if (!r.ok || (r.status >= 300 && r.status < 400)) return { ok: false, body: "" };
    const buf = await r.arrayBuffer();
    const body = new TextDecoder().decode(buf.byteLength > MAX_PROOF_BYTES ? buf.slice(0, MAX_PROOF_BYTES) : buf);
    return { ok: true, body };
  } catch { return { ok: false, body: "" }; }
  finally { clearTimeout(t); }
}

// A proof passes if the external resource currently asserts THIS address (and, where
// present, this handle). Lenient match: the fetched body contains the address hex.
async function checkOne(p: ExternalProof, handle: string, address: string, f: typeof fetch): Promise<boolean> {
  if (p.type === "signed") return true; // the on-record sig is verified by the resolver
  let url: string | null = null;
  if (p.type === "dns") url = `https://${p.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}${p.path.startsWith("/") ? "" : "/"}${p.path}`;
  else if (p.type === "github-gist") url = p.url;
  if (!url) return false;
  // SSRF gate: reject internal/loopback/metadata targets (and pin gist proofs to GitHub) BEFORE
  // any network call — the URL is attacker-chosen on-chain data.
  if (!proofUrlAllowed(url, p.type)) return false;
  const key = `${url}|${norm(address)}|${handle}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  const r = await safeFetch(url, f);
  let ok = false;
  if (r.ok) {
    const body = r.body.toLowerCase();
    // require the address; if the proof body mentions a handle field, require ours too
    ok = body.includes(norm(address)) && (!/handle|name/.test(body) || body.includes(handle.toLowerCase()));
  }
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
