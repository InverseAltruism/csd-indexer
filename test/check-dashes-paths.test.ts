// scripts/check-dashes-paths.mjs on a throwaway git sandbox (one file per case) and on this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Check = {
  offences(root: string): string[];
  DASH_EXCEPTIONS: Record<string, string>;
  PATH_EXCEPTIONS: Record<string, string>;
  SIBLING: RegExp;
};
// A computed specifier: the script is plain .mjs outside tsconfig's include, so it is typed here.
const { offences, DASH_EXCEPTIONS, PATH_EXCEPTIONS, SIBLING }: Check = await import(new URL("../scripts/check-dashes-paths.mjs", import.meta.url).href);

const root = fileURLToPath(new URL("..", import.meta.url));
const EM = "—";

test("this repo is clean", () => assert.deepEqual(offences(root), []));

test("every exception names its reason and is a file the check would otherwise report", () => {
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  for (const [f, r] of Object.entries({ ...DASH_EXCEPTIONS, ...PATH_EXCEPTIONS })) assert.ok(r.length > 10, f);
  for (const f of Object.keys(DASH_EXCEPTIONS)) assert.ok(read(f).includes(EM), `stale: ${f}`);
  for (const f of Object.keys(PATH_EXCEPTIONS)) assert.ok(SIBLING.test(read(f)), `stale: ${f}`);
});

test("on a sandbox, only the tracked offences outside the exceptions are reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "csdidx-dashes-"));
  try {
    const put = (f: string, text: string, track = true) => {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
      if (track) execFileSync("git", ["add", f], { cwd: dir });
    };
    execFileSync("git", ["init", "-q"], { cwd: dir });
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
