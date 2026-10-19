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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointDefault } from "../src/config.js";

// The floor an unset knob falls back to, from config.ts's own reader (the shared file when present, else 38142).
const SHARED_DEFAULT = checkpointDefault();

test("checkpointDefault: the positive number in the given file, else 38142", () => {
  const dir = mkdtempSync(join(tmpdir(), "csdidx-ckpt-"));
  try {
    const file = (text: string) => { const f = join(dir, "spv-checkpoint"); writeFileSync(f, text); return f; };
    assert.equal(checkpointDefault(file("45000\n")), 45000);
    for (const bad of ["", "0", "-1", "abc", "Infinity"]) assert.equal(checkpointDefault(file(bad)), 38142, JSON.stringify(bad));
    assert.equal(checkpointDefault(join(dir, "absent")), 38142, "an absent file falls back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Probed = {
  checkpointFloor: number; scanFrom: number; finalDepth: number; pollSecs: number; maxAheadBlocks: number;
  routePlausibility: boolean; workEscapeCycles: number; powVerifyTimeoutMs: number; routeBlockSecs: number;
  maxSse: number; maxWs: number; maxSubKeys: number; maxSseBuffer: number;
};
function probe(env: Record<string, string | undefined>): Probed {
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

// The rpc.ts and stream.ts knobs are parsed here like every other knob. Before, each call site parsed its
// own: a garbage CSD_RPC_BLOCK_SECS became NaN and switched the route delta cap off (`claimed > NaN` is
// false), and a garbage CSD_INDEX_MAX_SSE or CSD_INDEX_MAX_SSE_BUFFER removed that bound the same way.
const RPC_STREAM_KEYS = {
  CSD_RPC_WORK_ESCAPE: "workEscapeCycles", CSD_RPC_POW_TIMEOUT: "powVerifyTimeoutMs", CSD_RPC_BLOCK_SECS: "routeBlockSecs",
  CSD_INDEX_MAX_SSE: "maxSse", CSD_INDEX_MAX_WS: "maxWs", CSD_INDEX_MAX_SUB: "maxSubKeys", CSD_INDEX_MAX_SSE_BUFFER: "maxSseBuffer",
} as const;
const RPC_STREAM_DEFAULTS = { workEscapeCycles: 20, powVerifyTimeoutMs: 5000, routeBlockSecs: 120, maxSse: 500, maxWs: 500, maxSubKeys: 1000, maxSseBuffer: 4 * 1024 * 1024 };

test("HAPPY PATH: the rpc and stream knobs default as their call sites did, and the plausibility gate is on", async () => {
  const c = probe({});
  for (const [k, d] of Object.entries(RPC_STREAM_DEFAULTS)) assert.equal(c[k as keyof Probed], d, k);
  assert.equal(c.routePlausibility, true);
});

test("HAPPY PATH: a legitimate positive override of each rpc and stream knob is honored", async () => {
  const env: Record<string, string> = {};
  Object.keys(RPC_STREAM_KEYS).forEach((k, i) => { env[k] = String(7 + i); });
  const c = probe(env);
  Object.entries(RPC_STREAM_KEYS).forEach(([k, f], i) => assert.equal(c[f], 7 + i, k));
});

test("a garbage, empty, zero or negative rpc or stream knob falls back to its default", async () => {
  for (const bad of ["abc", "", "0", "-3"]) {
    const env: Record<string, string> = {};
    for (const k of Object.keys(RPC_STREAM_KEYS)) env[k] = bad;
    const c = probe(env);
    for (const [k, f] of Object.entries(RPC_STREAM_KEYS)) assert.equal(c[f], RPC_STREAM_DEFAULTS[f], `${k}=${JSON.stringify(bad)}`);
  }
});

test("CSD_RPC_ROUTE_PLAUSIBILITY: only 0 turns the gate off", async () => {
  assert.equal(probe({ CSD_RPC_ROUTE_PLAUSIBILITY: "0" }).routePlausibility, false);
  assert.equal(probe({ CSD_RPC_ROUTE_PLAUSIBILITY: "1" }).routePlausibility, true);
  assert.equal(probe({ CSD_RPC_ROUTE_PLAUSIBILITY: "" }).routePlausibility, true);
});
