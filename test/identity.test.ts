// L3 identity external-proof workers: a DNS/.well-known or gist proof passes only while
// the external resource currently asserts the address (NIP-05 liveness), the signed proof
// always counts, and a 404/lost resource un-verifies. Mock proof host — no real network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { keygen } from "@inversealtruism/csd-crypto";
import { buildIdentityReveal, type ChainRecord } from "@inversealtruism/csd-registry";
import { proofStatuses, externallyLive } from "../src/identity.js";

const o = keygen();
const handle = "alice";

// mock host: serves a gist that asserts the address, and a 404 for the "lost" path
const host = createServer((req, res) => {
  if ((req.url || "").includes("/good")) { res.end(JSON.stringify({ handle, address: o.addr })); return; }
  res.statusCode = 404; res.end("not found");
});
await new Promise<void>((r) => host.listen(0, "127.0.0.1", () => r()));
const BASE = `http://127.0.0.1:${(host.address() as any).port}`;
// our checker only does https for dns; use github-gist proof type which uses the url as-is
const f: typeof fetch = (u: any, init?: any) => fetch(String(u).replace("https://MOCK", BASE), init);

function revealWith(proofs: any[]): ChainRecord {
  const b = buildIdentityReveal({ priv: o.priv, handle, salt: "s", address: o.addr, proofs });
  return { domain: b.domain, proposalId: "0x" + "0".repeat(64), proposer: o.addr.toLowerCase(), payloadHash: b.payloadHash, fee: 25e6, height: 100, expiresEpoch: 0, content: b.content as any, attestations: [] };
}

test("signed proof always counts as live", async () => {
  const r = revealWith([{ type: "signed" }]);
  assert.equal((await proofStatuses(r, f))[0]?.ok, true);
  assert.equal(await externallyLive(r, f), true);
});

test("a gist proof that currently asserts the address is live", async () => {
  const r = revealWith([{ type: "github-gist", url: "https://MOCK/good" }]);
  const st = await proofStatuses(r, f);
  assert.equal(st[0]?.ok, true, "gist asserting the address verifies");
});

test("a lost (404) external proof un-verifies", async () => {
  const r = revealWith([{ type: "github-gist", url: "https://MOCK/lost" }]);
  const st = await proofStatuses(r, f);
  assert.equal(st[0]?.ok, false, "404 → not live");
  assert.equal(await externallyLive(r, f), false, "no live proof → not externally live");
});

test.after(() => host.close());
