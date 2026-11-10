// A Propose's domain and uri are text its author chooses, and the node admits any UTF-8 there, U+0000 included. Postgres
// TEXT refuses U+0000 and node:sqlite reads TEXT back only up to it, so the indexer keeps U+0001 in its place
// (src/decode.ts storableText). Backend-agnostic: sqlite by default; CI's postgres job runs this file with CSD_INDEX_PG set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpDb } from "./_tmpdb.js";

const DB = tmpDb("storable");
const NUL = "\u0000", SOH = "\u0001";
const hex = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");
// A canonical cairnx:v1 transfer and its payload hash: the uri a resolver would apply.
const CANON = `{"amount":"5","t":"transfer","ticker":"CAIRN","to":"0x${"ab".repeat(20)}","v":1}`;
const PROPOSER = "0x" + "c3".repeat(20);

type Prop = { domain: string; uri: string; payload_hash: string };
type B = { hash: string; height: number; chainwork: string; header: Record<string, unknown>; txs: unknown[] };
let CHAIN: B[] = [];

// The node's block shape (rpc.ts header); JSON.stringify writes U+0000 as \u0000, as the node's serde_json does.
function chain(tag: string, props: Prop[]): B[] {
  const g: B = {
    hash: hex(`${tag}-g`), height: 0, chainwork: "16777472",
    header: { bits: 439936688, merkle: hex(`${tag}-mg`), nonce: 1, prev: "0x" + "0".repeat(64), time: 1785701851, version: 1 },
    txs: [{ txid: hex(`${tag}-cb0`), version: 1, locktime: 0, app: { type: "None" },
      inputs: [{ prev_txid: "0x" + "0".repeat(64), vout: 4294967295, script_sig: "0x00", script_sig_text: null }],
      outputs: [{ script_pubkey: PROPOSER, value: 5000000000 }] }],
  };
  const b1: B = {
    hash: hex(`${tag}-b1`), height: 1, chainwork: "33554944",
    header: { bits: 439936688, merkle: hex(`${tag}-m1`), nonce: 2, prev: g.hash, time: 1785701971, version: 1 },
    txs: [
      { txid: hex(`${tag}-cb1`), version: 1, locktime: 1, app: { type: "None" },
        inputs: [{ prev_txid: "0x" + "0".repeat(64), vout: 4294967295, script_sig: "0x01", script_sig_text: null }],
        outputs: [{ script_pubkey: PROPOSER, value: 5000000000 }] },
      ...props.map((p, i) => ({
        txid: hex(`${tag}-p${i}`), version: 1, locktime: 0,
        inputs: [{ prev_txid: hex(`${tag}-cb0`), vout: 0, script_sig: "0x", script_sig_text: null }],
        outputs: [{ script_pubkey: PROPOSER, value: 1 }],
        app: { type: "Propose", domain: p.domain, payload_hash: p.payload_hash, uri: p.uri, expires_epoch: 9999 },
      })),
    ],
  };
  return [g, b1];
}
const txidOf = (tag: string, i: number) => hex(`${tag}-p${i}`);

const node: Server = createServer((req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("connection", "close");
  const u = req.url || "";
  const t = CHAIN[CHAIN.length - 1];
  if (u === "/tip") return res.end(JSON.stringify({ ok: true, tip: t?.hash ?? "", height: t?.height ?? 0, chainwork: t?.chainwork ?? "0" }));
  const m = u.match(/^\/block\/height\/(\d+)$/);
  const b = m ? CHAIN[Number(m[1])] : undefined;
  if (b) return res.end(JSON.stringify({ ok: true, ...b }));
  res.statusCode = 404; res.end("{}");
});
await new Promise<void>((r) => node.listen(0, "127.0.0.1", () => r()));
process.env.CSD_RPC = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
process.env.CSD_RPC_BACKENDS = process.env.CSD_RPC;   // the mock only; never the host's nodes
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_storable";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_INDEX_CHECKPOINT_FLOOR = "0";

const { syncOnce, indexedHeight } = await import("../src/indexer.js");
const { store, resetStoreForTests, closeDb } = await import("../src/db.js");
const { bus } = await import("../src/events.js");
const { buildApp } = await import("../src/server.js");
const { storableText } = await import("../src/decode.js");

const api = buildApp().listen(0, "127.0.0.1");
await new Promise((r) => api.once("listening", r));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; };
const byTxid = <T extends { txid: string }>(xs: T[]) => [...xs].sort((a, b) => (a.txid < b.txid ? -1 : 1));
const rows = async () => byTxid(await store().all<{ txid: string; domain: string; uri: string; payload_hash: string }>(
  "SELECT txid, domain, uri, payload_hash FROM proposals"));

/** Index CHAIN from an empty store, collecting the proposal events the pass emits. */
async function indexChain(): Promise<{ domain: string; txid: string }[]> {
  await resetStoreForTests();
  const seen: { domain: string; txid: string }[] = [];
  const off = bus.onEvent((e) => { if (e.kind === "proposal") seen.push({ txid: e.txid, domain: e.domain }); });
  try { await syncOnce(); } finally { off(); }
  return byTxid(seen);
}

