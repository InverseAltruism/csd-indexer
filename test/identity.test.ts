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
// The SSRF guard pins gist proofs to GitHub hosts, so the mock uses a real gist origin as the
// placeholder and the injected fetch rewrites it to the local mock server (host-allow passes,
// the bytes come from the mock). Real network is never touched.
const GIST = "https://gist.githubusercontent.com";
const f: typeof fetch = (u: any, init?: any) => fetch(String(u).replace(GIST, BASE), init);

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
  const r = revealWith([{ type: "github-gist", url: `${GIST}/good` }]);
  const st = await proofStatuses(r, f);
  assert.equal(st[0]?.ok, true, "gist asserting the address verifies");
});

test("a lost (404) external proof un-verifies", async () => {
  const r = revealWith([{ type: "github-gist", url: `${GIST}/lost` }]);
  const st = await proofStatuses(r, f);
  assert.equal(st[0]?.ok, false, "404 → not live");
  assert.equal(await externallyLive(r, f), false, "no live proof → not externally live");
});

// SSRF guard: attacker-chosen proof URLs must not be able to reach internal services. The mock
// fetch below would 200 on ANY url, so an `ok:true` here means the guard FAILED to block it.
test("SSRF: a gist proof on a non-GitHub host is rejected (not fetched)", async () => {
  const ssrfFetch: typeof fetch = async () => new Response(JSON.stringify({ handle, address: o.addr }), { status: 200 });
  for (const url of ["http://127.0.0.1:8790/good", "http://169.254.169.254/latest/meta-data", `${BASE}/good`, "https://evil.example.com/gist"]) {
    const r = revealWith([{ type: "github-gist", url }]);
    assert.equal((await proofStatuses(r, ssrfFetch))[0]?.ok, false, `gist URL ${url} must be rejected by the host allowlist`);
  }
});

test("SSRF: a dns proof pointing at a private/loopback/metadata host is rejected", async () => {
  const ssrfFetch: typeof fetch = async () => new Response(`address ${o.addr} handle ${handle}`, { status: 200 });
  for (const domain of ["127.0.0.1", "localhost", "169.254.169.254", "10.0.0.5", "192.168.1.1", "[::1]", "metadata.google.internal"]) {
    const r = revealWith([{ type: "dns", domain, path: "/.well-known/csd.json" }]);
    assert.equal((await proofStatuses(r, ssrfFetch))[0]?.ok, false, `dns proof to ${domain} must be rejected as private/internal`);
  }
});

test.after(() => host.close());
