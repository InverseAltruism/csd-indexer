// biome.json enables exactly four rules: unused imports, focused tests and ts-ignore directives are errors, so
// `npm run lint` fails on them; empty blocks are a warning until the existing ones are fixed (`npm run lint` lists
// them). Every other rule and the formatter are off. Runs the real Biome binary on a throwaway git sandbox holding
// one violation of each rule plus code that the recommended preset would flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Diagnostic = { category?: string; severity: string; location?: { path?: string } };

const root = fileURLToPath(new URL("..", import.meta.url));
const biome = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
const lint = (dir: string, args: string[]) => spawnSync(process.execPath, [biome, ...args], { cwd: dir, encoding: "utf8" });

test("biome.json enables exactly the four rules with their severities", () => {
  const dir = mkdtempSync(join(tmpdir(), "csdidx-lint-"));
  try {
    copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "violations.ts"), [
      'import { x } from "./b";',
      "// @ts-ignore",
      "const y: number = 1;",
      "try { void y; } catch {}",
      'test.only("t", () => 1);',
      "",
    ].join("\n"));
    writeFileSync(join(dir, "other.ts"), "var z = 1; if (z == 2) { debugger; }\nexport   const   w=z;\n");
    writeFileSync(join(dir, "clean.ts"), 'import { x } from "./b";\ntry { void x; } catch { /* reason */ }\nexport {};\n');

    const run = lint(dir, ["lint", "--reporter=json", "--max-diagnostics=none", "."]);
    const diagnostics: Diagnostic[] = JSON.parse(run.stdout).diagnostics;
    const found = diagnostics.filter((d) => d.category?.startsWith("lint/")).map((d) => `${d.location?.path}|${d.category}|${d.severity}`).sort();
    assert.deepEqual(found, [
      "violations.ts|lint/correctness/noUnusedImports|error",
      "violations.ts|lint/suspicious/noEmptyBlockStatements|warning",
      "violations.ts|lint/suspicious/noFocusedTests|error",
      "violations.ts|lint/suspicious/noTsIgnore|error",
    ]);
    assert.equal(run.status, 1, "an error-level finding fails the run");
    assert.deepEqual(diagnostics.filter((d) => d.location?.path === "biome.json"), [], "no deprecated or unknown config key");

    rmSync(join(dir, "violations.ts"));
    const check = lint(dir, ["check", "."]);
    assert.equal(check.status, 0, `biome check (lint, formatter, assist) passes var, ==, debugger, unformatted code and a catch with its reason inside\n${check.stdout}${check.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
