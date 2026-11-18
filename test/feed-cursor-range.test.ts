// The feeds' cursor and snapshot numbers are compared with columns of fixed size: txs.pos is an INTEGER, 4 bytes on
// Postgres, where a bind above PG_INTEGER_MAX fails the statement and the route answered 500 while SQLite answered a
// page. A position above it is refused as a malformed cursor on both backends; the largest one in range still pages. A
// height is a BIGINT, which holds every safe integer the route accepts, so heights at the top of that range answer as
// any height past the tip does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpDb } from "./_tmpdb.js";

process.env.CSD_INDEX_DB = tmpDb("feed-range");
process.env.CSD_INDEX_PG_SCHEMA = "t_feed_range";
process.env.CSD_INDEX_FROM = "0";

const { writeBlock } = await import("../src/indexer.js");
const { resetStoreForTests, closeDb, PG_INTEGER_MAX } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
test.after(async () => { srv.close(); await closeDb(); });

const id = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const h256 = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");
const hashOf = (h: number) => h256(`block-range-${h}`);
const out = { script_pubkey: "0x" + "c3".repeat(20), value: 1 };
// heights 0..3: two proposals at height 1, an attestation of each at height 2
const RECS: unknown[][] = [[], [
  { txid: id(0x9001), inputs: [], outputs: [out], app: { type: "Propose", domain: "d:v1", payload_hash: id(1), uri: "u1", expires_epoch: 9 } },
  { txid: id(0x9002), inputs: [], outputs: [out], app: { type: "Propose", domain: "d:v1", payload_hash: id(1), uri: "u2", expires_epoch: 9 } },
], [
  { txid: id(0xa001), inputs: [], outputs: [out], app: { type: "Attest", proposal_id: id(0x9001), score: 100, confidence: 100 } },
  { txid: id(0xa002), inputs: [], outputs: [out], app: { type: "Attest", proposal_id: id(0x9002), score: 100, confidence: 100 } },
], []];
async function load(): Promise<void> {
  await resetStoreForTests();
  for (let h = 0; h < RECS.length; h++) {
    await writeBlock({ hash: hashOf(h), height: h, chainwork: String(h + 1),
      header: { bits: 0x1e00ffff, merkle: id(2), nonce: 0, prev: h ? hashOf(h - 1) : id(0), time: 1000 + h, version: 1 },
      txs: [{ txid: h256(`coinbase-range-${h}`), inputs: [], outputs: [out] }, ...RECS[h]!] } as never);
  }
}
const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as any }; };
const AT = `3:${hashOf(3)}`;
const REFUSED = { error: "want after=<height>:<position in block>" };

test("a position above txs.pos's range is refused with the route's error, on both feeds and formats", async () => {
  await load();
  assert.equal(PG_INTEGER_MAX, 2 ** 31 - 1);
  for (const path of ["/proposals", "/attestations"]) {
    for (const fmt of ["", "&format=2"]) {
      for (const pos of [PG_INTEGER_MAX + 1, 9_007_199_254_740_993]) {
        const r = await get(`${path}?at=${AT}&after=1:${pos}${fmt}`);
        assert.equal(r.status, 400, `${path} pos=${pos}${fmt}`);
        assert.deepEqual(r.body, REFUSED);
      }
      // the largest position in range: the page after the whole of height 1
      const top = await get(`${path}?at=${AT}&after=1:${PG_INTEGER_MAX}${fmt}`);
      assert.equal(top.status, 200, `${path} pos=${PG_INTEGER_MAX}${fmt}`);
      assert.deepEqual(top.body.rows.map((x: any) => x.height), path === "/proposals" ? [] : [2, 2]);
    }
  }
});

test("HAPPY PATH: a real cursor still pages on both feeds", async () => {
  await load();
  for (const path of ["/proposals", "/attestations"]) {
    const first = await get(`${path}?at=${AT}&limit=1`);
    assert.equal(first.status, 200);
    const second = await get(`${path}?at=${AT}&limit=1&after=${first.body.next}`);
    assert.equal(second.status, 200);
    assert.equal(second.body.rows.length, 1);
    assert.notEqual(second.body.rows[0].txid, first.body.rows[0].txid);
  }
});

test("heights at the top of the safe range answer as any height past the tip, on both feeds", async () => {
  await load();
  const top = Number.MAX_SAFE_INTEGER;
  for (const path of ["/proposals", "/attestations"]) {
    assert.equal((await get(`${path}?at=${top}`)).status, 409, `${path} at=${top}`);
    assert.equal((await get(`${path}?at=${top}:${hashOf(3)}`)).status, 409, `${path} at=${top}:<hash>`);
    const after = await get(`${path}?at=${AT}&after=${top}:0`);
    assert.equal(after.status, 200, `${path} after=${top}:0`);
    assert.deepEqual([after.body.rows, after.body.next], [[], null]);
    assert.equal((await get(`${path}?at=${top + 1}`)).status, 400, "past the safe range: refused as before");
  }
});
