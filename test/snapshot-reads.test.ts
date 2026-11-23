// One answer, one view: a route that reads several rows of the chain reads them in one statement, or in one snapshot
// (db.ts snapshot), so a reorg's commit between two of its statements cannot make it answer 200 with half of each
// view (`outputs: []` for a tx with outputs, `[]` for a block with transactions, an attestation count that is not the
// list's length, a tip height without its hash, emitted supply from two tips). Deterministic on both backends: after
// the route's n-th statement the reorg's unwind of the top block commits on another connection, for every n the
// route has; each answer must equal the one before the unwind or the one after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";
import { spyStore } from "./_store-spy.js";
import { type Blk, type Tx, PAYEE, attest, block, coinbase, propose, spend } from "./_repeat-chain.js";

const DB = tmpDb("snapshot");
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_snapshot";
process.env.CSD_INDEX_FROM = "0";
const { writeBlock } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");
const PG = store().backend === "postgres";

// Heights 0..10: a coinbase each; P (a Propose) at 9; at 10 a payment T with two outputs and a fee, and A (an Attest
// on P). The unwind removes height 10.
const cbs: Tx[] = [];
const blocks: Blk[] = [];
let parent: Blk | null = null;
for (let h = 0; h <= 10; h++) {
  const cb = coinbase(`snap-${h}`); cbs.push(cb);
  const extra: Tx[] = [];
  if (h === 9) extra.push(propose("snap-P", cbs[1]!, 40));
  if (h === 10) {
    extra.push({ ...spend("snap-T", cbs[2]!, 30), outputs: [{ script_pubkey: PAYEE, value: 30 }, { script_pubkey: "0x" + "d4".repeat(20), value: 15 }] });
    extra.push(attest("snap-A", cbs[3]!, 45, blocks[9]!.txs[1]!));
  }
  parent = block(parent, `snap-${h}`, [cb, ...extra]);
  blocks.push(parent);
}
const T = blocks[10]!.txs[1]!, P = blocks[9]!.txs[1]!;
// Each seed gives the top block a hash of its own, so the per-tip analytics memo computes again.
let seeds = 0;
const top = () => blocks[10]!;
const UNWIND = ["DELETE FROM address_history WHERE height>9", "DELETE FROM attestations WHERE height>9", "DELETE FROM proposals WHERE height>9",
  "UPDATE outputs SET spent_txid=NULL, spent_height=NULL WHERE spent_height>9", "DELETE FROM outputs WHERE height>9", "DELETE FROM txs WHERE height>9",
  "DELETE FROM tx_repeats WHERE height>9", "DELETE FROM blocks WHERE height>9", "UPDATE meta SET value='9' WHERE key='indexed_height'"];

// The unwind, committed on a connection of its own.
async function unwindElsewhere(): Promise<void> {
  if (PG) {
    const { Client } = createRequire(import.meta.url)("pg") as typeof import("pg");
    const c = new Client({ connectionString: process.env.CSD_INDEX_PG });
    await c.connect();
    try { await c.query("SET search_path TO t_snapshot"); await c.query(`BEGIN; ${UNWIND.join("; ")}; COMMIT`); } finally { await c.end(); }
  } else {
    const d = new DatabaseSync(DB);
    try { d.exec("PRAGMA busy_timeout = 5000"); d.exec(`BEGIN IMMEDIATE; ${UNWIND.join("; ")}; COMMIT`); } finally { d.close(); }
  }
}
async function seed(): Promise<void> {
  blocks[10] = block(blocks[9]!, `snap-10-${seeds++}`, blocks[10]!.txs);
  await resetStoreForTests();
  for (const b of blocks) await writeBlock(b as never, true);
}

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };
test.after(async () => { srv.close(); await closeDb(); });

// The answer with the unwind committed after the route's n-th statement, or null when the route has fewer.
async function withUnwindAfter(n: number, path: () => string): Promise<{ status: number; body: any } | null> {
  await seed();
  let seen = 0, fired = false;
  const undo = spyStore(store(), async (_m, a, real) => {
    const r = await real(...a);
    if (++seen === n) { fired = true; await unwindElsewhere(); }
    return r;
  });
  try {
    const out = await get(path());
    return fired ? out : null;
  } finally { undo(); }
}
// Every answer of `path` across the unwind, each checked by `ok`, the answers before and after included.
async function sweep(path: () => string, ok: (a: { status: number; body: any }, when: string) => void): Promise<number> {
  await seed();
  ok(await get(path()), "before the unwind");
  let n = 1;
  for (; n <= 12; n++) {
    const a = await withUnwindAfter(n, path);
    if (!a) break;
    ok(a, `unwind after statement ${n}`);
  }
  await seed(); await unwindElsewhere();
  ok(await get(path()), "after the unwind");
  return n - 1;
}

test("/block/:hash/txids and /txs: the block's whole list or 404, never an empty list", async () => {
  const ids = top().txs.map((t) => t.txid);
  await sweep(() => `/block/${top().hash}/txids`, (a, when) => {
    if (a.status === 404) return;
    assert.equal(a.status, 200, when); assert.deepEqual(a.body, ids, when);
  });
  await sweep(() => `/block/${top().hash}/txs`, (a, when) => {
    if (a.status === 404) return;
    assert.equal(a.status, 200, when); assert.deepEqual(a.body.map((t: any) => t.txid), ids, when);
  });
});

test("/tx/:id: the tx with its outputs or 404, never `outputs: []`", async () => {
  await sweep(() => `/tx/${T.txid}`, (a, when) => {
    if (a.status === 404) return;
    assert.equal(a.status, 200, when); assert.equal(a.body.outputs.length, 2, when);
  });
});

test("/address/:a/txs: every listed tx carries its outputs", async () => {
  await sweep(() => `/address/${PAYEE}/txs`, (a, when) => {
    assert.equal(a.status, 200, when);
    for (const t of a.body) assert.ok(t.outputs.length >= 1, `${when}: ${t.txid} listed without outputs`);
  });
});

test("/proposal/:id: the inline count is the inline list's length", async () => {
  await sweep(() => `/proposal/${P.txid}`, (a, when) => {
    assert.equal(a.status, 200, when);
    assert.equal(a.body.attestation_count, a.body.attestations.length, when);
  });
});

test("/health: the tip height comes with its hash", async () => {
  await sweep(() => "/health", (a, when) => {
    assert.equal(a.status, 200, when);
    assert.ok(a.body.tip_hash != null, `${when}: tip_height ${a.body.tip_height} without a hash`);
    assert.equal(a.body.tip_height, a.body.indexed_height, when);
  });
});

test("/analytics/supply: emitted supply is one tip's coinbase outputs less that tip's fees", async () => {
  const figure = (upTo: number) => {
    let cb = 0n, fees = 0n;
    for (const b of blocks.slice(0, upTo + 1)) {
      cb += BigInt(b.txs[0]!.outputs[0]!.value);
      for (const t of b.txs.slice(1)) fees += 50n - t.outputs.reduce((s, o) => s + BigInt(o.value), 0n);
    }
    return (cb - fees).toString();
  };
  await sweep(() => "/analytics/supply", (a, when) => {
    assert.equal(a.status, 200, when);
    assert.equal(a.body.emitted_supply, figure(a.body.height), `${when}: emitted at height ${a.body.height}`);
  });
});
