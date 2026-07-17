// L3 registry resolution served from the indexed data. We assemble ChainRecords
// (a registry-domain Propose + its Attests + the resolved off-chain content) and feed
// them to @inversealtruism/csd-registry's PURE resolvers — the same functions a client
// can run locally, so the indexer is a convenience, never an authority. Content is
// fetched (and cached) via the L1 swarm gateway / origin, self-certifying by hash.
import { DOMAINS, resolvePeers, resolveGateways, resolveIdentity, reverseIdentity, epochOf, type ChainRecord, type ResolveOpts } from "@inversealtruism/csd-registry";
import { payloadHash } from "@inversealtruism/csd-codec";
import { store } from "./db.js";
import { tipHeight, tipRow } from "./queries.js";
import { CFG } from "./config.js";
import { proofStatuses } from "./identity.js";

const REG_DOMAINS = [DOMAINS.peers, DOMAINS.peersLegacy, DOMAINS.gateways, DOMAINS.identity];
const MAX_CONTENT_BYTES = 4 * 1024 * 1024; // hard cap on a fetched content body (defense-in-depth)

// payload_hash → parsed JSON content (or null if unresolved). Cached: registry records
// are immutable by hash, so once fetched they never change.
const contentCache = new Map<string, any>();

/**
 * Fetch a URL enforcing a byte cap WHILE STREAMING (L9): refuse on a declared oversize
 * Content-Length before reading anything, then read via a reader loop and abort the moment the
 * body crosses the cap — never buffer-then-check, so a hostile/misconfigured gateway can't make
 * us hold an unbounded body in memory. Shared by /content proxying (server.ts) and fetchContent.
 */
export async function fetchCapped(url: string, signal: AbortSignal, cap: number):
  Promise<{ status: number; ok: boolean; oversize: boolean; body: Uint8Array }> {
  const r = await fetch(url, { signal });
  if (!r.ok || !r.body) {
    await r.body?.cancel().catch(() => {});
    return { status: r.status, ok: r.ok, oversize: false, body: new Uint8Array(0) };
  }
  const declared = Number(r.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await r.body.cancel().catch(() => {});
    return { status: r.status, ok: true, oversize: true, body: new Uint8Array(0) };
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { // past the cap → stop reading NOW and drop what we have
      await reader.cancel().catch(() => {});
      return { status: r.status, ok: true, oversize: true, body: new Uint8Array(0) };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.byteLength; }
  return { status: r.status, ok: true, oversize: false, body };
}

async function fetchContent(hash: string): Promise<any> {
  const key = hash.toLowerCase();
  if (contentCache.has(key)) return contentCache.get(key);
  let parsed: any = null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000); // hard timeout so a hung gateway can't stall request handlers
  try {
    // Explicit byte cap, enforced WHILE streaming: don't depend on the gateway's object limit for
    // our own memory safety (a misconfigured/hostile gateway can't hand an unbounded body to JSON.parse).
    const r = await fetchCapped(`${CFG.swarmGateway}/content/${key}`, ctrl.signal, MAX_CONTENT_BYTES);
    if (r.ok && !r.oversize) {
      const obj = JSON.parse(new TextDecoder().decode(r.body));
      // self-certify: only accept content that actually hashes to the on-chain
      // payload_hash — the indexer trusts neither the origin nor the gateway for bytes.
      if (payloadHash(obj).toLowerCase() === key) parsed = obj;
    }
  } catch { /* unresolved / late-published / oversized / unparseable — leave null */ }
  finally { clearTimeout(to); }
  // Content is immutable (content-addressed), so a SUCCESS is safe to cache forever. But a
  // failure (gateway down / not-yet-replicated / hash-mismatch) must NOT be cached: otherwise a
  // transient swarm-gateway blip permanently hides a legitimate registry record until restart,
  // breaking the self-healing "recovers when content returns" design. Only memoize successes.
  if (parsed !== null) contentCache.set(key, parsed);
  return parsed;
}

