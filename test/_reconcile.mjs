// P3.0 GATE: a from-genesis re-sync must reproduce the node's own per-domain
// proposal/attestation aggregates EXACTLY. The node computed these independently
// from consensus; if our relational re-derivation matches, our scan is faithful.
// (Run after `CSD_INDEX_FROM=0 tsx src/cli.ts index` finishes.)
process.env.CSD_INDEX_DB = process.env.CSD_INDEX_DB || "./csd-index.db";
const { db } = await import("../src/db.js");
const RPC = process.env.CSD_RPC || "http://127.0.0.1:8790";

const nodeDomains = (await (await fetch(RPC + "/domains")).json()).domains;
let P = 0, F = 0; const ok = (n, c) => { c ? P++ : F++; console.log((c ? "  ✅ " : "  ❌ ") + n); };

const myProp = new Map(), myAtt = new Map();
for (const r of db().prepare("SELECT domain, COUNT(*) n FROM proposals GROUP BY domain").all())
  myProp.set(r.domain, r.n);
// attestations are keyed by proposal_id, not domain — join through proposals
for (const r of db().prepare(`
  SELECT p.domain domain, COUNT(*) n FROM attestations a JOIN proposals p ON a.proposal_id = p.txid
  GROUP BY p.domain`).all())
  myAtt.set(r.domain, r.n);

let propMatch = 0, attMatch = 0;
for (const d of nodeDomains) {
  const mp = myProp.get(d.domain) ?? 0;
  const ma = myAtt.get(d.domain) ?? 0;
  if (mp === d.proposals) propMatch++;
  else console.log(`    ⚠ ${d.domain}: proposals node=${d.proposals} indexer=${mp}`);
  if (ma === d.attestations) attMatch++;
  else console.log(`    ⚠ ${d.domain}: attestations node=${d.attestations} indexer=${ma}`);
}
ok(`per-domain PROPOSAL counts match node (${propMatch}/${nodeDomains.length})`, propMatch === nodeDomains.length);
ok(`per-domain ATTESTATION counts match node (${attMatch}/${nodeDomains.length})`, attMatch === nodeDomains.length);

const totProp = (db().prepare("SELECT COUNT(*) n FROM proposals").get()).n;
const totAtt = (db().prepare("SELECT COUNT(*) n FROM attestations").get()).n;
const nodeTotProp = nodeDomains.reduce((s, d) => s + d.proposals, 0);
const nodeTotAtt = nodeDomains.reduce((s, d) => s + d.attestations, 0);
console.log(`  indexer totals: ${totProp} proposals, ${totAtt} attestations; node: ${nodeTotProp}/${nodeTotAtt}`);

console.log(`\nP3.0 RECONCILE: ${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
