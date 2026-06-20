// Thin client for the CSD node RPC — the only thing the indexer trusts (and even
// then, every derived claim it serves is independently recomputable from these
// raw blocks, so the node is a data source, not an authority).
//
// Verified shapes (live node, 2026-06-07):
//   GET /tip               -> { tip, height, chainwork }
//   GET /block/height/:h   -> { ok, hash, height, chainwork, header:{bits,merkle,nonce,prev,time,version}, txs:[...] }
//   GET /tx/:txid          -> { ... } (or { tx: {...} })
//   tx  = { txid, version, locktime, app?, inputs:[{prev_txid,vout,script_sig}], outputs:[{script_pubkey,value}] }
import { CFG } from "./config.js";

export interface RpcHeader { bits: number; merkle: string; nonce: number; prev: string; time: number; version: number; }
export interface RpcTxIn { prev_txid?: string; prevTxid?: string; vout?: number; script_sig?: string; }
export interface RpcTxOut { script_pubkey?: string; value?: number; }
export interface RpcTx { txid: string; version?: number; locktime?: number; app?: any; inputs?: RpcTxIn[]; outputs?: RpcTxOut[]; }
export interface RpcBlock { hash: string; height: number; chainwork?: string; header: RpcHeader; txs: RpcTx[]; }

async function getJson(path: string): Promise<any> {
  const res = await fetch(CFG.rpc + path);
  if (!res.ok) throw new Error(`rpc ${path} -> ${res.status}`);
  return res.json();
}

export async function tip(): Promise<{ height: number; tip: string; chainwork: string }> {
  const j = await getJson("/tip");
  return { height: Number(j.height ?? 0), tip: String(j.tip ?? ""), chainwork: String(j.chainwork ?? "0") };
}

export async function reachable(): Promise<boolean> {
  try { await getJson("/tip"); return true; } catch { return false; }
}

export async function blockByHeight(h: number): Promise<RpcBlock | null> {
  try {
    const j = await getJson(`/block/height/${h}`);
    const b = j.block ?? j;
    if (!b || !b.header || !Array.isArray(b.txs)) return null;
    return b as RpcBlock;
  } catch { return null; }
}

// NOTE (audit dead-code): no in-repo caller — the indexer derives every tx from the block bodies
// returned by blockByHeight(), never by single-tx fetch. Kept as part of the thin RPC client's
// public surface (a third party running this indexer may call it); remove if that ever changes.
export async function getTx(txid: string): Promise<RpcTx | null> {
  try { const j = await getJson(`/tx/${txid}`); return (j.tx ?? j) as RpcTx; } catch { return null; }
}
