# Changelog

## 0.3.2

- `GET /blocks/at-or-after/:time`: the lowest-height block whose time is at or after `time`, with the tip height,
  over a new `blocks(time, height)` index (created at start on both backends).
- `GET /proposals` and `GET /attestations`: every proposal or attestation, or those of one domain, in chain order
  (height, then position in the block), paged under a snapshot block with a keyset cursor; a reorg at or below the
  snapshot answers 409. These are the reads cairn's chain scanner served (its Uplink tally and publisher, network
  figures and legacy projection).

## 0.3.1

- `@inversealtruism/csd-light` 0.1.21 to 0.1.24, `@inversealtruism/csd-crypto` 0.1.16 to 0.1.19 and
  `@inversealtruism/csd-codec` 0.1.16 to 0.1.18 (the codec both of them require; the install resolves one copy).
- The ROUTE-1 checks come from csd-light: `src/rpc.ts` drops its copy of `tipHeaderPowOk`, and its
  `contenderPlausible` reads the local anchor and passes the settings to csd-light's. Routing verdicts are unchanged.
- `addrFromScriptPubkey` comes from csd-crypto. For every script_pubkey the node writes (0x and 40 lowercase hex)
  the address is unchanged. A script_pubkey with surrounding whitespace now yields the address the node's own
  parser reads, where it yielded none; a non-string one yields none, where it threw while the block was written.

## 0.3.0

Removed, since the content swarm they served is gone (owner decision P-5, 2026-10-13):

- `GET /registry/peers`, `/registry/gateways`, `/identity/:handle`, `/address/:a/identity` and `/content/0x<hash>`,
  with `src/registry.ts`, `src/identity.ts` and the `CSD_SWARM_GATEWAY` setting. Those routes now answer 404.
- The `@inversealtruism/csd-registry` dependency.

## 0.2.13

Dependency changes only; no source change.

- `@inversealtruism/csd-light` 0.1.19 to 0.1.21.
- `@inversealtruism/csd-crypto` 0.1.15 to 0.1.16 and `@inversealtruism/csd-registry` 0.1.17 to 0.1.18, so the install resolves a single `csd-codec` (0.1.16) and a single `csd-crypto` (0.1.16). Before this, `csd-crypto` 0.1.15 carried its own nested `csd-codec` 0.1.15 next to the top-level 0.1.16.
- Security patches within existing ranges: `express` 4.22.3 with `proxy-addr` 2.0.8 (GHSA-jqcg-44mw-7w3h; not
  reachable here, the indexer sets no `trust proxy`), `qs` 6.16.0 (GHSA-4mjr-xmp4-gh2g, GHSA-x5fp-wj9c-mxmx),
  `body-parser` 1.20.8, `esbuild` 0.28.2. `npm audit` reports 0 vulnerabilities.
