// Live end-to-end check (run after indexing a window + starting the API).
// Non-self-fulfilling: cross-checks the indexer against the NODE and verifies a
// served merkle proof with the published L0 light-client convention.
import { verifyMerkleProof } from "@inversealtruism/csd-codec";

const API = "http://127.0.0.1:8793";
const RPC = "http://127.0.0.1:8790";
const a = async (p) => (await fetch(API + p)).json();
const r = async (p) => (await fetch(RPC + p)).json();
let P = 0, F = 0; const ok = (n, c) => { c ? P++ : F++; console.log((c ? "  ✅ " : "  ❌ ") + n); };

// 1) tip is present and never AHEAD of the node (a static snapshot may lag; in
// continuous `run` mode it tracks the node — either way it must not exceed it).
const apiTip = await a("/blocks/tip/height");
const nodeTip = (await r("/tip")).height;
ok(`tip present and not ahead of node (api=${apiTip}, node=${nodeTip})`, apiTip > 0 && apiTip <= nodeTip);

// 2) a block: hash + merkle match the node exactly
const h = apiTip - 2;
const apiHash = await a(`/block-height/${h}`);
let nb = await r(`/block/height/${h}`); nb = nb.block ?? nb;
ok(`block ${h}: api hash == node hash`, apiHash.toLowerCase() === nb.hash.toLowerCase());
const blk = await a(`/block/${apiHash}`);
ok(`block ${h}: api merkle == node header.merkle`, blk.merkle.toLowerCase() === nb.header.merkle.toLowerCase());
ok(`block ${h}: api tx_count == node txs`, blk.tx_count === nb.txs.length);

// 3) THE KEYSTONE: a served merkle proof verifies under the L0 light-client convention
const txids = await a(`/block/${apiHash}/txids`);
ok(`block ${h}: txids ordered, count matches`, txids.length === nb.txs.length && txids[0] === nb.txs[0].txid);
let proofChecks = 0;
for (let pos = 0; pos < txids.length; pos++) {
  const proof = await a(`/tx/${txids[pos]}/merkle-proof`);
  const good = verifyMerkleProof(txids[pos], proof.pos, proof.merkle, nb.header.merkle);
  if (good && proof.pos === pos && proof.block_height === h) proofChecks++;
}
ok(`block ${h}: ALL ${txids.length} served merkle proofs verify vs node header.merkle (L0 convention)`, proofChecks === txids.length);
// negative: a tampered txid must not verify against a real proof
const realProof = await a(`/tx/${txids[0]}/merkle-proof`);
ok(`tampered txid fails the served proof`, !verifyMerkleProof("0x" + "11".repeat(32), realProof.pos, realProof.merkle, nb.header.merkle));

// 4) tx status confirmations are sane
const st = await a(`/tx/${txids[0]}/status`);
ok(`tx status confirmed w/ sane confirmations`, st.confirmed === true && st.confirmations >= 1);

// 5) address round-trip: coinbase payee has the coinbase output as a UTXO or spend
const cbOut = nb.txs[0].outputs[0];
const cbAddr = "0x" + (cbOut.script_pubkey.startsWith("0x") ? cbOut.script_pubkey.slice(2) : cbOut.script_pubkey);
const addrTxs = await a(`/address/${cbAddr}/txs`);
ok(`coinbase payee address has tx history`, Array.isArray(addrTxs) && addrTxs.some(t => t.txid === nb.txs[0].txid));

console.log(`\nLIVE E2E: ${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
