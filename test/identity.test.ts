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

// CAIRN-SSRF-IDENT-1: the IPv6 deny-list previously missed several reserved ranges. A dns proof
// targeting any of these (or their v4-mapped forms) must be rejected BEFORE any network call.
test("SSRF: reserved IPv6 ranges (NAT64/site-local/6to4/multicast/ULA/link-local/mapped) are rejected", async () => {
  const ssrfFetch: typeof fetch = async () => new Response(`address ${o.addr} handle ${handle}`, { status: 200 });
  const reserved = [
    "[::1]",                       // loopback
    "[::]",                        // unspecified
    "[fc00::1]", "[fd12:3456::1]", // ULA fc00::/7
    "[fe80::1]",                   // link-local
    "[fec0::1]",                   // deprecated site-local fec0::/10
    "[ff02::1]", "[ff00::1]",      // multicast ff00::/8
    "[2002:c0a8:0101::1]",         // 6to4 2002::/16
    "[64:ff9b::7f00:1]",           // NAT64 64:ff9b::/96 wrapping 127.0.0.1
    "[::ffff:127.0.0.1]",          // v4-mapped loopback
    "[::ffff:169.254.169.254]",    // v4-mapped cloud metadata
    "[::ffff:10.0.0.1]",           // v4-mapped private
    "[::ffff:192.168.0.1]",        // v4-mapped private
  ];
  for (const domain of reserved) {
    const r = revealWith([{ type: "dns", domain, path: "/.well-known/csd.json" }]);
    assert.equal((await proofStatuses(r, ssrfFetch))[0]?.ok, false, `dns proof to ${domain} must be rejected as reserved IPv6`);
  }
});

// Guardrail: a normal PUBLIC IPv6 literal must NOT be over-blocked (the deny-list is precise).
test("SSRF: a public IPv6 literal is not over-blocked by the reserved-range check", async () => {
  // 2606:4700:4700::1111 is Cloudflare's public resolver — global unicast, not reserved. The mock
  // fetch asserts the address so an ok:true proves the host check let it THROUGH (we don't hit the
  // real network — the injected fetch is the boundary).
  const okFetch: typeof fetch = async () => new Response(`address ${o.addr} handle ${handle}`, { status: 200 });
  const r = revealWith([{ type: "dns", domain: "[2606:4700:4700::1111]", path: "/.well-known/csd.json" }]);
  assert.equal((await proofStatuses(r, okFetch))[0]?.ok, true, "a public global-unicast IPv6 literal must pass the SSRF host check");
});

test.after(() => host.close());
