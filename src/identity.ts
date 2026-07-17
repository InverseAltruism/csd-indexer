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

// IPv4 literal in private/loopback/link-local/CGNAT/multicast ranges.
function isReservedIpv4(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true; // 10/8,127/8,0/8,224+/multicast+reserved
  if (a === 169 && b === 254) return true;     // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// IDX-SSRF-NUMIP-1: `getaddrinfo`/`inet_aton` accept far more than the dotted-quad form — a 32-bit decimal
// (2130706433), octal (0177.0.0.1), hex (0x7f.0.0.1 / 0x7f000001), and short (127.1 / 127.0.1) all resolve
// to 127.0.0.1. A dotted-quad-only regex leaves every one of those classified as a PUBLIC host, so a
// profile/identity URL in those forms slips past the reserved-range test and reaches co-located loopback
// services (node :8789 / indexer :8793 / cairnx :8794) = SSRF. `parseInetAton` canonicalizes every such
// form to four octets BEFORE the reserved-range test, using classic inet_aton semantics.
//
// Parse ONE inet_aton part: 0x-prefixed hex, leading-0 octal, else decimal. Returns null on anything else
// (incl. an invalid octal digit like "08"), which fails the whole host closed (treated as private).
function parseInetPart(p: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
  if (p === "0") return 0;
  if (/^[1-9][0-9]*$/.test(p)) return Number(p);
  return null;
}
// True iff every dot-separated label is a numeric (decimal / 0x-hex / leading-0 octal) token — i.e. the
// host is an inet_aton candidate, not a DNS name. A real hostname (has a non-numeric label) returns false
// and stays on the DNS path. Bare hex without a 0x prefix (e.g. "cafe") is NOT numeric (inet_aton rejects
// it too), so hex-looking hostnames still resolve via DNS.
function isNumericHostForm(host: string): boolean {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((p) => /^(0x[0-9a-f]+|[0-9]+)$/i.test(p));
}
// inet_aton -> [o0,o1,o2,o3], or null if unparseable/out-of-range. 1..4 parts; the last part holds the
// remaining low bytes (a.b -> a.(24-bit b); a.b.c -> a.b.(16-bit c); a -> 32-bit).
function parseInetAton(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const vals: number[] = [];
  for (const p of parts) { const v = parseInetPart(p); if (v === null) return null; vals.push(v); }
  const n = vals.length;
  for (let i = 0; i < n - 1; i++) if (vals[i]! > 255) return null;     // leading parts are single octets
  const lastMaxBits = 8 * (4 - (n - 1));                                // n=1:32, n=2:24, n=3:16, n=4:8
  if (vals[n - 1]! > 2 ** lastMaxBits - 1) return null;
  let addr = 0n;
  for (let i = 0; i < n - 1; i++) addr = (addr << 8n) | BigInt(vals[i]!);
  addr = (addr << BigInt(lastMaxBits)) | BigInt(vals[n - 1]!);
  if (addr < 0n || addr > 0xffffffffn) return null;
  return [Number((addr >> 24n) & 0xffn), Number((addr >> 16n) & 0xffn), Number((addr >> 8n) & 0xffn), Number(addr & 0xffn)];
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv4 literal (strict dotted quad)
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return isReservedIpv4(Number(m[1]), Number(m[2]));
  // IDX-SSRF-NUMIP-1: any OTHER all-numeric/hex/octal/short IPv4 form (32-bit decimal, 0x hex, leading-0
  // octal, short a.b / a.b.c). Parse it to four octets and run the reserved-range test; an all-numeric host
  // that does NOT parse (out of range / invalid octal) is treated as PRIVATE (fail closed).
  if (isNumericHostForm(h)) {
    const oct = parseInetAton(h);
    if (!oct) return true;
    return isReservedIpv4(oct[0], oct[1]);
  }
  // IPv6 literal (also catches bracketed forms). CAIRN-SSRF-IDENT-1: the prior prefix-string
  // checks (fc/fd/fe80/::ffff:) missed several reserved ranges (NAT64, site-local, 6to4,
  // multicast). Canonicalize to the 8 hextets and test the reserved CIDRs explicitly; an
  // embedded-IPv4 form (::ffff:a.b.c.d / ::a.b.c.d) is routed through the IPv4 reserved check.
  if (h.includes(":")) {
    const h6 = h.replace(/^\[|\]$/g, "").split("%")[0]!; // strip brackets + zone id
    return isReservedIpv6(h6);
  }
  return false;
}

// Expand an IPv6 literal to its 8 16-bit hextets (numbers), or null if unparseable. Handles "::"
// compression and a trailing dotted-quad (::ffff:1.2.3.4 → last two hextets from the v4 octets).
function ipv6Hextets(addr: string): number[] | null {
  let s = addr.toLowerCase();
  if (s === "::") return [0, 0, 0, 0, 0, 0, 0, 0];
  // a trailing embedded IPv4 ("…:1.2.3.4") becomes two hextets
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = s.slice(0, v4.index) + (((a << 8) | b)).toString(16) + ":" + (((c << 8) | d)).toString(16);
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((x) => parseInt(x, 16)));
  let head: number[], tail: number[];
  if (dbl.length === 2) {
    head = parse(dbl[0]!); tail = parse(dbl[1]!);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    head = head.concat(Array(fill).fill(0));
  } else { head = parse(s); tail = []; }
  const all = head.concat(tail);
  if (all.length !== 8 || all.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return all;
}

// Reserved/internal IPv6 ranges that an SSRF target must never reach.
function isReservedIpv6(addr: string): boolean {
  const x = ipv6Hextets(addr);
  if (!x) return true;                                   // unparseable → fail closed
  const [h0, h1] = x;
  // v4-mapped (::ffff:a.b.c.d → hextets 0..4 == 0, hextet 5 == 0xffff) and v4-compat
  // (::a.b.c.d → hextets 0..5 == 0, excluding :: / ::1) carry an embedded IPv4 in the last two
  // hextets — route those octets through the IPv4 reserved check so e.g. ::ffff:127.0.0.1 and
  // ::ffff:169.254.169.254 are rejected. (Node normalizes these to hex, so we test by position.)
  const v4mapped = x.slice(0, 5).every((n) => n === 0) && x[5] === 0xffff;
  const v4compat = x.slice(0, 6).every((n) => n === 0) && (x[6]! !== 0 || x[7]! > 1);
  if (v4mapped || v4compat) {
    // isReservedIpv4 only inspects the first two octets, both held in hextet 6.
    return isReservedIpv4((x[6]! >> 8) & 0xff, x[6]! & 0xff);
  }
  if (x.every((n) => n === 0)) return true;              // ::            (unspecified)
  if (x.slice(0, 7).every((n) => n === 0) && x[7] === 1) return true; // ::1 (loopback)
  if ((h0! & 0xfe00) === 0xfc00) return true;            // fc00::/7      (ULA)
  if ((h0! & 0xffc0) === 0xfe80) return true;            // fe80::/10     (link-local)
  if ((h0! & 0xffc0) === 0xfec0) return true;            // fec0::/10     (deprecated site-local)
  if ((h0! & 0xff00) === 0xff00) return true;            // ff00::/8      (multicast)
  if (h0 === 0x2002) return true;                        // 2002::/16     (6to4)
  if (h0 === 0x0064 && h1 === 0xff9b) return true;       // 64:ff9b::/96  (NAT64 well-known)
  return false;
}

function proofUrlAllowed(u: string, kind: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (kind === "github-gist") return GIST_HOSTS.has(url.hostname.toLowerCase());
  return !isPrivateHost(url.hostname);
}

// DNS-rebinding guard: a PUBLIC hostname whose A/AAAA record resolves to a private/loopback IP would
// pass the string-level `isPrivateHost` check, then connect inward. Resolve the host and reject if
// ANY resolved address is private. Only applied on the real-network path (a test-injected fetch is
// itself the network boundary, so we don't hit DNS there — keeps the suite offline). A small TOCTOU
// window remains (DNS could flip after the check); acceptable for a blind GET-only 1-bit oracle.
async function resolvesToPrivate(hostname: string): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  // A strict dotted-quad IPv4 or ANY IPv6 literal is already fully classified by isPrivateHost; no DNS.
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(bare) || bare.includes(":")) return isPrivateHost(bare);
  // IDX-SSRF-NUMIP-1: do NOT short-circuit other all-numeric forms here. Classify them through isPrivateHost
  // first (it now parses 32-bit-decimal / octal / hex / short IPv4 and fail-closes an unparseable numeric
  // host); if it flags private, reject. Only a host that isPrivateHost does NOT flag (a real hostname, or a
  // numeric form of a genuinely PUBLIC IP) falls through to a real DNS lookup, so getaddrinfo canonicalizes
  // it and we re-check every resolved A/AAAA — closing the rebinding + numeric-encoding gaps together.
  if (isPrivateHost(bare)) return true;
  try {
    const { lookup } = await import("node:dns/promises");
    const addrs = await lookup(hostname, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address));
  } catch {
    return true; // can't resolve → treat as unsafe
  }
}

async function safeFetch(url: string, f: typeof fetch): Promise<{ ok: boolean; body: string }> {
  // real network path only: re-check the RESOLVED IP (DNS-rebinding defense)
  if (f === fetch) {
    try {
      if (await resolvesToPrivate(new URL(url).hostname)) return { ok: false, body: "" };
    } catch { return { ok: false, body: "" }; }
  }
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
