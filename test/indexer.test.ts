// The heart of P3.0: offline, deterministic proof that the indexer's writes are
// correct AND that a reorg unwinds + replays to EXACTLY the canonical state — no
// orphaned spends, no leftover rows, address balances/history rolled back. Uses a
// throwaway temp DB and synthetic blocks (no node, no network).
//
// Backend-agnostic: runs on sqlite by default; set CSD_INDEX_PG (+ the per-file
// CSD_INDEX_PG_SCHEMA below) to run the IDENTICAL suite against Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { verifyMerkleProof, merkleRoot } from "@inversealtruism/csd-codec";

// isolate the DB BEFORE importing any module that reads config
const DB = `/tmp/csd-idx-test-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} }
process.env.CSD_INDEX_DB = DB;
process.env.CSD_INDEX_PG_SCHEMA = "t_indexer";
process.env.CSD_INDEX_FROM = "0";
process.env.CSD_CONFIRMATIONS_FINAL = "6";

const { writeBlock, unwindAbove, indexedHeight } = await import("../src/indexer.js");
const { store, setMeta, resetStoreForTests, closeDb } = await import("../src/db.js");
const { merkleProof } = await import("../src/merkle.js");
await resetStoreForTests();
test.after(async () => { await closeDb(); });

// ── synthetic chain builders ───────────────────────────────────────────────
let nonce = 0;
const txid = (tag: string) => "0x" + Buffer.from(tag.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0");
const spk = (a: string) => a.replace(/^0x/, "");
const sigFor = (pub: string) => "0x40" + "ab".repeat(64) + "21" + pub;

// a deterministic addr from a label (we don't need real hash160 for spend/UTXO logic;
// outputs carry the addr directly via script_pubkey, inputs resolve via our outputs table)
const ADDR_A = "0x" + "a1".repeat(20);
const ADDR_B = "0x" + "b2".repeat(20);

function mkBlock(height: number, prev: string, txs: any[]): any {
  const ids = txs.map((t) => t.txid);
  return {
    hash: "0x" + Buffer.from(`blk${height}_${nonce++}`.padEnd(32, "_")).toString("hex").slice(0, 64).padEnd(64, "0"),
    height,
    chainwork: String(height * 1000),
    header: { bits: 0x1e00ffff, merkle: merkleRoot(ids), nonce: nonce, prev, time: 1700000000 + height, version: 1 },
    txs,
  };
}
const coinbase = (tag: string, to: string, value = 5_000_000_000) => ({
  txid: txid(tag), version: 1, locktime: 0, inputs: [{}], outputs: [{ script_pubkey: spk(to), value }],
});

test("indexes a chain: blocks, coinbase outputs, address history", async () => {
  const cb0 = coinbase("cb0", ADDR_A);
  const b0 = mkBlock(0, "0x" + "00".repeat(32), [cb0]);
  await writeBlock(b0); await setMeta("indexed_height", "0");

  const cb1 = coinbase("cb1", ADDR_A);
  const b1 = mkBlock(1, b0.hash, [cb1]);
  await writeBlock(b1); await setMeta("indexed_height", "1");

  const blk0 = await store().get<any>("SELECT * FROM blocks WHERE height=0");
  assert.equal(blk0.hash, b0.hash);
  const outA = await store().get<any>("SELECT COUNT(*) n FROM outputs WHERE addr=?", ADDR_A);
  assert.equal(Number(outA.n), 2, "two coinbase outputs to A");
  const histA = await store().get<any>("SELECT COUNT(*) n FROM address_history WHERE addr=?", ADDR_A);
  assert.equal(Number(histA.n), 2);
});

test("a spend marks the prevout spent and records both sides in address_history", async () => {
  // block 2: a tx spends cb0 (A) → pays B; input resolves against our outputs table
  const pub = "02" + "cd".repeat(32);
  const transfer = {
    txid: txid("xferAB"), version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("cb0"), vout: 0, script_sig: sigFor(pub) }],
    outputs: [{ script_pubkey: spk(ADDR_B), value: 4_000_000_000 }],
  };
  const cb2 = coinbase("cb2", ADDR_A);
  const prev1 = (await store().get<any>("SELECT hash FROM blocks WHERE height=1"))!.hash;
  const b2 = mkBlock(2, prev1, [cb2, transfer]);
  await writeBlock(b2); await setMeta("indexed_height", "2");

  const cb0out = await store().get<any>("SELECT spent_txid, spent_height FROM outputs WHERE txid=? AND vout=0", txid("cb0"));
  assert.equal(cb0out.spent_txid, txid("xferAB"), "cb0 is now spent by the transfer");
  assert.equal(Number(cb0out.spent_height), 2);

  const bUtxo = await store().get<any>("SELECT COUNT(*) n FROM outputs WHERE addr=? AND spent_txid IS NULL", ADDR_B);
  assert.equal(Number(bUtxo.n), 1, "B has one unspent output");
  // A's history now includes the outgoing spend (direction 'out')
  const aOut = await store().get<any>("SELECT COUNT(*) n FROM address_history WHERE addr=? AND direction='out'", ADDR_A);
  assert.equal(Number(aOut.n), 1);
});

test("records Propose and Attest as full per-row events", async () => {
  const pub = "02" + "ef".repeat(32);
  const propose = {
    txid: txid("prop1"), version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("cb1"), vout: 0, script_sig: sigFor(pub) }],
    outputs: [{ script_pubkey: spk(ADDR_A), value: 4_900_000_000 }],
    app: { type: "Propose", domain: "test:domain", payload_hash: "0x" + "11".repeat(32), uri: "csd:v1:x", expires_epoch: 999 },
  };
  const cb3 = coinbase("cb3", ADDR_A);
  const prev2 = (await store().get<any>("SELECT hash FROM blocks WHERE height=2"))!.hash;
  const b3 = mkBlock(3, prev2, [cb3, propose]);
  await writeBlock(b3); await setMeta("indexed_height", "3");

  const attest = {
    txid: txid("att1"), version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("cb2"), vout: 0, script_sig: sigFor(pub) }],
    outputs: [{ script_pubkey: spk(ADDR_A), value: 4_900_000_000 }],
    app: { type: "Attest", proposal_id: txid("prop1"), score: 80, confidence: 90 },
  };
  const cb4 = coinbase("cb4", ADDR_A);
  const b4 = mkBlock(4, b3.hash, [cb4, attest]);
  await writeBlock(b4); await setMeta("indexed_height", "4");

  const p = await store().get<any>("SELECT * FROM proposals WHERE txid=?", txid("prop1"));
  assert.equal(p.domain, "test:domain");
  const atts = await store().all<any>("SELECT * FROM attestations WHERE proposal_id=?", txid("prop1"));
  assert.equal(atts.length, 1);
  assert.equal(Number(atts[0].score), 80);
});

test("merkle proof for an indexed tx verifies under the L0 convention", async () => {
  // block 3 has [cb3, prop1]; both proofs must fold to the stored header.merkle
  const blk = await store().get<any>("SELECT merkle FROM blocks WHERE height=3");
  for (const id of [txid("cb3"), txid("prop1")]) {
    const proof = (await merkleProof(id))!;
    assert.ok(proof, "proof exists");
    assert.equal(proof.block_height, 3);
    assert.ok(verifyMerkleProof(id, proof.pos, proof.merkle, blk.merkle), "proof folds to header.merkle");
  }
  assert.equal(await merkleProof("0x" + "99".repeat(32)), null, "unknown tx → null");
});

test("REORG: unwind orphaned blocks restores exact canonical state", async () => {
  // current tip = 4. Snapshot B's utxo + cb0 spend state.
  const beforeBUtxo = Number((await store().get<any>("SELECT COUNT(*) n FROM outputs WHERE addr=? AND spent_txid IS NULL", ADDR_B))!.n);
  assert.equal(beforeBUtxo, 1);

  // reorg back to ancestor=1: heights 2,3,4 are orphaned
  await unwindAbove(1); await setMeta("indexed_height", "1");

  // every row above height 1 is gone
  for (const t of ["blocks", "txs", "outputs", "proposals", "attestations", "address_history"]) {
    const n = Number((await store().get<any>(`SELECT COUNT(*) n FROM ${t} WHERE height>1`))!.n);
    assert.equal(n, 0, `${t} has no rows above the ancestor`);
  }
  // cb0 (height 0) must be UN-spent again — its spender (xferAB@2) was orphaned
  const cb0 = await store().get<any>("SELECT spent_txid, spent_height FROM outputs WHERE txid=? AND vout=0", txid("cb0"));
  assert.equal(cb0.spent_txid, null, "cb0 spend rolled back");
  assert.equal(cb0.spent_height, null);
  // B's output is gone entirely (it was created in the orphaned block 2)
  const bUtxo = Number((await store().get<any>("SELECT COUNT(*) n FROM outputs WHERE addr=?", ADDR_B))!.n);
  assert.equal(bUtxo, 0, "B's output removed with the orphaned block");
  // proposals/attestations from the orphaned branch are gone
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM proposals"))!.n), 0);
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM attestations"))!.n), 0);
  assert.equal(await indexedHeight(), 1);
});

test("REPLAY after reorg is idempotent and reaches a clean new tip", async () => {
  // replay a DIFFERENT branch from ancestor 1: block 2' spends cb1 (not cb0) → A
  const pub = "02" + "12".repeat(32);
  const prev1 = (await store().get<any>("SELECT hash FROM blocks WHERE height=1"))!.hash;
  const transfer2 = {
    txid: txid("xfer1A"), version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("cb1"), vout: 0, script_sig: sigFor(pub) }],
    outputs: [{ script_pubkey: spk(ADDR_A), value: 4_000_000_000 }],
  };
  const cb2b = coinbase("cb2b", ADDR_A);
  const b2b = mkBlock(2, prev1, [cb2b, transfer2]);
  await writeBlock(b2b); await setMeta("indexed_height", "2");
  // re-writing the same block must not double-count (idempotent upserts)
  await writeBlock(b2b);

  const cb1 = await store().get<any>("SELECT spent_txid FROM outputs WHERE txid=? AND vout=0", txid("cb1"));
  assert.equal(cb1.spent_txid, txid("xfer1A"), "cb1 now spent on the new branch");
  const nTx2 = Number((await store().get<any>("SELECT COUNT(*) n FROM txs WHERE height=2"))!.n);
  assert.equal(nTx2, 2, "exactly two txs at height 2 (no duplication from re-write)");
});

test("D-I2: re-writing a height with FEWER txs leaves no stale rows (writeBlock self-guard)", async () => {
  const H = 50;
  const pub = "02" + "cd".repeat(32);
  const propTxid = txid("di2-prop");
  const propose = {
    txid: propTxid, version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("cb1"), vout: 0, script_sig: sigFor(pub) }],
    outputs: [{ script_pubkey: spk(ADDR_B), value: 1_000_000 }],
    app: { type: "Propose", domain: "di2:domain", payload_hash: "0x" + "22".repeat(32), uri: "csd:v1:di2", expires_epoch: 123 },
  };
  // v1: height H = coinbase + a Propose
  await writeBlock(mkBlock(H, "0x" + "00".repeat(32), [coinbase("di2-cb", ADDR_A), propose]));
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM txs WHERE height=?", H))!.n), 2, "v1: 2 txs at height");
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM proposals WHERE txid=?", propTxid))!.n), 1, "v1: proposal present");

  // v2: SAME height, tx set SHRANK to just the coinbase — WITHOUT unwindAbove first (the D-I2 case)
  await writeBlock(mkBlock(H, "0x" + "00".repeat(32), [coinbase("di2-cb", ADDR_A)]));
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM txs WHERE height=?", H))!.n), 1, "stale tx removed → 1 tx");
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM proposals WHERE txid=?", propTxid))!.n), 0, "stale proposal removed");
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM outputs WHERE txid=?", propTxid))!.n), 0, "stale output removed");
  assert.equal(Number((await store().get<any>("SELECT COUNT(*) n FROM address_history WHERE txid=?", propTxid))!.n), 0, "stale address_history removed");
});

test("redteam F1: a fractional output value from a hostile/buggy node is floored, never a REAL that crashes analytics", async () => {
  const { supply, richlist } = await import("../src/analytics.js");
  // OLD bug: Number(1.5) stored as a sqlite REAL → SUM(value) returned a fractional, and BigInt(3.5)
  // threw RangeError → 500 on /analytics/supply, /analytics/richlist and /address chain-wide. The fix
  // floors output values to a non-negative integer at ingest.
  const fracCb = {
    txid: txid("fracCb"), version: 1, locktime: 0, inputs: [{}],
    outputs: [{ script_pubkey: spk(ADDR_A), value: 1.5 }],
  };
  await writeBlock(mkBlock(9000, "0x" + "00".repeat(32), [fracCb]));
  const o = await store().get<any>("SELECT value FROM outputs WHERE txid=?", txid("fracCb"));
  assert.equal(Number(o.value), 1, "fractional 1.5 floored to integer 1");
  assert.ok(Number.isInteger(Number(o.value)), "stored value is an integer, not a REAL");
  // the analytics SUMs that crashed before now succeed (no BigInt(REAL) RangeError)
  await assert.doesNotReject(() => supply() as Promise<unknown>, "supply() no longer throws on a once-fractional value");
  await assert.doesNotReject(() => richlist() as Promise<unknown>, "richlist() no longer throws");
});

test("redteam F2: merkleProof returns the CONSENSUS header root, so a lying node's proof fails to fold (not trusted)", async () => {
  // honest block (header.merkle == merkleRoot(txids)): the proof folds AND merkle_root == header root
  const cbA = coinbase("f2cbA", ADDR_A);
  const cbB = coinbase("f2cbB", ADDR_B);
  const honest = mkBlock(9100, "0x" + "00".repeat(32), [cbA, cbB]);
  await writeBlock(honest);
  const pH = (await merkleProof(cbB.txid))!;
  assert.equal(pH.merkle_root, honest.header.merkle, "served merkle_root == the block's header merkle");
  assert.ok(verifyMerkleProof(cbB.txid, pH.pos, pH.merkle, pH.merkle_root), "honest proof folds to the header root");

  // hostile block: header.merkle is a LIE (≠ merkleRoot(txids)). Pre-fix, merkleProof recomputed a
  // SELF-CONSISTENT root, so a consumer trusting merkle_root accepted a proof for a block whose real
  // root the node lied about. Post-fix, merkleProof returns the (lying) header root, so the branch —
  // built from the real txids — folds to merkleRoot(txids) ≠ that root → verification FAILS.
  const cbC = coinbase("f2cbC", ADDR_A);
  const cbD = coinbase("f2cbD", ADDR_B);
  const liar = mkBlock(9101, "0x" + "00".repeat(32), [cbC, cbD]);
  liar.header.merkle = "0x" + "fa".repeat(32); // the node lies about its own merkle root
  await writeBlock(liar);
  const pL = (await merkleProof(cbD.txid))!;
  assert.equal(pL.merkle_root, "0x" + "fa".repeat(32), "served root is the (lying) header root, not a self-recomputed one");
  assert.ok(!verifyMerkleProof(cbD.txid, pL.pos, pL.merkle, pL.merkle_root), "a lying header's proof does NOT fold → consumer rejects it");
  // the branch itself is honest — it folds to the REAL tx-list root; the header is the lie the
  // consumer now detects (instead of being handed a self-consistent root that hid the lie).
  assert.ok(verifyMerkleProof(cbD.txid, pL.pos, pL.merkle, merkleRoot([cbC.txid, cbD.txid])), "branch folds to the real tx-list root");
});

test("GRX-WIRE-CLAMP-1: an over-2^53 consensus expires_epoch is stored as a NON-safe sentinel (fork-guard fires identically on Granus and SPV) AND never overflows the BIGINT bind (no indexer wedge)", async () => {
  // Two failure modes safeEpoch() must avoid: (1) clampInt's old bug — saturating >2^53 to a SAFE int (2^53-1)
  // made Granus ACCEPT what an SPV replayer reading the raw u64 REJECTS via Number.isSafeInteger → canonicalState
  // fork (un-masked once V22 removes the cap); (2) preserving the raw bigint unbounded — a u64 >= 2^63 overflows
  // the signed-64-bit BIGINT bind, throws in writeBlock, and permanently wedges the indexer. safeEpoch clamps
  // anything > MAX_SAFE_INTEGER to a non-safe sentinel that the resolver rejects identically AND that fits int64.
  const big = (1n << 53n) + 1n; // 2^53 + 1 — NOT a JS safe integer
  const propTxid = txid("clamp-prop");
  const propose = {
    txid: propTxid, version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("clamp-cb"), vout: 0, script_sig: sigFor("02" + "cd".repeat(32)) }],
    outputs: [{ script_pubkey: spk(ADDR_B), value: 1_000_000 }],
    app: { type: "Propose", domain: "clamp:domain", payload_hash: "0x" + "33".repeat(32), uri: "csd:v1:clamp", expires_epoch: big.toString() },
  };
  await writeBlock(mkBlock(9200, "0x" + "00".repeat(32), [coinbase("clamp-cb", ADDR_A), propose]));
  const row = (await store().get<{ expires_epoch: number | bigint }>("SELECT expires_epoch FROM proposals WHERE txid=?", propTxid))!;
  // stored value is > MAX_SAFE_INTEGER (so the fork-guard fires) but NOT the old saturated 2^53-1, and fits int64
  assert.ok(BigInt(row.expires_epoch) > BigInt(Number.MAX_SAFE_INTEGER), "stored value stays > MAX_SAFE_INTEGER (not saturated to a safe int)");
  assert.ok(BigInt(row.expires_epoch) <= (1n << 63n) - 1n, "stored value fits a signed-64-bit column (no overflow)");
  assert.ok(!Number.isSafeInteger(Number(row.expires_epoch)), "Granus read path Number(expires_epoch) is NOT a safe integer → resolver rejects, matching an SPV replayer reading the raw u64 → no fork");

  // V22-IDX-OVERFLOW-1: a raw u64 up to 2^64-1 must NOT overflow the BIGINT bind / throw / wedge the indexer
  const u64max = (1n << 64n) - 1n; // 18446744073709551615 — would have thrown ERR_INVALID_ARG_VALUE if stored raw
  const ovTxid = txid("clamp-ov");
  const ovProp = {
    txid: ovTxid, version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("clamp-cb-ov"), vout: 0, script_sig: sigFor("02" + "cf".repeat(32)) }],
    outputs: [{ script_pubkey: spk(ADDR_B), value: 1_000_000 }],
    app: { type: "Propose", domain: "clamp:domain", payload_hash: "0x" + "55".repeat(32), uri: "csd:v1:clampov", expires_epoch: u64max.toString() },
  };
  await assert.doesNotReject(() => writeBlock(mkBlock(9202, "0x" + "00".repeat(32), [coinbase("clamp-cb-ov", ADDR_A), ovProp])), "a 2^64-1 expires_epoch must not overflow the BIGINT bind (no indexer wedge)");
  const ovRow = (await store().get<{ expires_epoch: number | bigint }>("SELECT expires_epoch FROM proposals WHERE txid=?", ovTxid))!;
  assert.ok(BigInt(ovRow.expires_epoch) <= (1n << 63n) - 1n, "2^64-1 clamped to fit int64");
  assert.ok(!Number.isSafeInteger(Number(ovRow.expires_epoch)), "2^64-1 reads back non-safe → resolver rejects");

  // behavior-preserving control: a normal (<2^53) epoch is unchanged and stays a safe integer (accepted)
  const okTxid = txid("clamp-ok");
  const okProp = {
    txid: okTxid, version: 1, locktime: 0,
    inputs: [{ prev_txid: txid("clamp-cb2"), vout: 0, script_sig: sigFor("02" + "ce".repeat(32)) }],
    outputs: [{ script_pubkey: spk(ADDR_B), value: 1_000_000 }],
    app: { type: "Propose", domain: "clamp:domain", payload_hash: "0x" + "44".repeat(32), uri: "csd:v1:clampok", expires_epoch: 9826 },
  };
  await writeBlock(mkBlock(9201, "0x" + "00".repeat(32), [coinbase("clamp-cb2", ADDR_A), okProp]));
  const okRow = (await store().get<{ expires_epoch: number | bigint }>("SELECT expires_epoch FROM proposals WHERE txid=?", okTxid))!;
  assert.equal(Number(okRow.expires_epoch), 9826, "a normal epoch is stored unchanged");
  assert.ok(Number.isSafeInteger(Number(okRow.expires_epoch)), "normal epoch reads back as a safe integer (accepted)");
});
