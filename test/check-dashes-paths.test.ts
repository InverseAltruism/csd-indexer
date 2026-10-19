// scripts/check-dashes-paths.mjs (the shared script, byte-identical across repos) on a throwaway git sandbox (one
// file per case), on this repo, and on scripts/dashes-exceptions.json (this repo's exceptions with their reasons).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Reasons = Record<string, string>;
type Check = {
  offences(root: string): string[];
  loadExceptions(root: string): { dashes: Reasons; paths: Reasons };
  SIBLING: RegExp;
};
// A computed specifier: the script is plain .mjs outside tsconfig's include, so it is typed here.
const { offences, loadExceptions, SIBLING }: Check = await import(new URL("../scripts/check-dashes-paths.mjs", import.meta.url).href);

const root = fileURLToPath(new URL("..", import.meta.url));
const EM = "—";
const read = (f: string) => readFileSync(join(root, f), "utf8");

test("this repo is clean", () => assert.deepEqual(offences(root), []));

test("every exception names its reason and is a file the check would otherwise report", () => {
  const { dashes, paths } = loadExceptions(root);
  for (const [f, r] of Object.entries({ ...dashes, ...paths })) assert.ok(r.length > 10, f);
  for (const f of Object.keys(dashes)) assert.ok(read(f).includes(EM), `stale: ${f}`);
  for (const f of Object.keys(paths)) assert.ok(SIBLING.test(read(f)), `stale: ${f}`);
});

test("on a sandbox, only the tracked offences outside the exceptions are reported; a malformed exceptions file is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "csdidx-dashes-"));
  try {
    const put = (f: string, text: string, track = true) => {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
      if (track) execFileSync("git", ["add", f], { cwd: dir });
    };
    execFileSync("git", ["init", "-q"], { cwd: dir });
    put("scripts/dashes-exceptions.json", read("scripts/dashes-exceptions.json"));
    put("README.md", `a ${EM} b\n`);
    put("docs/archive/old.md", `a ${EM} b\n`);
    put("notes.txt", `a ${EM} b\n`);
    put("untracked.md", `a ${EM} b\n`, false);
    put("docs/guide.md", "load ../cairn-wallet/dist and /opt/cairn_substrate/csd-sdk\n");
    put("src/reads-sdk.mjs", 'const d = process.env.X ?? "../csd-sdk/packages";\n');
    put("src/reads-host.ts", 'import x from "/opt/cairn_substrate/cairn/public/a.js";\n');
    put("tools/run.sh", 'cd "${DIR:-../cairnx}"\n');
    put("src/local.ts", 'import { a } from "../cairnx.js";\nimport { b } from "../csd-local.ts";\n');
    put("src/config.ts", 'readFileSync("/opt/cairn_substrate/cairn/deploy/spv-checkpoint");\n');
    const found = offences(dir);
    assert.deepEqual(found.map((l) => l.split(":")[0]).sort(), ["README.md", "src/reads-host.ts", "src/reads-sdk.mjs", "tools/run.sh"]);
    assert.ok(found.includes("README.md: em dash (U+2014)"));
    assert.ok(found.includes("src/reads-sdk.mjs: reads a sibling checkout (../csd-sdk)"));

    const refused = (text: string) => {
      put("scripts/dashes-exceptions.json", text);
      assert.throws(() => offences(dir), text);
    };
    refused('{"dashes": {}}');
    refused('{"dashes": {}, "paths": {}, "docs": {}}');
    refused('{"dashes": {"README.md": true}, "paths": {}}');
    refused('{"dashes": ["README.md"], "paths": {}}');
    put("scripts/dashes-exceptions.json", '{"dashes": {"README.md": "a sandbox exception"}, "paths": {}}');
    assert.ok(!offences(dir).some((l) => l.startsWith("README.md")), "a well-formed exceptions file is read from the checked root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
