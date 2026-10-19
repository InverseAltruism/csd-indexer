// Every setting the README's table and the Dockerfile name is one src/config.ts reads, so neither documents a knob
// that no longer exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const config = read("src/config.ts");
const readByConfig = (k: string) => config.includes(`"${k}"`) || config.includes(`process.env.${k}`);

test("the README's settings table and the Dockerfile name only settings src/config.ts reads", () => {
  const readme = [...read("README.md").matchAll(/^\| `(CSD_[A-Z_]+)` \|/gm)].map((m) => m[1]!);
  const docker = [...read("Dockerfile").matchAll(/\b(CSD_[A-Z_]+)=/g)].map((m) => m[1]!);
  assert.ok(readme.length > 0 && docker.length > 0);
  assert.deepEqual([...readme, ...docker].filter((k) => !readByConfig(k)), []);
});
