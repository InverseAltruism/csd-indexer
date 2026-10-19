#!/usr/bin/env node
// Fails when a tracked .md outside docs/archive/ contains an em dash (U+2014), or when tracked code reads a
// sibling checkout (a parent-relative cairn* or csd-* directory, or the host's absolute checkout root). Docs may
// name those paths; only code is checked for them. The check sees literal paths, not ones computed at run time.
// This file is byte-identical in every repo that runs it; each repo's exceptions, with reasons, live in
// scripts/dashes-exceptions.json as {"dashes": {file: reason}, "paths": {file: reason}}.
// Run: node scripts/check-dashes-paths.mjs [repo root]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SIBLING = /\.\.\/(?:cairn[a-z-]*|csd-[a-z-]+)(?![\w.])|\/opt\/cairn_substrate\//;
const CODE = /\.(?:[cm]?js|[cm]?ts|tsx|sh|json|ya?ml|html)$/;

/** @param {unknown} v @returns {v is Record<string, string>} */
const isReasons = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((r) => typeof r === "string");

/** @param {string} root @returns {{ dashes: Record<string, string>, paths: Record<string, string> }} */
export function loadExceptions(root) {
  const file = join(root, "scripts/dashes-exceptions.json");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const keys = parsed && typeof parsed === "object" ? Object.keys(parsed).sort().join(",") : "";
  if (keys !== "dashes,paths" || !isReasons(parsed.dashes) || !isReasons(parsed.paths)) {
    throw new Error(`${file}: expected {"dashes": {file: reason}, "paths": {file: reason}}`);
  }
  return { dashes: parsed.dashes, paths: parsed.paths };
}

/** @param {string} root @returns {string[]} one line per offence */
export function offences(root) {
  const { dashes, paths } = loadExceptions(root);
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  for (const f of files) {
    const isDoc = f.endsWith(".md") && !f.startsWith("docs/archive/") && !(f in dashes);
    const isCode = CODE.test(f) && !(f in paths);
    if (!isDoc && !isCode) continue;
    const text = readFileSync(join(root, f), "utf8");
    if (isDoc && text.includes("\u2014")) out.push(`${f}: em dash (U+2014)`);
    const sibling = isCode ? text.match(SIBLING) : null;
    if (sibling) out.push(`${f}: reads a sibling checkout (${sibling[0]})`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = offences(resolve(process.argv[2] ?? "."));
  for (const line of found) console.error(line);
  console.log(found.length === 0 ? "check-dashes-paths: clean" : `check-dashes-paths: ${found.length} offence(s)`);
  process.exit(found.length === 0 ? 0 : 1);
}
