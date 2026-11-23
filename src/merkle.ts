// Merkle inclusion proofs; the reason this layer exists for the light client.
//
// The node serves no proof endpoint. We have every block's ordered tx list (queries.ts BLOCK_TX_LIST),
// so we rebuild the Electrum-format proof: { block_height, pos, merkle:[siblings…] }.
// The branch is produced by @inversealtruism/csd-codec's merkleBranch; the SAME
// function the L0 light client folds with verifyMerkleProof against the header root,
// so prover and verifier share one convention by construction (verified live: the
// SDK's merkleRoot reproduces the node's header.merkle for real blocks).
import { merkleBranch } from "@inversealtruism/csd-codec";
import { store } from "./db.js";
import { BLOCK_TX_LIST } from "./queries.js";

export interface MerkleProof { block_height: number; pos: number; merkle: string[]; merkle_root: string; }

// The tx's row, its block's header root and the block's tx list, in one statement (one view on both backends), so
// an unwind cannot land between the list and the root.
const PROOF_SQL =
  "SELECT r.height AS height, r.pos AS tx_pos, k.merkle AS root, l.txid AS txid FROM (SELECT height, pos FROM txs WHERE txid = ?) r " +
  `LEFT JOIN blocks k ON k.height = r.height LEFT JOIN ${BLOCK_TX_LIST("(SELECT height FROM txs WHERE txid = ?)")} l ON 1 = 1 ORDER BY l.pos`;

/** Build the inclusion proof for a txid, or null if we don't have it. */
export async function merkleProof(txid: string): Promise<MerkleProof | null> {
  const rows = await store().all<{ height: number; tx_pos: number; root: string | null; txid: string | null }>(PROOF_SQL, txid, txid, txid);
  const row = rows[0];
  if (!row) return null;
  const txids = rows.flatMap((r) => (r.txid == null ? [] : [r.txid]));
  const pos = Number(row.tx_pos);
  // The proof carries the block's CONSENSUS header merkle root (PoW-committed), so a JSON-API consumer that trusts
  // `merkle_root` is tied to the root a light client verifies against the header: if the node served a header.merkle
  // that disagrees with its own tx list, the branch folds to another root and the consumer's check fails. A block
  // without a stored root gives no proof (test/indexer.test.ts).
  if (row.root == null || txids[pos] !== txid) return null;
  return { block_height: Number(row.height), pos, merkle: merkleBranch(txids, pos), merkle_root: row.root };
}
