# Indexer: modules, settings, flows and mechanisms

Status: current, 2026-11-17. Moved from `AGENTS.md` on 2026-11-17, with the corrections that commit names. `AGENTS.md`
keeps each rule and the test that pins it; this file keeps how it works. Change both with the code.

The explorer page has its own file, `docs/specs/explorer.md`. The API as integrators read it is `README.md` "The API".

## 1. Modules

TypeScript, run directly by `tsx` (no build step, no native dependencies; CI runs Node 26, `node:sqlite` needs Node 22
or later).

- `src/cli.ts`: the entry. `index` is one sync pass and exit (cron, CI); `run` is the continuous poll loop and the API
  server in one process.
- `src/config.ts`: `CFG` from env, the only `process.env` reader in `src/`. A numeric knob that is empty, zero,
  negative or not a number falls back to its default (`test/config-knob-positive.test.ts`). Section 2 lists the
  settings.
- `src/rpc.ts`: the node RPC client (`/tip`, `/block/height/:h`) and multi-backend failover.
  - `selectBackend()` picks the reachable backend with the most cumulative chainwork. It is sticky, with a 3-block
    height hysteresis, plus a work-escape (`CSD_RPC_WORK_ESCAPE`, 20 cycles) so hysteresis cannot pin a same-height
    fork with less chainwork.
  - The default backend list [:8789, :8790, :8795] is appended only when `CSD_RPC` is the default.
  - ROUTE-1: a non-primary backend may win on work or height only if its tip header is PoW-valid and hash-bound
    (`tipHeaderPowOk`) and plausible (`contenderPlausible`); both checks are csd-light's. `contenderPlausible` in
    `src/rpc.ts` is the adapter that reads the local anchor and passes `CFG`: a delta cap (`CSD_RPC_MAX_AHEAD`, 128)
    plus an LWMA ease factor (`CSD_RPC_MAX_EASE`, 16), anchored on the indexer's own local finality-gated headers
    (never the live primary), so a real min-difficulty header claiming huge chainwork cannot capture the feed while a
    genuinely-ahead honest secondary still wins. Kill switch `CSD_RPC_ROUTE_PLAUSIBILITY=0`, read once at start.
  - The route delta cap grows with the local tip's age at `CSD_RPC_BLOCK_SECS` (120) per block; the tip-header fetch
    for a contender times out after `CSD_RPC_POW_TIMEOUT` (5000 ms).
  - Every serial-poll read is bounded by an AbortSignal timeout (`CSD_RPC_TIMEOUT`, 10 s), so a backend that stalls
    `/block` cannot wedge the loop.
- `src/db.ts`: one async `Store` interface with two backends, selected only by `CFG.pg` (`store()`).
  - `SqliteStore` is node:sqlite's `DatabaseSync` in WAL mode. `PgStore` is a pg Pool with `?` to `$n` translation and
    exact int8 and NUMERIC parsers. A store call fails fast with "indexer db pool saturated" once
    max(64, pool size x 8) calls already wait for a connection (`test/pg-acquire-guard.test.ts`).
  - Tables: `blocks`, `txs`, `outputs`, `address_history`, `proposals`, `attestations`, `tx_repeats`, `meta`. Every row
    carries `height` (the reorg invariant). `tx_repeats(height, pos, txid)` lists the block positions whose txid has
    its rows at an earlier place (section 5, First occurrence).
  - The two exceptions are the derived per-address tables `coinbase_totals` and `address_totals` (section 5, Derived
    totals).
  - Exact-integer policy: a number within 2^53, a bigint past it, never lossy.
  - Four additive, idempotent transport indexes sit in the shared DDL constant and are applied at boot on both
    backends like every other index: `blocks(hash)` for the header-batch lookups, and `outputs(height)`,
    `outputs(spent_height)` and `address_history(height)` for the write and unwind paths
    (`test/schema-indexes.test.ts`).
  - Three feed indexes, `FEED_INDEX_DDL` in the same DDL: `proposals(domain, height)`, `proposals(height)` and
    `attestations(height)`, which the chain-order feeds walk from the cursor (section 4). A start on a database that
    lacks them builds them (`test/feed-page-plan.test.ts`). The boot DDL is one multi-statement string, which
    Postgres runs in one transaction, where `CREATE INDEX CONCURRENTLY` is refused: each build holds a SHARE lock on
    its table, so reads go on and writes wait until the DDL commits. The writer is the indexer process itself, and it
    writes only after the DDL.
  - A start on Postgres runs two transactions, the DDL and the totals rebuild (`bootTx`), each with
    `SET LOCAL statement_timeout = 0`, since an index build and the rebuild grow with the rows, and
    `SET LOCAL lock_timeout` of `BOOT_LOCK_TIMEOUT_MS` (5 s), so a lock another session holds (an open write
    transaction, a `VACUUM FULL`, a hand-run `LOCK`) fails the start with "the start waited 5000 ms for a lock
    another session holds" after at most 5 s per lock, and the next store call starts again; ordinary statements keep
    the 30 s statement timeout. The DDL locks six tables (SHARE) and the rebuild the two totals tables (SHARE ROW
    EXCLUSIVE), and reads the others (ACCESS SHARE, which waits only for ACCESS EXCLUSIVE). SQLite has no statement
    timeout; a start waits `busy_timeout` (5 s) for another process's write lock and fails with "database is locked",
    and the next `store()` opens it again (`test/boot-rebuild-timeout.test.ts`).
