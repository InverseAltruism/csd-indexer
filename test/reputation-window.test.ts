// M-117: /address/:a/reputation aggregates the newest 200 attestations. Past that window it says so
// (`truncated`, `note`) instead of presenting the figures as lifetime totals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";

const DB = `/tmp/csd-idx-reputation-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_reputation";

const { buildApp } = await import("../src/server.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");

const txid = (i: number) => "0x" + i.toString(16).padStart(64, "0");
const AT_WINDOW = "0x" + "a1".repeat(20);   // exactly 200 attestations
const PAST_WINDOW = "0x" + "b2".repeat(20); // 201: the oldest one falls outside the window

await resetStoreForTests();
await store().tx(async (d) => {
  const put = async (attester: string, i: number, h: number, score: number, fee: number) =>
    d.run("INSERT INTO attestations(txid,proposal_id,attester,score,confidence,fee,height,time) VALUES(?,?,?,?,?,?,?,?)",
      txid(i), txid(999_999), attester, score, 50, fee, h, 1700000000 + h);
  for (let i = 0; i < 200; i++) await put(AT_WINDOW, i, 100 + i, 80, 10);
  await put(PAST_WINDOW, 1000, 1, 0, 1_000_000);                      // the oldest: outside the window
  for (let i = 0; i < 200; i++) await put(PAST_WINDOW, 1001 + i, 100 + i, 90, 10);
});

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const rep = async (a: string) => { const r = await fetch(`${base}/address/${a}/reputation`); assert.equal(r.status, 200); return r.json() as Promise<any>; };

test("past the window: truncated, the note names the window, the figures cover the newest 200", async () => {
  const r = await rep(PAST_WINDOW);
  assert.equal(r.truncated, true);
  assert.equal(r.note, "newest 200 attestations only");
  assert.equal(r.attestations, 200);
  assert.equal(r.avg_score, 90, "the oldest attestation (score 0) is outside the window");
  assert.equal(r.fees_paid, 2000);
});

test("HAPPY PATH: exactly 200 attestations is complete: not truncated, no note", async () => {
  const r = await rep(AT_WINDOW);
  assert.deepEqual(r, { address: AT_WINDOW, attestations: 200, avg_score: 80, avg_confidence: 50, fees_paid: 2000, truncated: false });
});

test("HAPPY PATH: an address with no attestations", async () => {
  assert.deepEqual(await rep("0x" + "c3".repeat(20)),
    { address: "0x" + "c3".repeat(20), attestations: 0, avg_score: 0, avg_confidence: 0, fees_paid: 0, truncated: false });
});

test.after(async () => { srv.close(); await closeDb(); });
