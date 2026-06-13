// Merkle inclusion proofs — the reason this layer exists for the light client.
//
// The node serves no proof endpoint. We have every block's ordered tx list (txs.pos),
// so we rebuild the Electrum-format proof: { block_height, pos, merkle:[siblings…] }.
// The branch is produced by @inversealtruism/csd-codec's merkleBranch — the SAME
// function the L0 light client folds with verifyMerkleProof against the header root,
// so prover and verifier share one convention by construction (verified live: the
// SDK's merkleRoot reproduces the node's header.merkle for real blocks).
import { merkleBranch, merkleRoot } from "@inversealtruism/csd-codec";
import { store } from "./db.js";

export interface MerkleProof { block_height: number; pos: number; merkle: string[]; merkle_root: string; }

/** Ordered txids of a (canonical) block, by position. */
export async function blockTxids(height: number): Promise<string[]> {
  return (await store().all<{ txid: string }>("SELECT txid FROM txs WHERE height=? ORDER BY pos", height)).map(r => r.txid);
}

/** Build the inclusion proof for a txid, or null if we don't have it. */
export async function merkleProof(txid: string): Promise<MerkleProof | null> {
  const row = await store().get<{ height: number; pos: number }>("SELECT height,pos FROM txs WHERE txid=?", txid);
  if (!row) return null;
  const txids = await blockTxids(Number(row.height));
  if (txids.length === 0 || row.pos >= txids.length) return null;
  // Return the block's CONSENSUS header merkle root (PoW-committed), not a self-recomputed one, so a
  // JSON-API consumer that trusts `merkle_root` is tied to the root a light client can verify against
  // the header. If the node ever served a header.merkle that disagrees with its own tx list, the
  // branch folds to merkleRoot(txids) != this root, so the consumer's verification FAILS (correctly)
  // instead of trusting a self-consistent-but-wrong proof. Falls back to the recomputed root only if
  // the stored header merkle is somehow absent.
  const blk = await store().get<{ merkle: string | null }>("SELECT merkle FROM blocks WHERE height=?", Number(row.height));
  return {
    block_height: Number(row.height),
    pos: row.pos,
    merkle: merkleBranch(txids, row.pos),
    merkle_root: blk?.merkle ?? merkleRoot(txids),
  };
}
