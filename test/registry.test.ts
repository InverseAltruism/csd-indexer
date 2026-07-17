// L3 registry served through the indexer: real DB rows + a MOCK content origin +
// the REAL resolvers + the REAL HTTP endpoints. Non-self-fulfilling — records are
// signed with real keys, the origin only transports bytes (self-certified by hash),
// and a tampered-content origin is proven NOT to poison resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { keygen } from "@inversealtruism/csd-crypto";
import { EPOCH_LEN } from "@inversealtruism/csd-codec";
import { buildPeerRecord, buildGatewayRecord, buildIdentityCommit, buildIdentityReveal } from "@inversealtruism/csd-registry";

const DB = `/tmp/csd-idx-reg-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }

// ── mock content origin (the L1 swarm gateway's role: serve bytes by payload_hash) ──
const store = new Map<string, string>();      // payload_hash → canonical bytes
let tamper = false;
const origin = createServer((req, res) => {
  const m = (req.url || "").match(/^\/content\/(0x[0-9a-f]{64})$/i);
  if (!m) { res.statusCode = 404; return res.end("{}"); }
  const body = store.get(m[1]!.toLowerCase());
  if (body == null) { res.statusCode = 404; return res.end("{}"); }
  res.setHeader("content-type", "application/json");
  res.end(tamper ? body.replace(/./, "X") : body); // tamper flips a byte → hash mismatch
});
await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
const ORIGIN = `http://127.0.0.1:${(origin.address() as any).port}`;

process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_registry";
process.env.CSD_SWARM_GATEWAY = ORIGIN;

const { store: dbStore, resetStoreForTests, closeDb } = await import("../src/db.js");
const registry = await import("../src/registry.js");
await resetStoreForTests();

const E = EPOCH_LEN;
let seq = 0;
const txid = () => "0x" + (seq++).toString(16).padStart(64, "0");
async function anchor(b: { domain: string; content: object; payloadHash: string }, proposer: string, fee: number, height: number, expiresEpoch = 0): Promise<string> {
  store.set(b.payloadHash.toLowerCase(), JSON.stringify(b.content)); // "publish" content to the origin
  const id = txid();
  await dbStore().run(`INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time) VALUES(?,?,?,?,?,?,?,?,0)`,
    id, b.domain, b.payloadHash, "", expiresEpoch, proposer.toLowerCase(), fee, height);
  return id;
}
async function attest(proposalId: string, attester: string, fee: number, height: number) {
  await dbStore().run(`INSERT INTO attestations(txid,proposal_id,attester,score,confidence,fee,height,time) VALUES(?,?,?,?,?,?,?,0)`,
    txid(), proposalId, attester.toLowerCase(), 100, 100, fee, height);
}

// give the resolver a tip so nowEpoch is realistic
await dbStore().run(`INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES(?,?,?,?,0,0,0,1,1,'0',0)`,
  1000, "0x" + "ab".repeat(32), null, null);

test("GET /registry/peers resolves verified on-chain peer records", async () => {
  const a = keygen(), b = keygen();
  await anchor(buildPeerRecord({ priv: a.priv, peer_id: "PeerA", multiaddrs: ["/ip4/1.1.1.1/tcp/4001"], address: a.addr }), a.addr, 25e6, 990);
  await anchor(buildPeerRecord({ priv: b.priv, peer_id: "PeerB", multiaddrs: ["/ip4/2.2.2.2/tcp/4001"], address: b.addr }), b.addr, 200e6, 991);
  const peers = await registry.peers();
  assert.equal(peers.length, 2);
  assert.equal(peers[0]?.peer_id, "PeerB", "higher fee ranks first");
  assert.deepEqual(peers[0]?.multiaddrs, ["/ip4/2.2.2.2/tcp/4001"]);
});

test("GET /registry/gateways ranks fresh, attested gateways", async () => {
  const g = keygen(), at = keygen();
  const id = await anchor(buildGatewayRecord({ priv: g.priv, url: "https://gw1/content/0x{hash}", address: g.addr }), g.addr, 50e6, 992);
  await attest(id, at.addr, 5e6, 993);
  const gws = await registry.gateways();
  assert.ok(gws.find((x: any) => x.url === "https://gw1/content/0x{hash}"), "the attested gateway resolves");
});

test("identity resolves via commit-reveal; reverse works", async () => {
  const o = keygen();
  const salt = "salty";
  await anchor(buildIdentityCommit({ handle: "alice", salt, address: o.addr }), o.addr, 25e6, 31 * E); // epoch 31
  await anchor(buildIdentityReveal({ priv: o.priv, handle: "alice", salt, address: o.addr }), o.addr, 25e6, 32 * E); // epoch 32
  const who = await registry.identity("alice");
  assert.ok(who, "alice resolves");
  assert.equal(String(who?.address).toLowerCase(), o.addr.toLowerCase());
  const back = await registry.reverse(o.addr);
  assert.equal(back?.handle, "alice");
});

