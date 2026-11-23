// Postgres: readers of a block's lists and of its tx while the writer swaps that block between two branches through
// the reorg path (unwindAbove + writeBlock). Each answer is the asked block's own content or a 404: with two
// statements per route, 397 of 29,797 answers were 200 with an empty list for a block holding a transaction.
// test/snapshot-reads.test.ts places the commit between the statements deterministically, on both backends.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";
import { type Blk, block, coinbase, spend } from "./_repeat-chain.js";

process.env.CSD_INDEX_DB = tmpDb("pgrace");
process.env.CSD_INDEX_PG_SCHEMA = "t_pgrace";
process.env.CSD_INDEX_FROM = "0";
const { writeBlock, unwindAbove } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");
const PG = store().backend === "postgres";
test.after(async () => { await closeDb(); });

test("Postgres: block and tx reads across 150 reorg swaps answer the asked block's content or 404",
  { skip: !PG && "Postgres only: SQLite reads cannot interleave with this process's writer; test/snapshot-reads.test.ts covers both" }, async () => {
    await resetStoreForTests();
    const chain: Blk[] = [];
    let parent: Blk | null = null;
    for (let h = 0; h < 10; h++) { parent = block(parent, `race-${h}`, [coinbase(`race-${h}`)]); chain.push(parent); await writeBlock(parent as never, true); }
    const pay = spend("race-pay", chain[1]!.txs[0]!, 40);
    const A = block(parent, "race-A", [coinbase("race-A"), pay]), B = block(parent, "race-B", [coinbase("race-B")]);
    await writeBlock(A as never, true);
    const srv = buildApp().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const wantIds = A.txs.map((t) => t.txid);
    const tally = { answers: 0, notFound: 0, torn: [] as string[] };
    let stop = false;
    const reader = (path: string, ok: (body: any) => boolean) => (async () => {
      while (!stop) {
        const r = await fetch(base + path);
        tally.answers++;
        if (r.status === 404) { tally.notFound++; await r.arrayBuffer(); continue; }
        const body = await r.json();
        if (r.status !== 200 || !ok(body)) tally.torn.push(`${path} ${r.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    })();
    const readers = [
      reader(`/block/${A.hash}/txids`, (b) => JSON.stringify(b) === JSON.stringify(wantIds)),
      reader(`/block/${A.hash}/txs`, (b) => JSON.stringify(b.map((t: any) => t.txid)) === JSON.stringify(wantIds)),
      reader(`/tx/${pay.txid}`, (b) => b.outputs.length === 1),
      reader(`/block/${A.hash}/txids`, (b) => JSON.stringify(b) === JSON.stringify(wantIds)),
    ];
    for (let i = 0; i < 150; i++) {
      await unwindAbove(9); await writeBlock(B as never, true);
      await unwindAbove(9); await writeBlock(A as never, true);
    }
    stop = true; await Promise.all(readers);
    srv.close();
    assert.ok(tally.answers > tally.notFound, `some reads met block A (answers ${tally.answers}, 404 ${tally.notFound})`);
    assert.deepEqual(tally.torn.slice(0, 5), [], `torn answers: ${tally.torn.length} of ${tally.answers}`);
  });
