// The registry, identity and content routes left with the content swarm (P-5): each answers 404, while the routes
// the explorer and the CairnX resolver read keep answering on the same app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const DB = `/tmp/csd-idx-removed-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_removed";

const { resetStoreForTests, closeDb } = await import("../src/db.js");
const { buildApp } = await import("../src/server.js");
await resetStoreForTests();

const srv = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
test.after(async () => { srv.close(); await closeDb(); });

const ADDR = "0x" + "6b".repeat(20), HASH = "0x" + "ab".repeat(32);

test("the registry, identity and content routes answer 404", async () => {
  for (const p of ["/registry/peers", "/registry/gateways", "/identity/alice", `/address/${ADDR}/identity`, `/content/${HASH}`]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test("HAPPY PATH: the routes the explorer and the resolver read still answer", async () => {
  for (const p of ["/health", "/domains", "/domain/cairnx%3Av1/proposals", `/address/${ADDR}`, `/address/${ADDR}/reputation`, `/proposal/${HASH}/attestations`]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/, p);
  }
});