test("a TAMPERED content origin cannot poison resolution (indexer self-certifies)", async () => {
  // flip a byte on every served body → payloadHash no longer matches → content dropped
  // (uses a fresh key/peer_id, so a brand-new payload_hash that isn't in the cache)
  tamper = true;
  const c = keygen();
  await anchor(buildPeerRecord({ priv: c.priv, peer_id: "PeerTamper", multiaddrs: ["/ip4/9.9.9.9/tcp/1"], address: c.addr }), c.addr, 25e6, 994);
  const peers = await registry.peers();
  assert.ok(!peers.find((p: any) => p.peer_id === "PeerTamper"), "tampered content is rejected by hash self-check");
  tamper = false;
});

test("a transient content-gateway failure does NOT permanently hide a record (self-heals)", async () => {
  // F6 regression: the previous fetchContent cached negative results forever, so a momentary
  // gateway blip permanently dropped a legitimate registry record until process restart. With
  // only-cache-successes, the record must reappear on the next resolve once content is served.
  // The preceding test already anchored "PeerTamper" and resolved it under tamper=true (a failed
  // self-cert → not present). tamper is now false, so its bytes verify on the next fetch.
  const peers = await registry.peers();
  assert.ok(
    peers.find((p: any) => p.peer_id === "PeerTamper"),
    "PeerTamper recovers after the gateway serves valid bytes (no permanent negative cache)",
  );
});

// The CairnX resolver pages /proposal/:id/attestations to get the COMPLETE list (a truncated list
// would diverge ledger state). Prove the keyset cursor reconstructs the full list with no dup/skip,
// including across the (height,txid) tiebreak — independent of any per-request LIMIT.
test("attestationsFor: keyset pagination returns the COMPLETE ordered list with no dup/skip", async () => {
  const q = await import("../src/queries.js");
  const pid = txid();
  const heights = [10, 10, 10, 11, 11, 12, 12, 12, 13, 13, 14, 14]; // dup heights exercise the txid tiebreak
  for (const h of heights) await attest(pid, "0x" + "cc".repeat(20), 5e6, h);
  const all = await q.attestationsFor(pid, { limit: 1000 });
  assert.equal(all.length, heights.length, "ground-truth single-page list has every attest");
  const paged: any[] = [];
  let afterHeight: number | undefined, afterTxid: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await q.attestationsFor(pid, { limit: 3, afterHeight, afterTxid }); // tiny page forces ≥4 pages
    paged.push(...page);
    if (page.length < 3) break;
    const last = page[page.length - 1];
    afterHeight = Number(last.height); afterTxid = last.txid;
  }
  assert.deepEqual(paged.map((a) => a.txid), all.map((a) => a.txid), "paged union equals the full list, same order");
  assert.equal(new Set(paged.map((a) => a.txid)).size, paged.length, "no row appears twice across pages");
});

// L8: the record-set memo keys on the tip HASH, not just the tip height. An EQUAL-height reorg (a
// same-height tip swap that orphans one registry proposal and makes a different one canonical WITHOUT
// changing the height or the proposal/attestation counts) must invalidate the memo, else the resolver
// serves the orphaned name -> address for up to a block. Delete+insert keeps the counts identical, so ONLY
// the tip hash differs: with a height-only key the stale record would persist; with the hash it rebuilds.
test("L8: an equal-height reorg (same height + counts, new tip hash) invalidates the registry memo", async () => {
  const k = keygen();
  const H1 = "0x" + "11".repeat(32), H2 = "0x" + "22".repeat(32);
  // fresh tip at height 5000, hash H1
  await dbStore().run(`INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned) VALUES(5000,?,null,null,0,0,0,1,1,'0',0)`, H1);
  const v1 = await anchor(buildPeerRecord({ priv: k.priv, peer_id: "PXreorg", multiaddrs: ["/ip4/1.1.1.1/tcp/1"], address: k.addr }), k.addr, 500e6, 4990);
  let peers = await registry.peers();
  const before = peers.find((p: any) => p.peer_id === "PXreorg");
  assert.deepEqual(before?.multiaddrs, ["/ip4/1.1.1.1/tcp/1"], "v1 resolves and is memoized at tip hash H1");

  // EQUAL-HEIGHT REORG: same height 5000, new tip hash H2; swap the PXreorg proposal for a different one
  // (delete v1, insert v2) so the peer/attestation COUNTS are unchanged — only the tip hash moves.
  await dbStore().run(`UPDATE blocks SET hash=? WHERE height=5000`, H2);
  await dbStore().run(`DELETE FROM proposals WHERE txid=?`, v1);
  await anchor(buildPeerRecord({ priv: k.priv, peer_id: "PXreorg", multiaddrs: ["/ip4/2.2.2.2/tcp/2"], address: k.addr }), k.addr, 500e6, 4990);

  peers = await registry.peers();
  const after = peers.find((p: any) => p.peer_id === "PXreorg");
  assert.deepEqual(after?.multiaddrs, ["/ip4/2.2.2.2/tcp/2"], "the new tip hash invalidates the memo -> the canonical (post-reorg) record is served");
});

test.after(async () => { origin.close(); await closeDb(); });
