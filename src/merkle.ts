// Merkle inclusion proofs — the reason this layer exists for the light client.
//
// The node serves no proof endpoint. We have every block's ordered tx list (txs.pos),
// so we rebuild the Electrum-format proof: { block_height, pos, merkle:[siblings…] }.
// The branch is produced by @inversealtruism/csd-codec's merkleBranch — the SAME
// function the L0 light client folds with verifyMerkleProof against the header root,
// so prover and verifier share one convention by construction (verified live: the
// SDK's merkleRoot reproduces the node's header.merkle for real blocks).
import { merkleBranch, merkleRoot } from "@inversealtruism/csd-codec";
import { db } from "./db.js";

export interface MerkleProof { block_height: number; pos: number; merkle: string[]; merkle_root: string; }

/** Ordered txids of a (canonical) block, by position. */
export function blockTxids(height: number): string[] {
  return (db().prepare("SELECT txid FROM txs WHERE height=? ORDER BY pos").all(height) as { txid: string }[]).map(r => r.txid);
}

/** Build the inclusion proof for a txid, or null if we don't have it. */
export function merkleProof(txid: string): MerkleProof | null {
  const row = db().prepare("SELECT height,pos FROM txs WHERE txid=?").get(txid) as { height: number; pos: number } | undefined;
  if (!row) return null;
  const txids = blockTxids(row.height);
  if (txids.length === 0 || row.pos >= txids.length) return null;
  return {
    block_height: row.height,
    pos: row.pos,
    merkle: merkleBranch(txids, row.pos),
    merkle_root: merkleRoot(txids),
  };
}
