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

// payload_hash → parsed JSON content (or null if unresolved). Cached: registry records
// are immutable by hash, so once fetched they never change.
const contentCache = new Map<string, any>();

async function fetchContent(hash: string): Promise<any> {
  const key = hash.toLowerCase();
  if (contentCache.has(key)) return contentCache.get(key);
  let parsed: any = null;
  try {
    const r = await fetch(`${CFG.swarmGateway}/content/${key}`);
    if (r.ok) {
      const obj = JSON.parse(await r.text());
      // self-certify: only accept content that actually hashes to the on-chain
      // payload_hash — the indexer trusts neither the origin nor the gateway for bytes.
      if (payloadHash(obj).toLowerCase() === key) parsed = obj;
    }
  } catch { /* unresolved / late-published — leave null, never counted as present */ }
  // Content is immutable (content-addressed), so a SUCCESS is safe to cache forever. But a
  // failure (gateway down / not-yet-replicated / hash-mismatch) must NOT be cached: otherwise a
  // transient swarm-gateway blip permanently hides a legitimate registry record until restart,
  // breaking the self-healing "recovers when content returns" design. Only memoize successes.
  if (parsed !== null) contentCache.set(key, parsed);
  return parsed;
}

/** Build the ChainRecord set for the registry domains from indexed rows + fetched content. */
export async function buildRegistryRecords(): Promise<ChainRecord[]> {
  const ph = REG_DOMAINS.map(() => "?").join(",");
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
