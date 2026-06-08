// The stateful sync engine: forward-only scan with reorg-safe unwind/replay.
//
// Each block is written in a single sqlite transaction. Inputs are resolved against
// our OWN outputs table (every prior block is already indexed, in order), so fees,
// spends, and address deltas need zero extra RPC. The last `finalDepth` blocks stay
// re-checkable; if a new block's `prev` doesn't link our stored tip, we walk back to
// the common ancestor, unwind every row above it (DELETE WHERE height > ancestor +
// un-spend orphaned spends), and replay the canonical branch — the electrs/Subsquid
// roll-back-then-replay pattern. Blocks deeper than finalDepth are never touched.
import * as rpc from "./rpc.js";
import { db, getMeta, setMeta, tx as dbTx } from "./db.js";
import { deriveAddr, addrFromScriptPubkey, appType } from "./decode.js";
import { CFG } from "./config.js";
import { bus } from "./events.js";

const TIP_KEY = "indexed_height";

export interface IndexResult { from: number; to: number; tip: number; blocks: number; reorgs: number; reorgDepth: number; }

/** Height we've indexed up to (canonical), or scanFrom-1 if fresh. */
export function indexedHeight(): number {
  const v = getMeta(TIP_KEY);
  return v == null ? CFG.scanFrom - 1 : Number(v);
}

/** Write one block + all its txs/outputs/spends/events in a single transaction. */
export function writeBlock(b: rpc.RpcBlock): void {
  const d = db();
  dbTx(() => {
    const blk = b;
    const time = Number(blk.header.time ?? 0);
    d.prepare(`INSERT INTO blocks(height,hash,prev,merkle,time,bits,nonce,version,tx_count,chainwork,orphaned)
      VALUES(?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(height) DO UPDATE SET hash=excluded.hash, prev=excluded.prev, merkle=excluded.merkle,
        time=excluded.time, bits=excluded.bits, nonce=excluded.nonce, version=excluded.version,
        tx_count=excluded.tx_count, chainwork=excluded.chainwork, orphaned=0`)
      .run(blk.height, blk.hash, blk.header.prev ?? null, blk.header.merkle ?? null, time,
        Number(blk.header.bits ?? 0), Number(blk.header.nonce ?? 0), Number(blk.header.version ?? 0),
        blk.txs.length, String(blk.chainwork ?? "0"));

    const insTx = d.prepare(`INSERT INTO txs(txid,height,pos,app_type,signer,fee,time,n_in,n_out,coinbase)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(txid) DO UPDATE SET
      height=excluded.height, pos=excluded.pos, app_type=excluded.app_type, signer=excluded.signer,
      fee=excluded.fee, time=excluded.time, n_in=excluded.n_in, n_out=excluded.n_out, coinbase=excluded.coinbase`);
    const insOut = d.prepare(`INSERT INTO outputs(txid,vout,addr,value,height,spent_txid,spent_height)
      VALUES(?,?,?,?,?,NULL,NULL) ON CONFLICT(txid,vout) DO UPDATE SET addr=excluded.addr, value=excluded.value, height=excluded.height`);
    const spend = d.prepare(`UPDATE outputs SET spent_txid=?, spent_height=? WHERE txid=? AND vout=?`);
    const lookupOut = d.prepare(`SELECT addr,value FROM outputs WHERE txid=? AND vout=?`);
    const insHist = d.prepare(`INSERT OR IGNORE INTO address_history(addr,txid,height,pos,direction,delta) VALUES(?,?,?,?,?,?)`);
    const insProp = d.prepare(`INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(txid) DO UPDATE SET domain=excluded.domain, payload_hash=excluded.payload_hash,
      uri=excluded.uri, expires_epoch=excluded.expires_epoch, proposer=excluded.proposer, fee=excluded.fee, height=excluded.height, time=excluded.time`);
    const insAtt = d.prepare(`INSERT INTO attestations(txid,proposal_id,attester,score,confidence,fee,height,time)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(txid) DO UPDATE SET proposal_id=excluded.proposal_id, attester=excluded.attester,
      score=excluded.score, confidence=excluded.confidence, fee=excluded.fee, height=excluded.height, time=excluded.time`);

    blk.txs.forEach((t, pos) => {
      const isCoinbase = pos === 0;
      const signer = deriveAddr(t.inputs?.[0]?.script_sig) ?? addrFromScriptPubkey(t.outputs?.[0]?.script_pubkey) ?? null;
      // resolve inputs against our own outputs → spends + input sum (skip coinbase)
      let sumIn = 0;
      const ins = t.inputs ?? [];
      for (const inp of ins) {
        const prev = inp.prev_txid ?? inp.prevTxid;
        if (!prev) continue; // coinbase input
        const vout = Number(inp.vout ?? 0);
        const prevOut = lookupOut.get(prev, vout) as { addr: string | null; value: number } | undefined;
        if (prevOut) {
          sumIn += Number(prevOut.value ?? 0);
          spend.run(t.txid, blk.height, prev, vout);
          if (prevOut.addr) insHist.run(prevOut.addr, t.txid, blk.height, pos, "out", -Number(prevOut.value ?? 0));
        }
      }
      // outputs
      let sumOut = 0;
      (t.outputs ?? []).forEach((o, vout) => {
        const addr = addrFromScriptPubkey(o.script_pubkey);
        const val = Number(o.value ?? 0);
        sumOut += val;
        insOut.run(t.txid, vout, addr, val, blk.height);
        if (addr) insHist.run(addr, t.txid, blk.height, pos, "in", val);
      });
      const fee = isCoinbase ? 0 : Math.max(0, sumIn - sumOut);
      const kind = appType(t, isCoinbase);
      insTx.run(t.txid, blk.height, pos, kind, signer, fee, time, ins.length, (t.outputs ?? []).length, isCoinbase ? 1 : 0);

      if (kind === "Propose" && t.app) {
        insProp.run(t.txid, String(t.app.domain ?? ""), String(t.app.payload_hash ?? ""), String(t.app.uri ?? ""),
          Number(t.app.expires_epoch ?? 0), signer, fee, blk.height, time);
      } else if (kind === "Attest" && t.app) {
        insAtt.run(t.txid, String(t.app.proposal_id ?? ""), signer, Number(t.app.score ?? 0),
          Number(t.app.confidence ?? 0), fee, blk.height, time);
      }
    });
  });
}