// Memo of the assembled record set (E5). Registry data only changes when a registry-domain
// proposal/attestation is added/removed (which advances the tip in production) — so we key on a cheap
// fingerprint: tip HEIGHT + tip HASH + the registry proposal & attestation counts. Any of those changing
// invalidates the memo. L8: the hash is load-bearing, not just the height — an EQUAL-height reorg (a
// same-height tip swap, common on any PoW chain) can orphan a registry proposal and replace it with a
// different one WITHOUT changing the height or the counts, so a height-only key would keep serving the
// orphaned name -> address for up to a block. Including the tip hash invalidates the memo the instant the
// tip swaps. We store ONLY when every record's content has resolved; if any is still null (swarm not yet
// pinned) we leave it uncached so the next request retries — preserving self-healing.
let recordsCache: { key: string; records: ChainRecord[] } | null = null;

/** Build the ChainRecord set for the registry domains from indexed rows + fetched content. */
export async function buildRegistryRecords(): Promise<ChainRecord[]> {
  const ph = REG_DOMAINS.map(() => "?").join(",");
  const fp = await store().get<{ p: number; a: number }>(
    `SELECT (SELECT COUNT(*) FROM proposals WHERE domain IN (${ph})) AS p,
            (SELECT COUNT(*) FROM attestations WHERE proposal_id IN (SELECT txid FROM proposals WHERE domain IN (${ph}))) AS a`,
    ...REG_DOMAINS, ...REG_DOMAINS) ?? { p: 0, a: 0 };
  const tip = await tipRow();                                  // L8: key on tip HASH too, not just height
  const key = `${tip?.height ?? -1}:${tip?.hash ?? ""}:${fp.p}:${fp.a}`;
  if (recordsCache && recordsCache.key === key) return recordsCache.records;
  // CAIRN-IDX-REGISTRY-1: deterministic feed order. The resolver's tie-break on an EXACT weight tie depends
  // on iteration order; without ORDER BY the winner = first DB row = unspecified, so the same indexer could
  // flip a reverse-resolved primary name across restarts/backends. (height, txid) is the canonical anchor order.
  const props = await store().all<any>(
    `SELECT txid, domain, payload_hash, proposer, fee, height, expires_epoch FROM proposals WHERE domain IN (${ph}) ORDER BY height, txid`,
    ...REG_DOMAINS);

  const out: ChainRecord[] = [];
  for (const p of props) {
    const content = await fetchContent(p.payload_hash);
    const attestations = (await store().all<any>(`SELECT attester, fee, score, confidence, height FROM attestations WHERE proposal_id=?`, p.txid))
      .map((a) => ({ attester: a.attester, fee: Number(a.fee), score: Number(a.score), confidence: Number(a.confidence), height: Number(a.height) }));
    out.push({
      domain: p.domain, proposalId: p.txid, proposer: String(p.proposer || "").toLowerCase(),
      payloadHash: p.payload_hash, fee: Number(p.fee || 0), height: Number(p.height || 0),
      expiresEpoch: Number(p.expires_epoch || 0), content, attestations,
    });
  }
  // memoize only if every record's content resolved (else retry next call → self-heal)
  if (out.every((r) => r.content !== null && r.content !== undefined)) recordsCache = { key, records: out };
  return out;
}

async function opts(): Promise<ResolveOpts> { return { nowEpoch: epochOf(Math.max(0, await tipHeight())), topK: 50 }; }

// Note: externalVerified is left default (signed-proof only) here; the P5.3 re-proof
// workers will supply a liveness predicate once they're wired.
export async function peers() { return resolvePeers(await buildRegistryRecords(), await opts()); }
export async function gateways() { return resolveGateways(await buildRegistryRecords(), await opts()); }
export async function reverse(addr: string) { return reverseIdentity(await buildRegistryRecords(), addr, await opts()); }

// name → address, enriched with live external-proof status (NIP-05 liveness on read).
export async function identity(handle: string) {
  const records = await buildRegistryRecords();
  const res = resolveIdentity(records, handle, await opts());
  if (!res) return null;
  const winner = records.find((r) => r.proposalId === res.proposalId);
  const proofs = winner ? await proofStatuses(winner) : [];
  return { ...res, proofs, externally_live: proofs.some((p) => p.ok) };
}