test("a Propose with U+0000 in its domain or uri: the tip advances and every read gives U+0001 in its place", async () => {
  const props: Prop[] = [
    { domain: "cairnx:v1", uri: CANON, payload_hash: hex(CANON) },
    { domain: `cairnx:v1${NUL}`, uri: CANON, payload_hash: hex(CANON) },
    { domain: "cairnx:v1", uri: `${CANON}${NUL}junk`, payload_hash: hex(CANON) },
    { domain: "csd:apps", uri: `{"a":"x${NUL}y${NUL}z"}`, payload_hash: hex("other") },
  ];
  CHAIN = chain("nul", props);
  const events = await indexChain();
  assert.equal(await indexedHeight(), 1, "the block holding the records is indexed");

  const want = byTxid(props.map((p, i) => ({
    txid: txidOf("nul", i), domain: p.domain.replaceAll(NUL, SOH), uri: p.uri.replaceAll(NUL, SOH), payload_hash: p.payload_hash,
  })));
  assert.deepEqual(await rows(), want, "the stored rows read back whole, U+0001 where the node had U+0000");
  assert.deepEqual(events, want.map(({ txid, domain }) => ({ txid, domain })), "the event bus carries the stored domain");

  const nulUri = await get(`/proposal/${txidOf("nul", 2)}`);
  assert.equal(nulUri.status, 200);
  assert.equal(nulUri.body.uri, `${CANON}${SOH}junk`, "the uri is served whole, not cut at the character");
  // The domain keeps its other characters, so `cairnx:v1` + U+0000 is not a cairnx:v1 record on any read.
  const byDomain = await get("/domain/cairnx:v1/proposals?from=0");
  assert.deepEqual(byDomain.body.map((p: { txid: string }) => p.txid).sort(), [txidOf("nul", 0), txidOf("nul", 2)].sort());
  const feed = await get("/proposals?domain=cairnx:v1");
  assert.deepEqual(feed.body.rows.map((p: { txid: string }) => p.txid).sort(), [txidOf("nul", 0), txidOf("nul", 2)].sort());
  const doms = await get("/domains");
  assert.deepEqual(doms.body, [
    { domain: "cairnx:v1", proposals: 2 }, { domain: "cairnx:v1" + SOH, proposals: 1 }, { domain: "csd:apps", proposals: 1 },
  ]);
});

test("HAPPY PATH: the same records without U+0000 are stored and served exactly as the node sent them", async () => {
  const props: Prop[] = [
    { domain: "cairnx:v1", uri: CANON, payload_hash: hex(CANON) },
    { domain: "cairnx:v1", uri: `${CANON}junk`, payload_hash: hex(CANON) },
    { domain: "csd:apps", uri: `{"a":"x${SOH}y\u001f\u007fé\u{1f600}"}`, payload_hash: hex("other") },
  ];
  CHAIN = chain("honest", props);
  const events = await indexChain();
  assert.equal(await indexedHeight(), 1);
  const want = byTxid(props.map((p, i) => ({ txid: txidOf("honest", i), ...p })));
  assert.deepEqual(await rows(), want, "byte for byte the node's strings");
  assert.deepEqual(events, want.map(({ txid, domain }) => ({ txid, domain })));
  const p0 = await get(`/proposal/${txidOf("honest", 0)}`);
  assert.equal(p0.body.uri, CANON);
  assert.equal(p0.body.domain, "cairnx:v1");
});

// Every JSON parser refuses U+0000 unescaped, in a string and between tokens, and so the node's form of these uris is
// no record under any JSON convention (cairnx-core's parseRecord starts with JSON.parse). The stored form must be refused
// as well, or a reader of the indexer would apply a record that every reader of node bytes refuses. A replacement that is
// legal in a JSON string (U+FFFD, a space, the text \u0000) turns the first shape into valid JSON.
test("a uri holding U+0000 is not JSON, and neither is its stored form", () => {
  const shapes = [
    `{"a":"x${NUL}y${NUL}z"}`,   // inside a string, twice
    `${CANON}${NUL}junk`,        // after a whole record
    `${CANON}${NUL}`,
    `${NUL}${CANON}`,
    `{"t":"x",${NUL}"v":1}`,     // between tokens, where whitespace is allowed
  ];
  for (const raw of shapes) {
    assert.throws(() => JSON.parse(raw), SyntaxError, `the node's form parses: ${JSON.stringify(raw)}`);
    const stored = storableText(raw);
    assert.equal(stored.includes(NUL), false);
    assert.equal(stored.length, raw.length, "one character for one");
    assert.throws(() => JSON.parse(stored), SyntaxError, `the stored form parses: ${JSON.stringify(stored)}`);
  }
  assert.equal(storableText(`cairnx:v1${NUL}`), `cairnx:v1${SOH}`, "a domain keeps its other characters");
});

test("HAPPY PATH: text without U+0000 is returned unchanged", () => {
  const honest = ["", "cairnx:v1", CANON, `x${SOH}y`, "\t\n\r\u001b[31m\u007f\u0085", "�é\u{1f600}", "\\u0000"];
  for (const s of honest) assert.equal(storableText(s), s);
});

test.after(async () => { node.close(); api.close(); await closeDb(); });
