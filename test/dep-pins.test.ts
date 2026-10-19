// Every devDependency is an exact version, and package-lock.json records that same string for the root and installs
// that version. A range lets a lockfile refresh move the type checker or a type package without a package.json diff.
// The runtime dependency ranges are outside the pin check: the csd-* pins have their own CI step, and the express, pg, tsx
// and ws ranges change what the live service runs, so they move with a deploy, not with a tooling change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Lock = { packages: Record<string, { version?: string; devDependencies?: Record<string, string> }> };
type Manifest = { devDependencies?: Record<string, string> };

const EXACT = /^\d+\.\d+\.\d+$/;
const pkg: Manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock: Lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

/** One line per offence: a range, a lockfile root specifier that differs, or an installed version that differs. */
export function devPinOffences(p: Manifest, l: Lock): string[] {
  const out: string[] = [];
  const rootSpecs = l.packages[""]?.devDependencies ?? {};
  for (const [name, spec] of Object.entries(p.devDependencies ?? {})) {
    if (!EXACT.test(spec)) out.push(`${name}: "${spec}" is not an exact version`);
    if (rootSpecs[name] !== spec) out.push(`${name}: the lockfile specifier is "${rootSpecs[name]}"`);
    const installed = l.packages[`node_modules/${name}`]?.version;
    if (installed !== spec) out.push(`${name}: the lockfile installs ${installed}`);
  }
  return out;
}

test("package.json pins every devDependency to the version package-lock.json installs", () => {
  assert.ok(Object.keys(pkg.devDependencies ?? {}).length > 0);
  assert.deepEqual(devPinOffences(pkg, lock), []);
});

test("a caret range on a devDependency is an offence", () => {
  const caret = { devDependencies: { ...pkg.devDependencies, typescript: `^${pkg.devDependencies?.typescript}` } };
  assert.ok(devPinOffences(caret, lock).some((l) => l.startsWith("typescript:") && l.includes("not an exact version")));
});

test("a lockfile still carrying the old range as its root specifier is an offence", () => {
  const stale = structuredClone(lock);
  stale.packages[""]!.devDependencies!["@types/node"] = "^22.10.0";
  assert.ok(devPinOffences(pkg, stale).includes('@types/node: the lockfile specifier is "^22.10.0"'));
});

test("a lockfile that installs another version is an offence", () => {
  const drift = structuredClone(lock);
  drift.packages["node_modules/@types/ws"]!.version = "8.0.0";
  assert.ok(devPinOffences(pkg, drift).includes("@types/ws: the lockfile installs 8.0.0"));
});

// GHSA-g7r4-m6w7-qqqr (low; esbuild's dev server on Windows) affects esbuild >=0.27.3 <0.28.1. Here esbuild comes in
// through tsx, which runs the service and the tests.
test("every esbuild in package-lock.json is 0.28.1 or later", () => {
  const versions = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/esbuild$/.test(k)).map(([, v]) => v.version ?? "");
  assert.ok(versions.length > 0);
  for (const v of versions) {
    const [a, b, c] = v.split(".").map(Number);
    assert.ok(a! > 0 || b! > 28 || (b === 28 && c! >= 1), `esbuild ${v}`);
  }
});
