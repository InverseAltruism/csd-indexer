# csd-indexer

L2 of the CSD (Compute Substrate) stack: a standalone, reorg-safe chain indexer, block explorer and Esplora-style REST
and streaming API. The CSD node's RPC is deliberately minimal; this service reads raw blocks into a relational
database and serves what the node omits: address history, balances and UTXOs, per-attester attestation data, merkle
inclusion proofs for the L0 light client, miner, holder and supply analytics, and a live SSE and WebSocket stream.

Trust model (README "Honest limits", enforced by design): the indexer is a convenient derived view, not an authority.
Inclusion proofs are trustless (clients re-fold them against PoW headers); everything else is reproducible, not
signed. The audit is "run your own indexer, get byte-identical rows".

This file briefs maintainers and agents (`CLAUDE.md` is a symlink to it); `README.md` is for integrators. The repo is
public: production and operations specifics (hosts, service management, deploy cadence) are out of scope here and
are kept privately by the maintainers.

## Start here

- Check: `npm ci && npm run typecheck && npm run lint && npm run check:dashes-paths && npm test` (offline; Node 26,
  as CI runs it; `node:sqlite` needs 22 or later).
- Red lines: never unwind on absence of evidence or below the checkpoint floor; never reconcile against a node with
  less chainwork; exact integers from the parsed block on; consensus values come from the pinned csd-sdk packages;
  replay may reject more, never accept different. Each is under Invariants or Working rules.
- Explorer changes: browser-test them through the front-door proxy as well as on :8793 (Explorer rules).
- It runs from source with `tsx`: no build step, not published to npm (`private: true`). The version and the
  dependency pins live in `package.json` only; git tags mark releases. It listens on 127.0.0.1:8793 by default
  (`CSD_INDEX_LISTEN`) and is meant to sit behind a reverse proxy when public; the maintainers' instance is served
  through the front door at https://cairn-substrate.com/explorer.
- Read next: the Docs list at the end of this file.

## Cross-repo standard

This repo follows the maintainers' cross-repo engineering standard (a private document). The part that binds a
contributor here:

- One home per concept: consensus values and codec shapes come from the published csd-sdk packages and are never
  re-declared here. Replay stays byte-identical (working rule 5).
- TypeScript `strict` with `noUncheckedIndexedAccess`, no `@ts-ignore`, `any` only at a parse boundary. Money is integer
  base units (`bigint`), never floats. No empty `catch {}`; on money paths no catch-and-continue that hides a failure.
- Tests check behaviour at boundaries. A fix ships with a test that fails without it, plus an assertion that the honest
  path still passes with the call shape production sends. A skipped test names its reason and when it un-skips.
  `npm test` is offline and deterministic.
- Comments state constraints and non-obvious invariants, not history or audit IDs. Removing code needs the same
  evidence as adding it.
- Docs: this file holds what stays true (no version tables, no status snapshots; versions live in `package.json` and
  tags, live state comes from a live query). Dates are absolute, no em dashes.

Known deviation (not exhaustive): `src/config.ts` reads the shared SPV checkpoint file from a sibling checkout when
present and falls back to the built-in floor (`checkpointDefault`, which the tests call with a path of their own). The
path (`SPV_CHECKPOINT_FILE`) is an absolute path on the maintainers' host, published in this public repo; on any other
machine the file is absent and the fallback applies. `scripts/dashes-exceptions.json` lists the file for that reason.

## The stack around it

The chain is the only source of truth; every layer above is a deterministic replay of chain events. Trust is never
laundered: every read carries an honest trust level and UI gates fail closed.

