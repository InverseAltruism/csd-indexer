// L3 registry resolution served from the indexed data. We assemble ChainRecords
// (a registry-domain Propose + its Attests + the resolved off-chain content) and feed
// them to @inversealtruism/csd-registry's PURE resolvers — the same functions a client
// can run locally, so the indexer is a convenience, never an authority. Content is
// fetched (and cached) via the L1 swarm gateway / origin, self-certifying by hash.
import { DOMAINS, resolvePeers, resolveGateways, resolveIdentity, reverseIdentity, epochOf, type ChainRecord, type ResolveOpts } from "@inversealtruism/csd-registry";
import { payloadHash } from "@inversealtruism/csd-codec";
import { db } from "./db.js";
import { tipHeight } from "./queries.js";
import { CFG } from "./config.js";
import { proofStatuses } from "./identity.js";

const REG_DOMAINS = [DOMAINS.peers, DOMAINS.peersLegacy, DOMAINS.gateways, DOMAINS.identity];
const MAX_CONTENT_BYTES = 4 * 1024 * 1024; // hard cap on a fetched content body (defense-in-depth)

// payload_hash → parsed JSON content (or null if unresolved). Cached: registry records
// are immutable by hash, so once fetched they never change.
const contentCache = new Map<string, any>();

async function fetchContent(hash: string): Promise<any> {
  const key = hash.toLowerCase();
  if (contentCache.has(key)) return contentCache.get(key);
  let parsed: any = null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000); // hard timeout so a hung gateway can't stall request handlers
  try {
    const r = await fetch(`${CFG.swarmGateway}/content/${key}`, { signal: ctrl.signal });
    if (r.ok) {
      // Explicit byte cap: don't depend on the gateway's object limit for our own memory safety
      // (a misconfigured/hostile gateway could otherwise hand back an unbounded body to JSON.parse).
      const buf = await r.arrayBuffer();
      if (buf.byteLength <= MAX_CONTENT_BYTES) {
        const obj = JSON.parse(new TextDecoder().decode(buf));
        // self-certify: only accept content that actually hashes to the on-chain
        // payload_hash — the indexer trusts neither the origin nor the gateway for bytes.
        if (payloadHash(obj).toLowerCase() === key) parsed = obj;
      }
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
// fingerprint: tipHeight + the registry proposal & attestation counts. Any of those changing
// invalidates the memo. We store ONLY when every record's content has resolved; if any is still null
// (swarm not yet pinned) we leave it uncached so the next request retries — preserving self-healing.
let recordsCache: { key: string; records: ChainRecord[] } | null = null;

/** Build the ChainRecord set for the registry domains from indexed rows + fetched content. */
export async function buildRegistryRecords(): Promise<ChainRecord[]> {
  const ph = REG_DOMAINS.map(() => "?").join(",");
  const fp = db().prepare(
    `SELECT (SELECT COUNT(*) FROM proposals WHERE domain IN (${ph})) AS p,
            (SELECT COUNT(*) FROM attestations WHERE proposal_id IN (SELECT txid FROM proposals WHERE domain IN (${ph}))) AS a`,
  ).get(...REG_DOMAINS, ...REG_DOMAINS) as { p: number; a: number };
  const key = `${tipHeight()}:${fp.p}:${fp.a}`;
  if (recordsCache && recordsCache.key === key) return recordsCache.records;
  const props = db().prepare(
    `SELECT txid, domain, payload_hash, proposer, fee, height, expires_epoch FROM proposals WHERE domain IN (${ph})`,
  ).all(...REG_DOMAINS) as any[];
  const attStmt = db().prepare(`SELECT attester, fee, score, confidence, height FROM attestations WHERE proposal_id=?`);

  const out: ChainRecord[] = [];
  for (const p of props) {
    const content = await fetchContent(p.payload_hash);
    const attestations = (attStmt.all(p.txid) as any[]).map((a) => ({ attester: a.attester, fee: a.fee, score: a.score, confidence: a.confidence, height: a.height }));
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

function opts(): ResolveOpts { return { nowEpoch: epochOf(Math.max(0, tipHeight())), topK: 50 }; }

// Note: externalVerified is left default (signed-proof only) here; the P5.3 re-proof
// workers will supply a liveness predicate once they're wired.
export async function peers() { return resolvePeers(await buildRegistryRecords(), opts()); }
export async function gateways() { return resolveGateways(await buildRegistryRecords(), opts()); }
export async function reverse(addr: string) { return reverseIdentity(await buildRegistryRecords(), addr, opts()); }

// name → address, enriched with live external-proof status (NIP-05 liveness on read).
export async function identity(handle: string) {
  const records = await buildRegistryRecords();
  const res = resolveIdentity(records, handle, opts());
  if (!res) return null;
  const winner = records.find((r) => r.proposalId === res.proposalId);
  const proofs = winner ? await proofStatuses(winner) : [];
  return { ...res, proofs, externally_live: proofs.some((p) => p.ok) };
}