/** Hard-delete every row strictly above `ancestor`, un-spending outputs orphaned by it. */
export function unwindAbove(ancestor: number): void {
  const d = db();
  dbTx(() => {
    const h = ancestor;
    // un-spend outputs whose spender was orphaned (those spends no longer happened)
    d.prepare(`UPDATE outputs SET spent_txid=NULL, spent_height=NULL WHERE spent_height>?`).run(h);
    d.prepare(`DELETE FROM address_history WHERE height>?`).run(h);
    d.prepare(`DELETE FROM proposals WHERE height>?`).run(h);
    d.prepare(`DELETE FROM attestations WHERE height>?`).run(h);
    d.prepare(`DELETE FROM outputs WHERE height>?`).run(h);
    d.prepare(`DELETE FROM txs WHERE height>?`).run(h);
    d.prepare(`DELETE FROM blocks WHERE height>?`).run(h);
  });
}

/** Stored canonical block hash at height, or null. */
function storedHash(height: number): string | null {
  const r = db().prepare("SELECT hash FROM blocks WHERE height=? AND orphaned=0").get(height) as { hash: string } | undefined;
  return r?.hash ?? null;
}

/**
 * Detect a reorg by checking the new block's prev against our stored hash at h-1.
 * If it links, no reorg. If not, walk back to the last height where node hash == stored hash;
 * that's the common ancestor. Returns it, or -1 if no reorg, or scanFrom-1 if the divergence
 * runs below our scan floor (→ re-scan from the floor).
 *
 * We follow the reorg as DEEP as the scan floor — not just finalDepth. A reorg deeper than
 * finalDepth is rare but REAL (consensus moved; our "final" rows are genuinely orphaned), so
 * following it is correct AND keeps the loop making forward progress. The old code threw here,
 * which wedged syncOnce on every poll for any deep reorg at/above the tip (finding D-I1).
 */
async function findReorgAncestor(newBlock: rpc.RpcBlock): Promise<number> {
  const prevH = newBlock.height - 1;
  const storedPrev = storedHash(prevH);
  if (storedPrev == null) return -1;                       // nothing to link against (fresh / gap)
  if (storedPrev === (newBlock.header.prev ?? "")) return -1; // links cleanly — no reorg
  // diverged: walk back until node's hash matches what we stored (bounded by the scan floor)
  for (let h = prevH - 1; h >= CFG.scanFrom; h--) {
    const nodeBlk = await rpc.blockByHeight(h);
    const ours = storedHash(h);
    if (nodeBlk && ours && nodeBlk.hash === ours) return h;  // common ancestor
  }
  return CFG.scanFrom - 1;                                  // diverged below the floor → re-scan from scanFrom
}

/**
 * Index forward from where we left off up to (tip - 0); reorgs handled inline.
 * Returns a summary. Idempotent: re-running with no new blocks is a no-op.
 */
/**
 * Reconcile the re-checkable tip window against the node BEFORE the forward scan. The forward scan
 * only ever detects a reorg when a TALLER block arrives whose prev mismatches — so a reorg that
 * lands on an equal-or-LOWER tip height (more chainwork, same/fewer blocks — possible under LWMA,
 * and an equal-height tip-swap is common on any PoW chain) would otherwise be missed entirely,
 * leaving orphaned blocks/txs/outputs/proposals at heights (nodeTip..ourTip] served as canonical
 * (inflated tip, ghost proposals, double-counted balances, L3 resolving an orphaned mapping).
 * This walks the window [floor..min(ourTip,nodeTip)] and, if the node disagrees, unwinds to the
 * highest converged height. Returns the reorg depth (0 = nothing to do).
 */