- `src/indexer.ts`: the sync engine. `syncOnce()` (chainwork regression guard, then `reconcileTipWindow`, then the
  forward scan), `writeBlock()` (one db transaction per block, self-clearing per height), `unwindAbove()` (reorg
  undo), `findReorgAncestor()`. The anti-wedge parsers `safeValue`, `safeEpoch` and `clampInt`.
- `src/decode.ts`: the signer address from a scriptSig and the address from a script_pubkey (both csd-crypto's,
  re-exported), tx classification (Coinbase, Propose, Attest, Transfer), and `storableText`, the stored form of a
  Propose's domain and uri.
- `src/merkle.ts`: Electrum-format merkle proofs built with csd-codec's `merkleBranch` (the same function the L0 light
  client folds). It returns the PoW-committed header root, never a self-recomputed one.
- `src/queries.ts`: the read-side SQL; `amt()` and `jsonSafe()`, the bigint to JSON-safe serialization; the `heightOk`
  guard.
- `src/analytics.ts`: `/analytics/{miners,richlist,supply,series}`. The emission schedule is single-sourced from
  csd-codec. `memoByTip` memoizes per tip: the promise is cached before it settles, so concurrent reads share one
  computation, and a rejected one is dropped. The rich list is read once per tip at 500 and each `?limit` slices it
  (`test/analytics-memo.test.ts`).
- `src/server.ts`: the Express app and every route. The error wrapper `h()` never leaks a pg DSN, SQL or a path.
  `/address/:a` reads one `address_totals` row, whatever the address holds, since anyone can add outputs to any
  address. The list endpoints (`/address/:a/txs`, `/address/:a/txs/chain/:last`, `/block/:hash/txs`) read a page in a
  constant number of queries (`q.txsWithOutputs`, `q.blockTxs`), one at a time, so a request holds at most one pool
  connection (`test/address-fanout.test.ts`; `docs/incidents/README.md` 10).
