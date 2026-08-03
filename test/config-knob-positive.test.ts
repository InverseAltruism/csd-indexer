// I4 (O-7 / P74-37): a non-positive env knob must mean "unset", not "configured".
//
// config.ts's num() accepted any finite number, so CSD_INDEX_CHECKPOINT_FLOOR=-1 was truthy, survived the
// `|| checkpointDefault()` fallback, and became the live floor. The checkpoint-floor backstop compares
// `converged < CFG.checkpointFloor`, and converged never goes below scanFrom-1 (= -1 by default), so a
// floor of -1 is UNREACHABLE: the 2026-07-05 backstop was silently disabled while looking configured.
// Zero already fell through to the default via the same `||`; this makes every non-positive value do so.
//
// The knob is resolved once at module load, so the several env values are probed in child processes
// (test/_config-probe.ts) rather than by re-importing config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// the shared spv-checkpoint file is the documented default source; 38142 is the hard fallback
const SHARED_DEFAULT = (() => {
  try { const v = Number(readFileSync("/opt/cairn_substrate/cairn/deploy/spv-checkpoint", "utf8").trim()); return Number.isFinite(v) && v > 0 ? v : 38142; } catch { return 38142; }
})();

function probe(env: Record<string, string | undefined>): { checkpointFloor: number; scanFrom: number; finalDepth: number; pollSecs: number; maxAheadBlocks: number } {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CSD_")) e[k] = v;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  const r = spawnSync("node_modules/.bin/tsx", ["test/_config-probe.ts"], { env: e, encoding: "utf8" });
  assert.equal(r.status, 0, `config probe exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("I4: CSD_INDEX_CHECKPOINT_FLOOR=-1 no longer becomes the live floor", async () => {
  const c = probe({ CSD_INDEX_CHECKPOINT_FLOOR: "-1" });
  assert.equal(c.checkpointFloor, SHARED_DEFAULT, "a negative override falls back to the shared default, as an unset value does");
  assert.ok(c.checkpointFloor > 0, "the floor is a real positive height");
  assert.ok(c.checkpointFloor > c.scanFrom - 1,
    "a floor at or below scanFrom-1 is unreachable (converged never goes below scanFrom-1), i.e. silently disabled");
});

test("I4: the same rule holds for every other knob a typo could disable", async () => {
  const c = probe({ CSD_CONFIRMATIONS_FINAL: "-6", CSD_INDEX_POLL: "-15", CSD_RPC_MAX_AHEAD: "-128" });
  assert.equal(c.finalDepth, 6, "negative finalDepth falls back to the default reorg bound");
  assert.equal(c.pollSecs, 15, "negative poll interval falls back to the default");
  assert.equal(c.maxAheadBlocks, 128, "negative delta cap falls back to the default");
});

// ── PAIRED HAPPY-PATH: the legitimate shapes resolve exactly as they do today ──
test("HAPPY PATH: unset resolves to the shared default (the production shape)", async () => {
  const c = probe({});
  assert.equal(c.checkpointFloor, SHARED_DEFAULT);
  assert.equal(c.scanFrom, 0);
  assert.equal(c.finalDepth, 6);
  assert.equal(c.pollSecs, 15);
  assert.equal(c.maxAheadBlocks, 128);
});

test("HAPPY PATH: a legitimate positive override is honored unchanged", async () => {
  assert.equal(probe({ CSD_INDEX_CHECKPOINT_FLOOR: "38142" }).checkpointFloor, 38142);
  assert.equal(probe({ CSD_INDEX_CHECKPOINT_FLOOR: "3" }).checkpointFloor, 3, "the low floor the checkpoint-floor suite relies on");
  assert.equal(probe({ CSD_CONFIRMATIONS_FINAL: "12" }).finalDepth, 12);
});

test("HAPPY PATH: an empty string and zero still mean 'unset', exactly as before", async () => {
  assert.equal(probe({ CSD_INDEX_CHECKPOINT_FLOOR: "" }).checkpointFloor, SHARED_DEFAULT);
  assert.equal(probe({ CSD_INDEX_CHECKPOINT_FLOOR: "0" }).checkpointFloor, SHARED_DEFAULT);
  assert.equal(probe({ CSD_INDEX_FROM: "0" }).scanFrom, 0, "scanFrom's own default is 0, so an explicit 0 is a no-op");
});
