// DUP-ANALYTICS lockstep: analytics.ts hand-encodes the emission curve (COIN/INITIAL_REWARD/HALVING_INTERVAL
// /MAX_HALVINGS/blockReward) that the pinned csd-codec ALSO exports. The re-verification proved they are
// byte-identical across all 64 eras (the Phase-1 "can diverge at edge eras" claim was REFUTED), so this is a
// drift GUARD, not a fork fix: it fails CI the instant the local copy stops matching the codec the indexer
// pins — closing the "looks complete, silently diverges" gap that nothing previously enforced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockReward, maxSupply } from "../src/analytics.js";
import * as codec from "@inversealtruism/csd-codec";

test("analytics blockReward == codec blockReward across all era boundaries", () => {
  for (let era = 0; era <= 65; era++) {
    const h = era * Number(codec.HALVING_INTERVAL);
    assert.equal(Number(blockReward(h)), codec.blockReward(h), `reward at era ${era} (h=${h})`);
    assert.equal(Number(blockReward(h + 1)), codec.blockReward(h + 1), `reward at era ${era} + 1`);
  }
});

test("analytics emission constants single-source-match codec", () => {
  assert.equal(Number(blockReward(0)), codec.INITIAL_REWARD, "INITIAL_REWARD (reward at era 0)");
  // maxSupply must equal a recompute from the CODEC constants — pins the COIN/HALVING/MAX_HALVINGS triple too.
  let s = 0n;
  for (let era = 0; era < Number(codec.MAX_HALVINGS); era++) {
    s += (BigInt(codec.INITIAL_REWARD) >> BigInt(era)) * BigInt(codec.HALVING_INTERVAL);
  }
  assert.equal(maxSupply(), s, "maxSupply matches a recompute from codec constants");
});
