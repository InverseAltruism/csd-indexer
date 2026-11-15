// Not a suite (the runner globs test/*.test.ts). Shared by the first-occurrence tests: blocks with real merkle
// roots and cumulative chainwork, a chain on which a coinbase, a Propose and an Attest are each held by two
// blocks, a mock node that serves a chain, and a dump of every table.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { merkleRoot } from "@inversealtruism/csd-codec";
import type { Store } from "../src/db.js";

export const id = (tag: string): string => "0x" + createHash("sha256").update(tag).digest("hex");
export const MINER = "0x" + "a1".repeat(20);
export const PAYEE = "0x" + "c3".repeat(20);
export const DOMAIN = "repeat:test";

export interface Tx { txid: string; inputs: { prev_txid: string; vout: number }[]; outputs: { script_pubkey: string; value: number }[]; app?: Record<string, unknown> }
export interface Blk { hash: string; height: number; chainwork: string; header: { bits: number; merkle: string; nonce: number; prev: string; time: number; version: number }; txs: Tx[] }

export const coinbase = (tag: string): Tx => ({ txid: id(`coinbase-${tag}`), inputs: [], outputs: [{ script_pubkey: MINER, value: 50 }] });
/** A tx spending output 0 of `of`. */
export const spend = (tag: string, of: Tx, value: number, app?: Tx["app"]): Tx =>
  ({ txid: id(tag), inputs: [{ prev_txid: of.txid, vout: 0 }], outputs: [{ script_pubkey: PAYEE, value }], ...(app ? { app } : {}) });
export const propose = (tag: string, of: Tx, value: number): Tx =>
  spend(tag, of, value, { type: "Propose", domain: DOMAIN, payload_hash: id(`payload-${tag}`), uri: `u-${tag}`, expires_epoch: 9999 });
export const attest = (tag: string, of: Tx, value: number, proposal: Tx): Tx =>
  spend(tag, of, value, { type: "Attest", proposal_id: proposal.txid, score: 100, confidence: 100 });

/** The block after `parent` (height 0 without one). `work` is the block's own work: a branch that replaces another carries more. */
export function block(parent: Blk | null, tag: string, txs: Tx[], work = 1000): Blk {
  const height = parent ? parent.height + 1 : 0;
  return {
    hash: id(`block-${tag}`), height, chainwork: String(BigInt(parent?.chainwork ?? 0) + BigInt(work)),
    header: { bits: 0x1e00ffff, merkle: merkleRoot(txs.map((t) => t.txid)), nonce: 0, prev: parent?.hash ?? "0x" + "00".repeat(32), time: 1_700_000_000 + height * 120, version: 1 },
    txs,
  };
}

/**
 * Heights 0..6. C1 is the coinbase of heights 1 and 4. P (a Propose) is at height 2 position 1 and at height 5
 * position 2; A (an Attest on P) at height 3 position 1 and height 5 position 3. A's output 0 is spent by D at
 * height 4 and, after A's second occurrence, by S at height 6. Every block holds a transaction no other holds.
 */
export function repeatChain() {
  const G = coinbase("0"), C1 = coinbase("1");
  const Y = spend("y", G, 49);
  const P = propose("p", C1, 48);
  const A = attest("a", P, 47, P);
  const X2 = spend("x2", Y, 48), X3 = spend("x3", X2, 47), X5 = spend("x5", X3, 46);
  const D = spend("d", A, 46), S = spend("s", A, 45);
  const b0 = block(null, "0", [G]);
  const b1 = block(b0, "1", [C1, Y]);
  const b2 = block(b1, "2", [coinbase("2"), P, X2]);
  const b3 = block(b2, "3", [coinbase("3"), A, X3]);
  const b4 = block(b3, "4", [C1, D]);
  const b5 = block(b4, "5", [coinbase("5"), X5, P, A]);
  const b6 = block(b5, "6", [coinbase("6"), S]);
  return { C1, Y, P, A, X2, X3, X5, D, S, main: [b0, b1, b2, b3, b4, b5, b6] };
}

/** A mock node answering /tip and /block/height/:h from the chain `chain()` returns at request time. */
export async function mockNode(chain: () => Blk[]): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const blocks = chain();
    res.setHeader("content-type", "application/json");
    if (req.url === "/tip") {
      const t = blocks[blocks.length - 1];
      return res.end(JSON.stringify({ ok: true, tip: t?.hash ?? "", height: t?.height ?? 0, chainwork: t?.chainwork ?? "0" }));
    }
    const m = /^\/block\/height\/(\d+)$/.exec(req.url ?? "");
    const b = m ? blocks.find((x) => x.height === Number(m[1])) : undefined;
    if (!b) { res.statusCode = 404; return res.end("{}"); }
    res.end(JSON.stringify({ ok: true, ...b }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const TABLES: Record<string, string> = {
  blocks: "height", txs: "txid", tx_repeats: "height, pos", outputs: "txid, vout",
  address_history: "addr, txid, direction, delta, pos", proposals: "txid", attestations: "txid",
  coinbase_totals: "addr", address_totals: "addr", meta: "key",
};
/** Every row of every table (but those in `skip`) in primary-key order, integers past 2^53 as strings. */
export async function dump(s: Store, skip: string[] = []): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [table, key] of Object.entries(TABLES)) {
    if (skip.includes(table)) continue;
    const rows = await s.all(`SELECT * FROM ${table} ORDER BY ${key}`);
    out[table] = JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }
  return out;
}