- `src/stream.ts` and `src/events.ts`: the event bus, the SSE firehoses and WS `/ws`.
  - Caps: 500 SSE connections (`CSD_INDEX_MAX_SSE`), 500 WS clients (`CSD_INDEX_MAX_WS`), 1000 subscription keys
    (`CSD_INDEX_MAX_SUB`), a 4 MiB outbound buffer per connection (`CSD_INDEX_MAX_SSE_BUFFER`;
    `test/sse-overflow.test.ts`), 64 KiB per WS frame (ws's `maxPayload`, refused with 1009 before it is buffered).
  - The process has no uncaughtException handler, so nothing a client sends may throw out of the WS listeners. The
    message handler checks the frame's shape and closes only its own socket (1011) on a throw. Every socket, one
    refused over the client cap (1013) included, gets an `error` listener first thing, since ws emits a protocol error
    (an oversize frame, invalid UTF-8) on the socket before closing it and still reads the frames a refused socket
    sent before its close (`test/stream.test.ts` runs the server in a child process for these).
- `public/explorer.html`: the single-file explorer served at `/` (`docs/specs/explorer.md`).

Repo-root `csd-index.db{,-shm,-wal}` are gitignored dev artifacts; a real deployment keeps its data in its own db file
or in Postgres.

## 2. Settings

`README.md` "Run your own" lists the settings an operator usually sets: `CSD_RPC`, `CSD_INDEX_DB`, `CSD_INDEX_PG`,
`CSD_INDEX_PG_SCHEMA`, `CSD_INDEX_PG_POOL`, `CSD_INDEX_LISTEN`, `CSD_INDEX_FROM` and `CSD_CONFIRMATIONS_FINAL`
(`test/docs-env.test.ts` checks that table and the Dockerfile against `src/config.ts`). The others `src/config.ts`
reads:

| Setting | Default | Meaning |
|---|---|---|
| `CSD_RPC_BACKENDS` | `CSD_RPC`; with the default `CSD_RPC`, also :8790 and :8795 | failover backends, primary first |
| `CSD_INDEX_POLL` | 15 | seconds between sync passes |
| `CSD_STALE_SECS` | 600 | seconds since the tip block's time before `/health` reports `stale` |
| `CSD_INDEX_CHECKPOINT_FLOOR` | the shared spv-checkpoint file's number, else 38142 | no unwind below this height |
| `CSD_INDEX_WORK_GUARD` | on | `0` turns the chainwork regression guard off |
| `CSD_RPC_TIMEOUT` | 10000 | milliseconds before a serial-poll node read is aborted |
| `CSD_RPC_WORK_ESCAPE` | 20 | cycles the active backend may stay below the best chainwork before a forced switch |
| `CSD_RPC_MAX_AHEAD` | 128 | ROUTE-1 delta cap: blocks a contender may claim beyond the local tip |
| `CSD_RPC_MAX_EASE` | 16 | ROUTE-1 ease factor: how much easier than the local target a contender's tip may be |
| `CSD_RPC_ROUTE_PLAUSIBILITY` | on | `0` turns the plausibility gate off |
| `CSD_RPC_BLOCK_SECS` | 120 | target block spacing for the wall-clock-aware delta cap; never used for consensus |
| `CSD_RPC_POW_TIMEOUT` | 5000 | milliseconds before a contender's tip-header fetch is aborted |
| `CSD_INDEX_MAX_SSE` | 500 | SSE connection cap |
| `CSD_INDEX_MAX_WS` | 500 | WS client cap |
| `CSD_INDEX_MAX_SUB` | 1000 | subscription keys per WS client and category |
| `CSD_INDEX_MAX_SSE_BUFFER` | 4194304 | bytes of outbound buffer per SSE connection |
| `CSD_CONFIRMATIONS_DISPLAY` | 3 | read, consulted by nothing |
| `CSD_INDEX_BATCH` | 200 | read, consulted by nothing |

`SPV_CHECKPOINT_FILE` in `src/config.ts` is an absolute path on the maintainers' host; on any other machine the file
is absent and the built-in floor applies (`checkpointDefault`, which the tests call with a path of their own).

Read by tests and gates only: `CSD_INDEX_API` (the base the live gate reads, default http://127.0.0.1:8793),
`EXPLORER_BROWSER_REQUIRED`, `PLAYWRIGHT_CHROMIUM` and `PLAYWRIGHT_CORE` (`test/explorer-browser.test.ts`).

## 3. Flows

Block ingest (`syncOnce`): select the backend, run the chainwork regression guard, `reconcileTipWindow()`, then scan
forward from `indexedHeight()+1`, one `writeBlock` per height. `writeBlock` runs in a single db transaction: clear any
prior contents of that height, insert the block row (the node-reported chainwork as TEXT), resolve inputs against the
indexer's own `outputs` table (the electrs model, zero extra RPC), write outputs, spends, `address_history` and the
Propose and Attest app rows; a txid `txs` already holds gets one `tx_repeats` row and nothing else. Events emit only
near the tip; status goes from tentative to confirmed past `finalDepth` (6).

Reorg undo: two detectors. (a) `reconcileTipWindow` catches equal-height and lower-height reorgs (heavier in chainwork
but not taller, possible under LWMA) by walking down to the last converged hash; (b) `findReorgAncestor` catches a
taller block with a mismatched prev. Both call `unwindAbove(ancestor)`: DELETE above the ancestor on every table,
un-spend outputs whose spender was orphaned, reset the tip meta, emit a reorg event, replay forward. Never unwind on
absence of evidence (a null block from the node aborts the pass); deep reorgs follow to the scan floor instead of
throwing.

## 4. API: maintainer notes

The endpoint list for integrators is `README.md` "The API"; keep it in step with `src/server.ts`.

- Esplora core: `/blocks/tip/height` answers 503 on an empty index; `/block/:hash[/txids|/txs]`; `/tx/:id[/status]`;
  `/address/:a[/txs|/txs/chain/:last]` with a (height, txid) keyset cursor; `/address/:a/utxo` in pages of 1,000 with
  an `after=<height>:<txid>:<vout>` keyset (`test/address-utxo.test.ts`); `chain_stats.utxo_count` on `/address/:a`,
  which the explorer shows instead of reading `/utxo`; `/tx/:id/merkle-proof`.
- CSD extras: `/domains`; `/domain/:d/proposals`; `/proposal/:id[/attestations]`, keyset-paginated, which is how the
  CairnX resolver fetches complete attestation lists; `/blocks/at-or-after/:time` (the lowest height whose time is at
  or after, over `idx_blocks_time`); `/proposals` and `/attestations` (chain order, a snapshot block `at` and an
  `after=<height>:<pos>` keyset that needs the hashed snapshot `at=<height>:<hash>` (400 without, and 400 for a
  position above `PG_INTEGER_MAX`, the range of the 4-byte `txs.pos` on Postgres, which a position in a block of at
  most 2,000 transactions never reaches; `test/feed-cursor-range.test.ts`), 409 when a reorg
  reaches the snapshot; `format=2` adds each row's transaction's outputs by a LEFT JOIN on `outputs` around the
  page statement, after its LIMIT, so a page stays one statement; `test/chain-feeds.test.ts`). The cursor, the
  snapshot bound and the LIMIT apply inside the row source, which walks a feed index (section 1) in height order
  from the cursor, reads each row's position from `txs` and sorts only within a height, so a page of proposals, or
  of attestations without `domain`, reads its rows and the rest of the heights at its two ends, whatever the feed's
  size. An attestation's domain is its proposal's, which no attestations index holds, so a domain's attestation
  page has two arms in its one statement, and a CTE gives one of them the page's limit and the other a limit of 0,
  which both engines read once and stop at before the arm runs. A domain with fewer than `FEED_DOMAIN_SMALL` (one
  full page) proposals and attestations is read from its proposals, bounded by that count whatever the chain's
  size; a larger one walks attestations by height and probes each one's proposal, reading every domain's
  attestations in the page's height range, which for a domain with many proposals and few attestations is up to all
  of them. CROSS JOINs fix SQLite's join order (without per-domain statistics it reads every domain from its
  proposals); Postgres orders each arm's joins by its statistics. `test/feed-page-plan.test.ts` pins the plans and
  the executed work (SQLite VM steps, Postgres rows read); `test/feed-page-equivalence.test.ts` compares every
  request shape, through either arm, with the statement the feeds ran before (`test/_feed-page-legacy.ts`, kept for
  that comparison only);
  `/address/:a/reputation` (aggregates over the newest 200
  attestations; past that `truncated: true` and a `note` naming the window; `test/reputation-window.test.ts`);
  `/analytics/*`.
- `/health`: version, backend, indexed_height, chainwork, stale; counts memoized per tip; `checkpoint_floor`;
  `build.commit`, the HEAD read once at start through `git -c safe.directory=<tree>`, since the user the process runs
  as may not own the checkout, and "unknown" on any failure (`test/health.test.ts`).
- SSE `/stream/*`, WS `/ws`.

## 5. How the invariants work

Chainwork regression guard and checkpoint floor. The guard holds when the node presents less accumulated chainwork
than the indexed tip (strict `<`) and fails closed when the node's chainwork is missing or unparseable; the floor is
the backstop under it. The floor is `CSD_INDEX_CHECKPOINT_FLOOR` when set, else the number in the shared
spv-checkpoint file, else 38142; an empty env string does not disable it. `docs/incidents/README.md` 1 is why both
exist.

Anti-wedge clamps. `safeValue` clamps to int64 max: an over-range bind throws inside `writeBlock`, the transaction
rolls back, and the same block poisons every poll, a permanent wedge. `safeEpoch` clamps an `expires_epoch` above 2^53
to a non-safe-integer sentinel; using `clampInt` there forked the live resolver against SPV replay
(`docs/incidents/README.md` 2). `clampInt` is only legal for app integers compared against small exact enums.

First occurrence. A txid has one row in `txs`, `proposals` and `attestations`, and its outputs one row each, at the
lowest height and position the indexed chain holds it (the rule is csd-sdk `packages/cairnx/CONVENTION.md` section 32,
M4).

- `writeBlock` reads `txs` first: a txid it already holds, from a lower height or from earlier in the block, is listed
  in `tx_repeats` and writes nothing else (no row moves, no spend marker, no `address_history` row, no proposal or
  attestation event), and an output keeps its first spender.
- `blockTxids` and `blockTxs` read `txs` and `tx_repeats` together, so each block lists every transaction it holds and
  the merkle proofs built from that list fold to its header root.
- After an unwind and replay the tables equal a fresh index of the chain that is left. That rests on `syncOnce`
  writing heights in ascending order without a gap, writing no height below the stored tip while the `meta` tip
  pointer (`indexed_height`) is at most one below the highest stored block, and starting at `CSD_INDEX_FROM` (default
  0; above 0 a txid's place is its first occurrence at or above it).
- Nothing in `src/` sets the pointer lower (`unwindAbove` and `syncOnce` write it, the second one height at a time
  after each block; `resetStoreForTests` drops it with every table). A pointer deleted or set back by hand over stored
  blocks makes `syncOnce` rewrite stored heights in place, which does not end in a fresh index's tables: re-index
  from empty instead.
- An output a later occurrence creates again stays one row in its first state, so balances, the UTXO list and
  `coinbase_totals` count it once (`test/first-occurrence.test.ts`, `test/first-occurrence-floor.test.ts`).

Derived totals. `coinbase_totals` and `address_totals` are the two tables whose rows carry no `height`. They are
rebuilt from the rows at every boot (on Postgres in one transaction without the 30 s statement timeout,
`test/boot-rebuild-timeout.test.ts`) and kept equal to their aggregate inside every `writeBlock` and `unwindAbove`
transaction, under one Postgres lock on both (`TOTALS_LOCK`).

- `coinbase_totals` is the count and sum of coinbase outputs (`test/coinbase-totals.test.ts`).
- `address_totals` is what `/address/:a` serves: output and unspent counts, funded and spent sums, distinct txids in
  `address_history` (`test/address-totals.test.ts`). It holds each sum as two columns, the sums of value >> 32 and of
  value & 0xFFFFFFFF (`joinSum`), so no sum overflows int64 below 2^31 outputs per address.
- Writes move `address_totals` by the share of the written heights (`ADDRESS_AT`). That is exact for the transaction
  count because all `address_history` rows of one (addr, txid) sit at the txid's height, for rows written by 0.3.9 or
  later. 0.3.7 kept the history rows of a repeated txid at both heights; an unwind over them serves a count one short
  until the next start, and such a database is re-indexed from empty.

Stored text. A Propose's domain and uri pass `storableText` where `src/rpc.ts` `blockByHeight` reads a block, so both
backends store, serve and emit one string. A stand-in is needed because Postgres TEXT refuses U+0000 and node:sqlite
reads TEXT back only up to it; U+0001 stands in for U+0000 because JSON refuses both unescaped
(`test/storable-text.test.ts`). `test/_reconcile.mjs` compares the node's domains after the same replacement.

Determinism deps. csd-codec, csd-crypto and csd-light are exact-pinned in `package.json`, no carets (a CI step, run by
`test/ci-workflow.test.ts`). csd-light is the ecosystem-pinned source of the ROUTE-1 checks (`tipHeaderPowOk`,
`contenderPlausible`) and of the LWMA window they anchor on (`expectedBitsFromWindow`). A floated version is a
determinism fork seam across the ecosystem. A dep bump must also move `version`, so one version string never denotes
two determinism-dep sets.

sqlite dbTx isolation. BEGIN..COMMIT atomicity against HTTP readers holds only because every await inside a dbTx
callback is a store call (a microtask), so the event loop never runs a reader between BEGIN and COMMIT on the shared
connection (`test/dbtx-isolation.test.ts`). node:sqlite has no `.transaction()` helper; `Store.tx` runs BEGIN and
COMMIT by hand.

## 6. Tests

- `npm test` globs `test/*.test.ts`. Suites include indexer (reorg unwind and replay, incident regression),
  checkpoint-floor, rpc-failover, dbtx-isolation, analytics, analytics-lockstep (pins the codec's emission values, so a
  bad codec bump fails loudly here), analytics-memo, decode, health, pagination, reorg-e2e and stream.
- `test/explorer-browser.test.ts` runs the explorer in Chromium as the front door serves it (nonce CSP, every read
  stubbed, `/api/market` fresh, stale and 503). playwright-core is an exact-pinned devDependency; CI's sqlite job
  installs the headless shell it names (`npx playwright-core install --with-deps chromium-headless-shell`) and sets
  `EXPLORER_BROWSER_REQUIRED=1`, so a missing browser fails the run instead of skipping it. Cairn's chart module is
  replaced by `test/fixtures/chart-stub.js`, which implements only the exports the page calls, and cairn's shell by
  `test/fixtures/ui/` (served, or all absent as on a direct hit), so the tests check the page's wiring and no test
  reads cairn's tree; the module's rendering is tested in cairn. Run it alone with
  `npx tsx --test test/explorer-browser.test.ts`: the pinned playwright-core uses its own revision of
  `chromium_headless_shell` under `~/.cache/ms-playwright/` (the revision is in
  `node_modules/playwright-core/browsers.json`), and `PLAYWRIGHT_CHROMIUM` names another build. On a shared host,
  `playwright-core install` without `--no-remove` deletes the other cached browser builds.
- CI (`.github/workflows/ci.yml`): a sqlite job and a postgres job against a postgres:16 service run the whole suite,
  plus the exact-pin step and a `secrets` job (the gitleaks release binary, sha256-checked, over the full history of
  every branch with `.gitleaks.toml`). `test/ci-workflow.test.ts` pins the workflow's shape.
- Live gates, not CI, run via tsx from the repo dir against a live deployment: `test/_live_check.mjs`
  (`test/live-check.test.ts` runs it against a mock), `test/_reconcile.mjs` (per-attester rows sum to node
  aggregates), `test/_browser_verify.mjs`, `test/_backend-diff.mjs` (a sqlite-versus-pg row diff at a finalized
  height) and `test/_backend-bench.mjs`. `npx tsx test/_backend-bench.mjs --feeds --scale <n>` runs only its feed
  section, on a scratch SQLite file, or with `--pg <dsn>` in a scratch schema of a scratch Postgres (never a live
  database: it writes rows), and no live data: n times the given feed row counts in three domains, full walks of
  both feeds in format 1 and 2 per `--domains`, and the plans of each walk's first and last page statement
  (`EXPLAIN (ANALYZE, BUFFERS)` on Postgres). `--index-build` times the feed indexes' builds on the loaded rows and
  a start without and with them; `--diff` runs `test/_feed-diff.ts` over the rows instead of the walks.