- Reads from: the CSD node RPC (compute-substrate, Rust; this indexer's sole source of truth), with multi-backend
  failover, and the shared spv-checkpoint file when present.
- Depends on (npm, exact-pinned): `@inversealtruism/csd-codec`, `csd-crypto` and `csd-light` from csd-sdk, the L0
  SDK. A version bump of codec here moves in lockstep with csd-sdk, cairnx and the wallet.
- Consumed by: cairnx, the settlement resolver (its scanner reads through `CSD_INDEXER`; complete proposal and
  attestation lists come from here); cairn, the web front door (network figures, `/api/headers` and `/api/blocks`,
  the market data, the faucet when it is on, and the public GET-only allowlisted proxy `/explorer/api/*`); the
  explorer page; cairn-sdk's indexer namespace; monitoring and failover clients, which key off `/health`.
- Retired: cairn-cli (deprecated on npm) and csd-bridge (its bridge contracts are testnet, but its swap scripts spend
  real mainnet CSD, so it is not "testnet-only").
- Both backends must produce identical API responses. SQLite is the default for dev, CI and third-party deployments;
  Postgres (`CSD_INDEX_PG`) is the scale path and what the maintainers' instance runs. Running more independent
  indexers is encouraged: byte-identical replay is the audit.

## Where code lives

TypeScript run by `tsx`, no native dependencies. `docs/specs/indexer.md` has each module in detail (section 1), every
setting with its default (2), the ingest and reorg flows (3) and the API's maintainer notes (4).

- Ingest: `src/cli.ts` (the entry: `index` is one sync pass and exit, `run` is the poll loop and the API server in
  one process), `src/rpc.ts` (the node RPC client and backend selection), `src/indexer.ts` (the sync engine, the reorg
  detectors, the anti-wedge parsers), `src/decode.ts` (address derivation and tx classification, csd-crypto's).
- Config: `src/config.ts`, `CFG`, the only `process.env` reader in `src/`. A numeric knob that is empty, zero,
  negative or not a number falls back to its default (`test/config-knob-positive.test.ts`).
- Store: `src/db.ts`, one async `Store` interface over `SqliteStore` (node:sqlite, WAL) and `PgStore` (pg Pool),
  selected only by `CFG.pg`, and the schema: every row carries `height`, except in the two derived totals tables.
- Read side: `src/queries.ts` (the SQL and the bigint-safe JSON), `src/merkle.ts` (proofs from csd-codec's
  `merkleBranch` with the PoW-committed header root, never a self-recomputed one), `src/analytics.ts` (memoized per
  tip), `src/server.ts` (the Express app and every route), `src/stream.ts` and `src/events.ts` (the event bus, SSE
  and WS `/ws`, with their caps).
- `public/explorer.html`: the single-file explorer served at `/`.
- `test/*.test.ts`: the offline suite; `test/_*.mjs`: live gates, run by hand; `scripts/`: the dash and path check.

## Invariants and red lines

One bullet per rule with the test that pins it. How each works is in `docs/specs/indexer.md` section 5; "incident N"
is a narrative in `docs/incidents/README.md`.

- Chainwork regression guard (incident 1): never reconcile or unwind when the node presents less accumulated chainwork
  than the indexed tip; hold and keep serving last-good, and fail closed when node chainwork is missing or
  unparseable. The comparison is strict `<`. Kill switch `CSD_INDEX_WORK_GUARD=0`. `test/reorg-e2e.test.ts`,
  `test/guard-hygiene.test.ts`, `test/chainwork-*.test.ts`.
- Checkpoint floor (incident 1): never hard-unwind below the highest shipped SPV checkpoint. The floor is
  `CSD_INDEX_CHECKPOINT_FLOOR` when set, else the number in the shared spv-checkpoint file (path in `src/config.ts`),
  else the built-in fallback 38142 (`checkpointDefault`); an empty env string does not disable it.
  `test/checkpoint-floor.test.ts`, `test/config-knob-positive.test.ts`.
- Never unwind on absence of evidence (incident 3): only a confirmed contiguous hash mismatch justifies an unwind,
  and a null block from the node aborts the pass: below the tip window, the first height the node does not answer ends
  the walk, so the pass costs a bounded number of reads. `test/reorg-absence-clamp.test.ts`, `test/reorg-e2e.test.ts`,
  `test/absence-walk-bound.test.ts`.
- sqlite dbTx isolation: BEGIN..COMMIT atomicity against HTTP readers holds only because every await inside a dbTx
  callback is a store call (a microtask). Never add a fetch, fs or timer await inside a dbTx callback.
  `test/dbtx-isolation.test.ts`.
- Exact integers from the parsed block on: CSD max supply exceeds 2^53, so values become BigInt (`safeValue`), store
  as BIGINT and serialize through `amt()` or `jsonSafe()`: a number within 2^53, a bigint past it, never lossy. The
  node's JSON itself is parsed with `res.json()` (`src/rpc.ts`), so an output value above 2^53 is rounded to a double
  before `safeValue` sees it; one output would have to hold about 85.7 percent of csd-codec's `maxSupplyBase`. A stray
  bigint in a response object throws in JSON.stringify and the endpoint answers 500. `test/json-safe-read.test.ts`.
- Anti-wedge clamps (incident 2): `safeValue` clamps to int64 max, because an over-range bind throws inside
  `writeBlock`, rolls back, and the same block poisons every poll. `safeEpoch` clamps an `expires_epoch` above 2^53
  to a non-safe-integer sentinel. Consensus-bound app integers that feed arithmetic or a range comparison go through
  `safeValue` or `safeEpoch`, never `clampInt`, which is legal only for app integers compared against small exact
  enums. `test/indexer.test.ts`, `test/header-bind-clamp.test.ts`.
- First occurrence: a txid has one row in `txs`, `proposals` and `attestations`, and its outputs one row each, at the
  lowest height and position the indexed chain holds it (csd-sdk `packages/cairnx/CONVENTION.md` section 32). A later
  occurrence writes one `tx_repeats` row and nothing else, and an output keeps its first spender. Block tx lists read
  `txs` and `tx_repeats` together, so a block's merkle proofs fold to its header root. After an unwind and replay the
  tables equal a fresh index of the chain that is left. A `meta` tip pointer (`indexed_height`) deleted or set back
  by hand over stored blocks does not end in a fresh index's tables: re-index from empty instead.
  `test/first-occurrence*.test.ts`.
- Derived totals: `coinbase_totals` and `address_totals` (what `/address/:a` serves) are rebuilt at every boot and
  kept equal to their aggregate inside every `writeBlock` and `unwindAbove` transaction.
  `test/coinbase-totals.test.ts`, `test/address-totals.test.ts`, `test/boot-rebuild-timeout.test.ts`.
- Stored text: a Propose's domain and uri pass `storableText` where `src/rpc.ts` `blockByHeight` reads a block, so
  both backends store, serve and emit one string; U+0001 stands in for U+0000 because JSON refuses both unescaped.
  `test/storable-text.test.ts`; `test/_reconcile.mjs` compares the node's domains after the same replacement.
- Determinism deps (csd-codec, csd-crypto, csd-light) are exact-pinned in `package.json`, no carets (CI enforces): a
  floated version is a determinism fork seam across the ecosystem. csd-light is the ecosystem-pinned source of the
  ROUTE-1 checks and of the LWMA window they anchor on; the emission schedule is csd-codec's. A dep bump must also
  move `version`, so one version string never denotes two determinism-dep sets. `test/ci-workflow.test.ts`,
  `test/analytics-lockstep.test.ts`.
- ROUTE-1: a non-primary backend may win on work or height only if its tip header is PoW-valid and hash-bound
  (`tipHeaderPowOk`), plausible (`contenderPlausible`) against the indexer's own stored headers, never the live
  primary, and linked: PoW-valid, hash-linked headers at consecutive heights from its tip down to the primary's tip or
  a stored block, at the height that block holds, with at least one new header (`contenderLinks`), so a replayed
  header proves nothing. A backend whose `/tip` height is not a non-negative integer is left out, and such a tip from
  the active backend fails the pass. ROUTE-1 decides which backend is read; the blocks the active backend serves are
  not checked against their headers. `test/rpc-pow-*.test.ts`, `test/rpc-route-plausibility.test.ts`,
  `test/rpc-route-link.test.ts`, `test/rpc-failover.test.ts`, `test/rpc-tip-height.test.ts`.
- Never point anything at :8790 as the default RPC: that is the miner's RPC; :8789 is primary, :8790 fallback only.
- Every serial-poll read of the node is bounded by a timeout, so a backend that stalls `/block` cannot wedge the
  loop. `test/rpc-timeout.test.ts`.
- Error responses never leak internals: the wrapper `h()` in `src/server.ts` answers without a pg DSN, SQL or a path,
  and the app's final error handler answers what Express refuses before a route runs (a path that does not
  percent-decode: 400) in the same shape. `test/error-body.test.ts`.
- A list read never holds one pool connection per row (incident 10): the list endpoints read a page in a constant
  number of queries, one at a time, so a request holds at most one connection. `test/address-fanout.test.ts`.
- One answer, one view: a route reads its rows in one statement or inside `snapshot()` (`src/db.ts`: REPEATABLE READ
  on Postgres, a deferred transaction on SQLite), so a reorg's commit cannot land between two of its reads; a
  snapshot callback awaits only store reads, as a dbTx callback does. The hot routes (`/tx/:id`, the address and
  block lists) are single statements. `test/snapshot-reads.test.ts`, `test/pg-reorg-read-race.test.ts`.
- Address txs page on the full (height, txid) keyset; a height-only cursor drops same-height txids (incident 4).
  `test/pagination.test.ts`.
- A chain-order feed page reads its own rows: the cursor, the snapshot bound and the limit apply inside the row
  source, which walks the feed indexes, and every answer equals the one the statement it replaced gave, byte for byte.
  `test/feed-page-plan.test.ts`, `test/feed-page-equivalence.test.ts`.
- When touching SQL, watch the Postgres port bug class (incident 5): coinbase vout 0xFFFFFFFF overflows int4; DISTINCT
  with ORDER BY random() is rejected; bind counts are strict; ORDER BY tie order depends on the engine (tie-break with
  txid or vout). node:sqlite has no `.transaction()` helper: `Store.tx` runs BEGIN and COMMIT by hand.
- The process has no uncaughtException handler, so nothing a client sends may throw out of the WS listeners: the
  message handler closes only its own socket on a throw, and every socket gets an `error` listener first thing.
  `test/stream.test.ts`.
- One stream connection's subscription keys, outbound queue and work after a drop are bounded: a WS key longer than
  any an event carries adds nothing; every hello, ack, event and SSE ping goes through `boundedSend`, which drops an
  SSE or WS connection once its queued bytes pass `CSD_INDEX_MAX_SSE_BUFFER`, and a WS pong is sent only while
  nothing is queued for its socket; a WS frame that arrives after the drop is not handled. `test/ws-bounds.test.ts`,
  `test/sse-overflow.test.ts`.
- There is deliberately no sqlite-to-Postgres copy tool: a fresh replay is the integrity check.
- Keep `README.md` "The API" in step with `src/server.ts`. Keep binary and screenshot artifacts out of the repo
  (the repo-root `csd-index.db*` files are gitignored dev artifacts).

## Explorer rules

`public/explorer.html` is one file, read from disk per request. What it shows and how is in `docs/specs/explorer.md`.

- Browser-test a change through the front-door proxy, not only on a direct :8793 hit, and bind events with
  `addEventListener`, never inline handlers: the proxy serves the page under a per-response nonce CSP, and a nonce
  never authorizes inline event-handler attributes (incident 6). `test/explorer-browser.test.ts`.
- The two origins differ in both directions: `/header.js`, `/footer.js` and `/ui/*` exist only on the front-door
  origin and 404 on :8793, where the page keeps its own brand line and fallback tokens; the proxy does not forward
  SSE, so the page polls; an edge cache sits in front, so a freshly deployed explorer may need a purge.
- The coupling to cairn is at runtime only: no build or test reads cairn's tree, and `test/fixtures/` stands in for
  its chart module and shell. `test/explorer-market.test.ts`.
- The page's CSS stays inline, on the `--ui-*` tokens, in the `page` cascade layer: every rule outside the tokens layer
  starts from `:where(.ex-wrap)` or from the page's own classes and ids, and rules stay flat, so the shell keeps its
  look (incident 9). The fallback token block holds the page's only colour literals, and the column and the tab
  icons are the site's, by name. `test/explorer-page-layer.test.ts`, `test/explorer-shell-parts.test.ts`;
  `test/fixtures/off-palette.js` measures the colours on every view.
- A read that fails is never shown as an answer: only a 400 or a 404 from the indexer is a miss; a failed read says it
  could not check, never "Indexer offline", an empty panel or a verdict such as "Not registered"; a record names its
  effect only for a verdict the resolver applied.

## Working rules

1. Maintainers deploy. Contributions and agent sessions must never assume deploy or restart access; this indexes a
   live financial system with real users and real CSD. Default to design-first: agree on the approach before editing
   shared behavior, keep diffs small and reviewed, and treat approval as scoped to the single change discussed.
2. Security fixes must not regress UX. Never add latency or a decline path to a legitimate hot path. Prefer warn over
   hard-block, fail-soft with an availability valve over hard fail-closed, removing a false UI claim over adding
   machinery. Decline disproportionate hardening explicitly, with reasoning.
3. No em dashes in READMEs or any user-facing doc; avoid AI-slop phrasing (excessive bolding, "not just X but Y",
   filler intensifiers). Search the doc for the em dash character before committing; the count must be zero
   (`npm run check:dashes-paths` checks every tracked doc in CI).
4. Commit, push and tag only when asked. Investigations default to read-only.
5. Never weaken the replay discipline: hardening may reject more, it must never accept different, or historical
   replays fork.

## Dev workflow

```bash
npm ci                       # the committed package-lock.json
CSD_RPC=http://127.0.0.1:8789 npm run run-all   # index and serve on :8793
npm run index                # one sync pass, exits
npm run serve                # API only
npm run typecheck            # tsc --noEmit
npm run lint                 # Biome, each an error: unused imports, empty blocks (a comment inside states the
                             # reason), focused tests, @ts-ignore
npm run check:dashes-paths   # em dashes in tracked docs, sibling-checkout paths in code (exceptions in
                             # scripts/dashes-exceptions.json)
npm test                     # tsx --test test/*.test.ts (offline, deterministic)
CSD_INDEX_PG=postgres://... npx tsx src/cli.ts index   # Postgres mode
```

- A stale dev server squats :8793: find the squatter and kill it by PID (check what you are killing first) before
  restarting.
- `.mjs` gate scripts must run via tsx from the repo dir.
- In a low-hashrate regime `CSD_STALE_SECS` 600 can false-flag until LWMA retargets; raise it if noisy.

## Testing

- `npm test` globs `test/*.test.ts`; never hand-list files (incident 7).
- Test files run concurrently. On Postgres every file that touches the store sets its own `CSD_INDEX_PG_SCHEMA` before
  importing `src/`; files left on the default `public` schema read each other's `blocks` rows (incident 8).
- CI runs the whole suite twice, a sqlite job and a postgres job against a postgres:16 service, plus the exact-pin
  check and a `secrets` job (gitleaks, sha256-checked, over the full history of every branch with `.gitleaks.toml`).
  Every `uses:` is pinned to a full commit SHA with its tag in a comment; the workflow token is read-only and no
  checkout keeps credentials (`test/ci-workflow.test.ts` pins this shape).
- `test/explorer-browser.test.ts` runs the explorer in Chromium as the front door serves it, every read stubbed. CI
  installs the headless shell the pinned playwright-core names and sets `EXPLORER_BROWSER_REQUIRED=1`, so a missing
  browser fails the run instead of skipping it; locally `PLAYWRIGHT_CHROMIUM` names a build other than the cached
  one. On a shared host, `playwright-core install` without `--no-remove` deletes the other cached browser builds.
- Live gates (not CI; run via tsx against a live deployment): `test/_live_check.mjs`, `_reconcile.mjs`,
  `_browser_verify.mjs`, `_backend-diff.mjs`, `_backend-bench.mjs`. What each checks, and more on the browser test:
  `docs/specs/indexer.md` section 6.

## Release and deploy

- A release is a version bump, a commit, a tag `vX.Y.Z` and a push (working rule 4: only when asked). There is no npm
  publish and no build step (tsx runs the source), so a deployment picks up code edits at process restart.
  Maintainers handle production deployment and restarts; PRs must not assume deploy access.
- `public/explorer.html` is read from disk per request (`sendFile` in `src/server.ts`), so an explorer change takes
  effect on any deployment without a restart.
- For self-hosting, the README and the Dockerfile are the supported paths (SQLite by default, `CSD_INDEX_PG` for
  Postgres).

## Docs

- `README.md`: what the indexer is, how to run it, the settings, the API, the explorer, honest limits.
- `CHANGELOG.md`: one entry per release.
- `docs/specs/indexer.md`: modules, every setting, flows, API maintainer notes, how the invariants work, the tests.
- `docs/specs/explorer.md`: the explorer page (origins, shell, layout, states, verdicts, charts).
- `docs/incidents/README.md`: the incident narratives behind the numbered rules.
- `docs/plans/open-items.md`: ideas, not scheduled.
- `.githooks/README.md`: the secret-scan pre-commit hook.
