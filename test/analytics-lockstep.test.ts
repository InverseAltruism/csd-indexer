// Emission ADOPTION pins (Plan 57 B8c). analytics.ts no longer hand-encodes the emission curve:
// blockReward/maxSupply ARE csd-codec's exact-bigint helpers, so the old local==codec lockstep
// comparison became a tautology. These pins hold the ADOPTED VALUES fixed at known heights and
// era edges instead: a codec bump that changed the schedule (an accidental consensus edit) fails
// CI in THIS repo, not just upstream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockReward, maxSupply } from "../src/analytics.js";
import * as codec from "@inversealtruism/csd-codec";

test("adopted emission values pinned at genesis + the first halving edge", () => {
  assert.equal(blockReward(0), 5_000_000_000n, "genesis reward = 50 CSD");
  assert.equal(blockReward(1_051_199), 5_000_000_000n, "last block of era 0");
  assert.equal(blockReward(1_051_200), 2_500_000_000n, "first block of era 1 (halved)");
  assert.equal(blockReward(2_102_400), 1_250_000_000n, "era 2");
});

test("adopted terminal-era values pinned (rewards end, supply is finite + exact)", () => {
  const lastEraStart = 63 * 1_051_200;
  assert.equal(blockReward(lastEraStart), 5_000_000_000n >> 63n, "era 63 reward (sub-base rounding floor)");
  assert.equal(blockReward(64 * 1_051_200), 0n, "era 64+: emission ends");
  assert.equal(maxSupply(), 10_511_999_988_436_800n, "max supply, exact base units");
});

test("adopted values still self-consistent with the codec constants they came from", () => {
  assert.equal(Number(blockReward(0)), codec.INITIAL_REWARD, "INITIAL_REWARD");
  assert.equal(codec.HALVING_INTERVAL, 1_051_200, "halving interval");
  assert.equal(codec.MAX_HALVINGS, 64, "era count");
  // number twin agrees at every era start (the display-path helper serves the same schedule)
  for (let era = 0; era <= 64; era++) {
    const h = era * codec.HALVING_INTERVAL;
    assert.equal(Number(blockReward(h)), codec.blockReward(h), `bigint/number twin at era ${era}`);
  }
});
