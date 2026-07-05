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

// The backend we are currently reading from. selectBackend() (called once per sync cycle) moves it to
// the healthiest source; every getJson in a cycle then uses that one consistent backend.
let ACTIVE = (CFG.rpcBackends && CFG.rpcBackends[0]) || CFG.rpc;
const HYSTERESIS_BLOCKS = 3; // keep ACTIVE unless it falls more than this many blocks behind the best
export function activeBackend(): string { return ACTIVE; }

async function getJson(path: string): Promise<any> {
  const res = await fetch(ACTIVE + path);
  if (!res.ok) throw new Error(`rpc ${path} -> ${res.status}`);
  return res.json();
}

async function tipOf(base: string): Promise<{ height: number; chainwork: bigint } | null> {
  try {
    const res = await fetch(base + "/tip", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return { height: Number(j.height ?? 0), chainwork: BigInt(String(j.chainwork ?? "0")) };
  } catch { return null; }
}

/**
 * Choose which backend to read THIS cycle: the reachable one with the most cumulative chainwork, with
 * HYSTERESIS so it does not flap and does NOT auto-fail-back. Keep ACTIVE while it is reachable and within
 * HYSTERESIS_BLOCKS of the best height (so same-chain backends racing block propagation do not flap, and
 * once we move off the primary we stay until a human restarts). Only when ACTIVE falls meaningfully behind
 * (or is gone) do we switch to the highest-chainwork backend, preferring the primary among ties. A node
 * that falls behind (resync / lag) has less work, so selection moves to the miner/standby and the
 * projection keeps advancing on fresh data. If NOTHING is reachable, keep ACTIVE (reads then fail and the
 * caller retries next poll).
 */
export async function selectBackend(): Promise<{ active: string; switched: boolean; height: number }> {
  const backends = CFG.rpcBackends && CFG.rpcBackends.length ? CFG.rpcBackends : [CFG.rpc];
  const probed = await Promise.all(backends.map(async (b) => ({ b, t: await tipOf(b) })));
  const reachable = probed.filter((x): x is { b: string; t: { height: number; chainwork: bigint } } => x.t != null);
  const prev = ACTIVE;
  if (reachable.length === 0) return { active: ACTIVE, switched: false, height: 0 };
  let maxWork = reachable[0]!.t.chainwork;
  for (const r of reachable) if (r.t.chainwork > maxWork) maxWork = r.t.chainwork;
  const best = reachable.filter((r) => r.t.chainwork === maxWork);
  const bestHeight = Math.max(...reachable.map((r) => r.t.height));
  const activeEntry = reachable.find((r) => r.b === ACTIVE);
  const primary = backends[0];
  const chosen = (activeEntry && activeEntry.t.height >= bestHeight - HYSTERESIS_BLOCKS)
    ? ACTIVE                                                          // sticky: ACTIVE still close enough
    : (best.find((r) => r.b === primary)?.b ?? best[0]!.b);          // switch to highest-work, primary-preferred
  ACTIVE = chosen;
  return { active: chosen, switched: chosen !== prev, height: reachable.find((r) => r.b === chosen)!.t.height };
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

