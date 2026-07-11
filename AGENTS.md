# csd-indexer

> Onboarding briefing for coding agents and human contributors. AGENTS.md is the canonical briefing; CLAUDE.md imports it, so edit AGENTS.md only. Production and operations specifics (hosts, service management, deployment cadence) are intentionally out of scope here and are maintained privately by the maintainers.

L2 of the CSD (Compute Substrate) stack: a standalone, reorg-safe chain indexer + block explorer + Esplora-style REST/streaming API. The CSD node's RPC is deliberately minimal; this service reads raw blocks into a relational DB and re-serves what the node omits: address history/balances/UTXOs, per-attester attestation data, merkle inclusion proofs for the L0 light client, L3 registry resolution, miner/holder/supply analytics, and a live SSE/WS event stream.

Trust model (README "Honest limits", enforced by design): the indexer is a convenient derived view, not an authority. Inclusion proofs are trustless (clients re-fold them against PoW headers); everything else is reproducible rather than signed. The audit story is "run your own indexer, get byte-identical rows".

Version 0.2.6. Not npm-published (`private: true`); it runs straight from source. Default listen address is 127.0.0.1:8793 (`CSD_INDEX_LISTEN`, documented in the README and Dockerfile). The maintainers run a production instance behind the public front door at https://cairn-substrate.com/explorer; deployment specifics are maintained privately.

## The stack around it

The chain is the only source of truth; every layer above is a deterministic replay of chain events, hardened "reject more, never accept different" so historical replays stay byte-identical. Trust is never laundered: every read carries an honest trust level and UI gates fail closed.

