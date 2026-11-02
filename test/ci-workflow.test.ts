// The CI workflow's security shape: the token is read-only, no checkout keeps credentials, every action is pinned to
// a full commit SHA, and the secret scan runs the pinned gitleaks with this repo's config over the full history
// including merge diffs (the default log shows no diff for a merge, so a secret added in a conflict resolution would
// go unscanned).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const lines = ci.split("\n");
const GITLEAKS_SHA256 = "ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d"; // 8.18.4 linux_x64, from the release's checksums file

/** The lines of the step that starts at `i`, up to the next step or job. */
function stepAt(i: number): string {
  const indent = lines[i]!.indexOf("-");
  const end = lines.findIndex((l, j) => j > i && l.trim() !== "" && l.search(/\S/) <= indent);
  return lines.slice(i, end < 0 ? undefined : end).join("\n");
}

test("the workflow token is read-only", () => {
  assert.match(ci, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(ci, /:\s*write\b/);
});

test("every checkout sets persist-credentials: false", () => {
  const checkouts = lines.flatMap((l, i) => (/uses: actions\/checkout@/.test(l) ? [i] : []));
  assert.equal(checkouts.length, 3);
  for (const i of checkouts) assert.match(stepAt(i), /persist-credentials: false/, `checkout at line ${i + 1}`);
});

test("every action is pinned to a full commit SHA", () => {
  const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});

test("the secret scan: pinned gitleaks, this repo's config, full history, merge diffs", () => {
  assert.ok(ci.includes("releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz"));
  assert.ok(ci.includes(GITLEAKS_SHA256), "gitleaks sha256");
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /gitleaks" detect [^\n]*-c \.gitleaks\.toml/);
  assert.match(ci, /--log-opts="[^"]*--full-history[^"]*--all[^"]*--diff-merges=first-parent[^"]*"/);
});

test("the sqlite job installs the pinned playwright-core's headless shell and requires the browser tests", () => {
  const job = ci.slice(ci.indexOf("\n  test:\n"), ci.indexOf("\n  test-postgres:\n"));
  assert.match(job, /run: npx playwright-core install --with-deps chromium-headless-shell\n/);
  const run = job.slice(job.indexOf("run: npm test"));
  assert.match(run, /^run: npm test\n\s+env: \{ EXPLORER_BROWSER_REQUIRED: "1" \}/);
  assert.ok(job.indexOf("playwright-core install") < job.indexOf("run: npm test"), "the browser is installed before the tests");
});

// The exact-pin step run as CI runs it (its `node -e` script in a directory holding the package.json), on this repo's
// package.json and on copies with one determinism dependency given a caret.
const pinScript = (() => {
  const i = lines.findIndex((l) => /- name: determinism deps exact-pinned/.test(l));
  const m = /node -e '([\s\S]*?)'\s*$/.exec(stepAt(i));
  assert.ok(m, "the exact-pin step runs a node -e script");
  return m[1]!;
})();
const runPin = (manifest: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "csd-idx-pin-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    return spawnSync(process.execPath, ["-e", pinScript], { cwd: dir, encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("the exact-pin step passes this package.json and fails a caret on csd-codec, csd-crypto or csd-light", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  const ok = runPin(pkg);
  assert.equal(ok.status, 0, ok.stderr);
  for (const name of ["@inversealtruism/csd-codec", "@inversealtruism/csd-crypto", "@inversealtruism/csd-light"]) {
    assert.ok(ok.stdout.includes(`${name} exact-pinned at ${pkg.dependencies[name]}`), `${name} is checked`);
    const floated = runPin({ ...pkg, dependencies: { ...pkg.dependencies, [name]: `^${pkg.dependencies[name]}` } });
    assert.equal(floated.status, 1, `a caret on ${name} fails the step`);
    assert.ok(floated.stderr.includes(`::error::${name} must be EXACT-pinned`), floated.stderr);
  }
});
