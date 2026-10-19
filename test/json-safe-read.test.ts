// P74-45: the resolver's feed readers serialize a stored integer past 2^53 as a decimal string. The store
// returns such a value as a bigint (db.ts), and a bigint in a response body makes JSON.stringify throw, so
// without jsonSafeAll one Propose with a huge expires_epoch (anyone can anchor one) 500s every page of
// /domain/:d/proposals that contains it, and the resolver stops advancing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";

const DB = `/tmp/csd-idx-jsonsafe-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_jsonsafe";

const { buildApp } = await import("../src/server.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");

const txid = (i: number) => "0x" + i.toString(16).padStart(64, "0");
const SENTINEL = 2n ** 53n;   // safeEpoch's sentinel for an expires_epoch past 2^53: the smallest unsafe integer
const BIG_FEE = 2n ** 60n;
const DOMAIN = "probe:dom";
const PROP = txid(1);

await resetStoreForTests();
await store().tx(async (d) => {
  await d.run("INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time) VALUES(?,?,?,?,?,?,?,?,?)",
    PROP, DOMAIN, txid(2), "u", SENTINEL, "0x" + "a1".repeat(20), 1000, 10, 1700000000);
  await d.run("INSERT INTO proposals(txid,domain,payload_hash,uri,expires_epoch,proposer,fee,height,time) VALUES(?,?,?,?,?,?,?,?,?)",
    txid(3), DOMAIN, txid(4), "u", 99, "0x" + "a1".repeat(20), 1000, 11, 1700000000);
  await d.run("INSERT INTO attestations(txid,proposal_id,attester,score,confidence,fee,height,time) VALUES(?,?,?,?,?,?,?,?)",
    txid(5), PROP, "0x" + "b2".repeat(20), 100, 100, BIG_FEE, 12, 1700000000);
});

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };

test("/domain/:d/proposals?from=0 (the resolver's paging read): 200, the big expires_epoch as a decimal string", async () => {
  const r = await get(`/domain/${DOMAIN}/proposals?from=0&limit=10000`);
  assert.equal(r.status, 200);
  assert.equal(r.body[0].expires_epoch, SENTINEL.toString());
  assert.equal(r.body[1].expires_epoch, 99, "a safe integer stays a number");
});

test("/domain/:d/proposals without a cursor: 200, the same string", async () => {
  const r = await get(`/domain/${DOMAIN}/proposals`);
  assert.equal(r.status, 200);
  assert.equal(r.body.find((p: any) => p.txid === PROP).expires_epoch, SENTINEL.toString());
});

test("/proposal/:id/attestations (the resolver's attestation read): 200, the big fee as a decimal string", async () => {
  const r = await get(`/proposal/${PROP}/attestations`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].fee, BIG_FEE.toString());
  assert.equal(r.body[0].score, 100);
});

test("/proposal/:id: 200, both big values as strings", async () => {
  const r = await get(`/proposal/${PROP}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.expires_epoch, SENTINEL.toString());
  assert.equal(r.body.attestations[0].fee, BIG_FEE.toString());
});

test.after(async () => { srv.close(); await closeDb(); });