| Layer | Repo / component | Where |
|---|---|---|
| Chain node + miner | compute-substrate (Rust) | run your own; the node RPC is this indexer's sole source of truth |
| L0 SDK | csd-sdk (pnpm monorepo: csd-codec/crypto/tx/client/light/vectors/registry + cairnx-core) | npm @inversealtruism/* |
| L2 indexer | csd-indexer (this repo) | REST/SSE/WS API + explorer |
| Settlement resolver | cairnx (CairnX market: tokens, DvP, .csd names) | consumes this indexer's API |
| Web front door | cairn (board, wall, /names CNS, explorer proxy, faucet, docs) | https://cairn-substrate.com |
| Signer | cairn-wallet (Chrome MV3 extension) | Chrome Web Store + GitHub releases |
| SDK / CLI | cairn-sdk (dApp aggregator), cairn-cli | npm |
| Bridge | csd-bridge (CSD<->Base) | TESTNET-ONLY, NO-GO for mainnet |

The indexer binds 127.0.0.1 by default and is meant to sit behind a reverse proxy when exposed publicly; the maintainers' instance is served through the front door at https://cairn-substrate.com/explorer. Running additional independent indexer instances is encouraged: byte-identical replay is the audit story.

## Architecture

TypeScript, run directly via `tsx` (no build step, no native deps; `node:sqlite` needs Node >= 22). ~2,100 lines in `src/`:

- `src/cli.ts` - entry. `index` = one sync pass + exit (cron/CI); `run` = continuous poll loop AND API server in one process.
- `src/config.ts` - `CFG` from env. Key vars: `CSD_RPC` (default http://127.0.0.1:8789), `CSD_RPC_BACKENDS`, `CSD_INDEX_DB`, `CSD_INDEX_PG` (set => Postgres instead of sqlite), `CSD_INDEX_LISTEN` (127.0.0.1:8793), `CSD_SWARM_GATEWAY` (:8791), `CSD_CONFIRMATIONS_FINAL` (6), `CSD_INDEX_POLL` (15s), `CSD_STALE_SECS` (600), `CSD_INDEX_CHECKPOINT_FLOOR` (default read from the shared spv-checkpoint file whose path is baked into config.ts, hard fallback 38142), `CSD_INDEX_WORK_GUARD` (chainwork-guard kill switch, default on).
- `src/rpc.ts` - node RPC client (`/tip`, `/block/height/:h`) + multi-backend failover: `selectBackend()` picks the reachable backend with max cumulative chainwork; 3-block height hysteresis, sticky, plus work-escape (`CSD_RPC_WORK_ESCAPE`, 20 cycles) so hysteresis can't pin a same-height lower-chainwork fork. Default backend list [:8789, :8790, :8795] is auto-appended only when `CSD_RPC` is the default.
- `src/db.ts` - one async `Store` interface, two backends: `SqliteStore` (node:sqlite DatabaseSync, WAL) and `PgStore` (pg Pool, ?->$n translation, exact int8/NUMERIC parsers). Selected purely by `CFG.pg` (db.ts:274). Tables: blocks, txs, outputs, address_history, proposals, attestations, meta; every row carries `height` (the reorg invariant). Exact-integer policy: number within 2^53, bigint past it, never lossy.
- `src/indexer.ts` - the sync engine: `syncOnce()` (chainwork regression guard -> `reconcileTipWindow` -> forward scan), `writeBlock()` (one db tx per block, self-clearing per height), `unwindAbove()` (reorg undo), `findReorgAncestor()`. Anti-wedge parsers `safeValue`/`safeEpoch`/`clampInt`.
- `src/decode.ts` - signer addr from scriptSig (via @inversealtruism/csd-crypto), addr from p2pkh script_pubkey, tx classification (Coinbase/Propose/Attest/Transfer).
- `src/merkle.ts` - Electrum-format merkle proofs built with csd-codec's `merkleBranch` (the same function the L0 light client folds); returns the PoW-committed header root, never a self-recomputed one.
- `src/queries.ts` - read-side SQL; `amt()`/`jsonSafe()` bigint->JSON-safe serialization; `heightOk` guard.
- `src/analytics.ts` - /analytics/{miners,richlist,supply}; emission schedule single-sourced from csd-codec; `memoByTip` per-tip memoization.
- `src/registry.ts` + `src/identity.ts` - L3: feeds ChainRecords to @inversealtruism/csd-registry's pure resolvers; identity external-proof re-validation with a serious SSRF guard (private/loopback/metadata IPs blocked, pinned gist hosts, no redirects).
- `src/server.ts` - Express app, all routes; error wrapper `h()` never leaks pg DSN/SQL/paths.
- `src/stream.ts` + `src/events.ts` - event bus -> SSE firehoses + WS /ws; caps: 500 SSE, 500 WS, 1000 sub keys, 4MB per-conn outbound buffer.
- `public/explorer.html` - single self-contained SPA served at `/`; re-verifies merkle proofs in-browser (SubtleCrypto) and re-hashes proposal content against payload_hash. Served per-request from disk: edits go live without a restart. Carries the unified cairn nav: a `#site-header` placeholder filled by cairn's `/header.js` (only resolves through the /explorer proxy; hidden via `#site-header:empty` on a direct :8793 hit where it 404s).

Repo-root `csd-index.db{,-shm,-wal}` are gitignored stale dev artifacts (a real deployment keeps its data in its own db file or in Postgres). Keep binary/screenshot artifacts out of the repo (a stray set of `before-*.png` dev screenshots was removed 2026-07-11).

## Core flows

Block ingest (`syncOnce`): select backend -> chainwork regression guard -> `reconcileTipWindow()` -> forward scan from `indexedHeight()+1`, one `writeBlock` per height. `writeBlock` runs in a single db tx: clear any prior contents of that height, insert the block row (node-reported chainwork as TEXT), resolve inputs against the indexer's own outputs table (electrs model, zero extra RPC), write outputs/spends/address_history and Propose/Attest app rows. Events emit only near the tip; status tentative -> confirmed past finalDepth (6).

Reorg undo: two detectors. (a) `reconcileTipWindow` catches equal-/lower-height reorgs (chainwork-heavier but not taller, possible under LWMA) by walking down to the last converged hash; (b) `findReorgAncestor` catches taller-block-with-mismatched-prev. Both `unwindAbove(ancestor)`: DELETE above ancestor on every table, un-spend outputs whose spender was orphaned, reset tip meta, emit reorg event, replay forward. Never unwind on absence of evidence (null block from node aborts the pass); deep reorgs follow to the scan floor rather than throwing.

API: Esplora core (`/blocks/tip/height` 503s on empty index, `/block/:hash[/txids|/txs]`, `/tx/:id[/status]`, `/address/:a[/txs|/txs/chain/:last|/utxo]` with a (height,txid) keyset cursor), `/tx/:id/merkle-proof`, CSD extras (`/domains`, `/domain/:d/proposals`, `/proposal/:id[/attestations]` keyset-paginated - this is how the CairnX resolver fetches complete attestation lists, `/address/:a/reputation`, `/analytics/*`, `/registry/{peers,gateways}`, `/identity/:handle`, `/content/0x<hash>` self-certified sha256 + 4MB cap), `/health` (version, backend, indexed_height, chainwork, stale; memoized per tip). SSE `/stream/*`, WS `/ws`.

## Invariants and red lines

- Chainwork regression guard (2026-07-05 incident fix): never reconcile/unwind when the node presents LESS accumulated chainwork than the indexed tip; HOLD and keep serving last-good; fail closed when node chainwork is missing/unparseable. Strict `<` comparison. Kill switch `CSD_INDEX_WORK_GUARD=0`.
- Checkpoint floor 38142: never hard-unwind below the highest shipped SPV checkpoint. Single-sourced from the shared spv-checkpoint file (path in config.ts); guarded against empty env string.
- Never unwind on absence of evidence: only confirmed contiguous hash mismatch justifies an unwind.
- sqlite dbTx isolation invariant (db.ts, guarded by test/dbtx-isolation.test.ts): BEGIN..COMMIT atomicity vs HTTP readers holds only because every await inside a dbTx callback is a store call (microtask). Never add fetch/fs/timer awaits inside a dbTx callback.
- Exact-integer policy end to end: CSD max supply exceeds 2^53, so values parse as BigInt (`safeValue`), store as BIGINT, serialize via `amt()`/`jsonSafe()`. A stray bigint in a response object crashes JSON.stringify and 500s the endpoint.
- Anti-wedge clamps: `safeValue` clamps to int64 max (an over-range bind throws inside writeBlock -> rollback -> same block re-poisons every poll = permanent wedge). `safeEpoch` clamps >2^53 expires_epoch to a NON-safe-int sentinel; using `clampInt` there forked the live resolver vs SPV replay (GRX-WIRE-CLAMP-1). `clampInt` is only legal for app ints compared against small exact enums.
- Determinism deps exact-pinned, no carets (CI enforces): csd-codec 0.1.15, csd-crypto 0.1.15, csd-registry 0.1.16. A floated version is a determinism fork seam across the ecosystem.
- Error responses never leak internals; /content self-certifies bytes; identity fetches are SSRF-guarded.
- There is deliberately NO sqlite->pg copy tool: a fresh replay IS the integrity check.
- Never point anything at :8790 as the default RPC (that is the miner's RPC; :8789 is primary, :8790 is fallback only).

## How we work (contributor ground rules)

1. Maintainers deploy. Contributions and agent sessions must never assume deploy or restart access; this indexes a live financial system with real users and real CSD. Default to design-first: agree on the approach before editing shared behavior, keep diffs small and reviewed, and treat approval as scoped to the single change discussed.
2. Security fixes must not regress UX. Never add latency or a decline path to a legitimate hot path. Prefer warn over hard-block, fail-soft with an availability valve over hard fail-closed, removing a false UI claim over adding machinery. Decline disproportionate hardening explicitly, with reasoning.
3. No em dashes in READMEs or any user-facing doc; avoid AI-slop phrasing (excessive bolding, "not just X but Y", filler intensifiers). Search the doc for the em dash character before committing; the count must be zero.
4. Commit/push/tag only when asked. Investigations default to read-only.
5. Never weaken the replay discipline: hardening may reject MORE, it must never accept DIFFERENT, or historical replays fork.

## Dev workflow

```bash
cd csd-indexer            # your checkout
npm install                                    # Node >= 22 required (node:sqlite)
CSD_RPC=http://127.0.0.1:8789 npm run run-all  # index + serve on :8793
npm run index                                  # one sync pass, exits
npm run serve                                  # API only
npm run typecheck                              # tsc --noEmit
npm test                                       # tsx --test test/*.test.ts (offline, deterministic)
# Postgres mode:
CSD_INDEX_PG=postgres://... npx tsx src/cli.ts index
```

Gotcha: stale dev servers squat :8793; find the squatter and kill it by PID (check what you are killing first) before restarting. `.mjs` gate scripts must run via tsx from the repo dir.

## Testing

- `npm test` globs `test/*.test.ts`; never hand-list files (a hand-listed set once silently dropped analytics.test.ts, the money math). ~14 suites: indexer (reorg unwind/replay, incident regression), checkpoint-floor, rpc-failover, dbtx-isolation, analytics + analytics-lockstep (pins codec emission values, so a bad codec bump fails loudly here) + analytics-memo, decode, health, identity, registry, pagination, reorg-e2e, stream.
- CI runs the whole suite TWICE: sqlite job + postgres job against a postgres:16 service, plus the exact-pin check.
- Live gate scripts (not CI, run via tsx against a live deployment): test/_live_check.mjs, _reconcile.mjs (per-attester rows sum to node aggregates), _browser_verify.mjs, _backend-diff.mjs (sqlite-vs-pg row diff at a finalized height; used to validate the production Postgres cutover), _backend-bench.mjs.

## Release and deploy

- Release = version bump + commit + tag `vX.Y.Z` + push. No npm publish and no build step (tsx runs source directly), so a deployment picks up code edits at process restart. Maintainers handle production deployment and restarts; PRs must not assume deploy access.
- `public/explorer.html` is read from disk per request (server.ts `sendFile`), so explorer changes take effect on any deployment without a restart.
- For self-hosting, the README and Dockerfile are the supported paths (SQLite by default, `CSD_INDEX_PG` for Postgres).

## Production notes

- The maintainers' production instance runs the Postgres backend (`CSD_INDEX_PG`), cut over 2026-07-03 after a from-genesis backfill + cross-backend row diff + full suite. SQLite remains the default for dev, CI, and third-party deployments. Both backends must produce identical API responses; there is deliberately no copy tool between them (a fresh replay IS the integrity check).
- Consumers: the cairnx scanner (reads via `CSD_INDEXER`; complete proposal + attestation lists come from here), the cairn site (netstats/treasury/faucet plus public GET-only allowlisted proxies /explorer/api/* and /trade/api/*), the explorer SPA, the cairn-sdk indexer namespace, and the @inversealtruism/csd-indexwire wire types. Monitoring and failover clients key off `/health`.
- Upstreams: the CSD node RPC (with the multi-backend failover list in config.ts) and optionally a swarm gateway (`CSD_SWARM_GATEWAY`) for content joins.

## Gotchas and incident history

- 2026-07-05 node-loss incident: an upstream node was killed mid-reorg, lost its datadir, and resynced from genesis; the indexer saw the low tip "converge" at a buried height and hard-deleted ~41k rows. Produced the chainwork guard + checkpoint floor + multi-backend failover (all in 0.2.6).
- GRX-WIRE-CLAMP-1: clampInt saturating expires_epoch >2^53 to a safe int made the indexer-fed resolver accept what SPV replay rejects, a canonicalState fork seam masked until V22. Rule: consensus-bound app ints feeding arithmetic/range comparison go through safeValue/safeEpoch, never clampInt.
- CAIRN-IDXREORG-1/2: a latched tip mismatch + node withholding deeper blocks could wipe the index to genesis. Fixed: unwind only on confirmed contiguous divergence.
- Pagination data loss: the old height-only address-txs cursor dropped same-height txids and 500'd on pg; now a (height,txid) keyset.
- pg port bug class to watch when touching SQL: coinbase vout 0xFFFFFFFF overflows int4; DISTINCT + ORDER BY random() rejected; strict bind counts; engine-dependent ORDER BY tie order (tie-break with txid/vout). node:sqlite has no .transaction() helper; manual BEGIN/COMMIT in Store.tx.
- Explorer through the reverse proxy: the explorer is also served through the production front door's reverse proxy (https://cairn-substrate.com/explorer) under a strict per-response nonce CSP (`script-src 'self' 'nonce-...'`), and a nonce never authorizes inline event-handler attributes. The search form's inline `onsubmit=` was silently blocked there (search dead on the public origin) while working fine on a direct local :8793 hit, which is exactly why it slipped through. Fixed in db7b198 by binding via addEventListener inside the nonced script. ALWAYS browser-test explorer changes through the proxy, never only a direct hit; use addEventListener, never inline handlers. The asymmetry cuts both ways: `/header.js` (unified nav) exists only on the front-door origin and 404s on a direct :8793 hit (empty placeholder hidden, 8d93597). The proxy does NOT forward SSE, so the explorer auto-refresh polls /blocks/recent every 12s. The front door sits behind an edge cache; a freshly deployed explorer may need a cache purge to show up.
- Low-hashrate regime (after a dominant pool left the network): staleSecs=600 can false-flag until LWMA retargets; raise CSD_STALE_SECS if noisy.
- Open items: /domains could get the same memoByTip treatment as the analytics endpoints; a server-side inclusion-verification convenience endpoint; explorer registration-label humanization. A second independent indexer for cross-checking is under consideration.

## State snapshot (2026-07-09; verify with git before trusting)

Version 0.2.6, branch master. The two most recent commits touch only public/explorer.html: db7b198 = unified cairn nav above the explorer + search fixed under the front-door proxy CSP (inline `onsubmit=` moved to addEventListener; browser-verified through the proxy), 8d93597 = hide the empty nav placeholder on a direct :8793 hit. Recent themes: v0.2.6 multi-backend failover + chainwork guard + checkpoint floor + explorer hardening; the Postgres backend; the (height,txid) address-pagination keyset; anti-wedge clamps.

## Cross-repo map

Depends on (npm, exact-pinned): @inversealtruism/csd-codec, csd-crypto, csd-registry. Reads from: the CSD node RPC (multi-backend failover), optionally a swarm gateway, and the shared spv-checkpoint file when present (see config.ts). Consumed by: cairnx (scanner feed), cairn (proxies + libs), the explorer SPA, cairn-sdk, csd-indexwire, and health-checking monitors. Version bumps of codec/registry here must move in lockstep with csd-sdk, cairnx, and the wallet.