async function reconcileTipWindow(tip: number): Promise<number> {
  const top = indexedHeight();
  if (top < CFG.scanFrom) return 0;
  const ceil = Math.min(top, tip);
  // Highest height ≤ ceil where our stored hash still matches the node. Fast path scans the
  // finalDepth window (the common, shallow case); if NOTHING converges there — a reorg deeper than
  // finalDepth, or a node tip at/below ours that diverged across the whole window — extend the search
  // down to the scan floor so we ALWAYS find the true ancestor and make forward progress. The old code
  // returned 0 here when the node tip was ≥ ours, leaving the forward scan to throw every poll and
  // wedge the loop on a deep taller/equal-height reorg (finding D-I1).
  let converged = -1;
  const fastFloor = Math.max(CFG.scanFrom, ceil - CFG.finalDepth);
  for (let h = ceil; h >= fastFloor; h--) {
    const nb = await rpc.blockByHeight(h);
    const ours = storedHash(h);
    if (nb && ours && nb.hash === ours) { converged = h; break; }
  }
  if (converged < 0) {                                     // deep divergence — walk on to the floor
    for (let h = fastFloor - 1; h >= CFG.scanFrom; h--) {
      const nb = await rpc.blockByHeight(h);
      const ours = storedHash(h);
      if (nb && ours && nb.hash === ours) { converged = h; break; }
    }
    if (converged < 0) converged = CFG.scanFrom - 1;       // no match even at the floor → full re-scan
  }
  if (converged >= top) return 0;                          // consistent up to our tip — nothing to unwind
  const depth = top - converged;
  unwindAbove(converged);
  setMeta(TIP_KEY, String(converged));
  bus.emitEvent({ kind: "reorg", ancestor: converged, depth });
  return depth;
}

export async function syncOnce(): Promise<IndexResult> {
  if (!(await rpc.reachable())) throw new Error("node RPC unreachable");
  const { height: tip } = await rpc.tip();
  let blocks = 0, reorgs = 0, reorgDepth = 0;
  // FIRST reconcile the tip window (catches an equal/lower-height reorg the forward scan can't).
  const reconciled = await reconcileTipWindow(tip);
  if (reconciled > 0) { reorgs++; reorgDepth = reconciled; }
  let from = indexedHeight() + 1;
  if (from < CFG.scanFrom) from = CFG.scanFrom;
  if (tip < from) return { from, to: indexedHeight(), tip, blocks, reorgs, reorgDepth };

  for (let h = from; h <= tip; h++) {
    const blk = await rpc.blockByHeight(h);
    if (!blk) break; // gap — stop; next poll retries
    // reorg check (only matters once we have a stored predecessor)
    const ancestor = await findReorgAncestor(blk);
    if (ancestor >= 0) {
      const prevIndexed = indexedHeight();
      unwindAbove(ancestor);
      setMeta(TIP_KEY, String(ancestor));
      reorgs++; reorgDepth = Math.max(reorgDepth, prevIndexed - ancestor);
      bus.emitEvent({ kind: "reorg", ancestor, depth: prevIndexed - ancestor });
      h = ancestor; // resume scanning from ancestor+1
      continue;
    }
    writeBlock(blk);
    setMeta(TIP_KEY, String(h));
    blocks++;
    emitBlockEvents(blk, tip);
  }
  return { from, to: indexedHeight(), tip, blocks, reorgs, reorgDepth };
}

// Emit streaming events only for blocks near the tip (don't flood the firehose during
// a from-genesis backfill). status deepens to "confirmed" past finalDepth.
function emitBlockEvents(blk: rpc.RpcBlock, tip: number): void {
  if (tip - blk.height > CFG.finalDepth + 5) return;
  const status: "tentative" | "confirmed" = tip - blk.height >= CFG.finalDepth ? "confirmed" : "tentative";
  bus.emitEvent({ kind: "block", height: blk.height, hash: blk.hash, tx_count: blk.txs.length, status });
  blk.txs.forEach((t, pos) => {
    const ty = appType(t, pos === 0);
    if (ty === "Propose" && t.app) bus.emitEvent({ kind: "proposal", txid: t.txid, domain: String(t.app.domain ?? ""), height: blk.height, status });
    else if (ty === "Attest" && t.app) bus.emitEvent({ kind: "attestation", txid: t.txid, proposal_id: String(t.app.proposal_id ?? ""), attester: deriveAddr(t.inputs?.[0]?.script_sig) ?? "0x?", height: blk.height, status });
  });
}
