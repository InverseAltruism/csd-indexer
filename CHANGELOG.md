# Changelog

## 0.3.13

- WebSocket `/ws` bounds three things one connection could grow without limit: the subscription keys it holds, the
  queue of every frame the server sends it, pongs included, and the work done for frames that arrive after it is
  dropped. A subscription key longer than any an event carries adds nothing, as a field of the wrong type already did:
  a domain over csd-codec's `MAX_DOMAIN_BYTES` (128 UTF-8 bytes, the node's limit), an address over 42 characters, a
  proposal id over 66. A key could be as long as the 64 KiB frame, so the 1,000 keys per category a connection may
  hold could pin about 196 MB of keys, and every subscribe frame, `{}` included, is acked with the whole subscription;
  a client that stopped reading and kept sending tiny frames made the server queue that ack again for each one. Each
  hello, ack and event now goes through the rule the SSE streams had (one `boundedSend` in `src/stream.ts`): past
  `CSD_INDEX_MAX_SSE_BUFFER` (4 MiB) queued, the socket is dropped with `terminate()`. The spec already listed that
  bound per connection; the code applied it to SSE only. ws's automatic pong is off (`autoPong: false`): it was
  written outside that rule, so a client that never read and sent only pings queued pongs without limit. A pong now
  echoes the ping's payload only while nothing is queued for the socket: such a client holds at most one pong and
  keeps its socket. A ping is answered when nothing is queued for the connection, so a client behind its own queued
  bytes, typically right after a large ack, can miss a pong. ws still emits the rest of a chunk it has read
  after `terminate()`; the message handler returns at once for a socket that is no longer open, so those frames build
  no ack. The ack still echoes the subscription, as README and the front door's API page document it, and is bounded
  by the key cap and the key bound; `docs/specs/indexer.md` gives the worst case per connection and for the default
  connection cap. `CFG.maxSseBuffer` is renamed `maxStreamBuffer`; the environment variable keeps its name.
  `test/ws-bounds.test.ts` (in process, ephemeral port, a client cap of 1): an over-long key adds nothing and a key
  at each bound is tracked and receives its events; at the caps the ack is queued whole and the reading client stays;
  the largest ack is measured; a client that stops reading is dropped, on the ack path and on the event path, with at
  most the bound and one frame queued, and its bus listener and slot are freed while it still holds its socket; a
  burst received before the drop builds no ack after it; a flood of pings from a client that reads nothing queues at
  most one pong; a reading client that pings with nothing queued gets each ping's payload back, and one behind
  its own acks gets a pong only for pings that met no queue. The 60 KiB case of `test/stream.test.ts`, which pins
  ws's 64 KiB frame limit, now sends 470 domains of 128 bytes in one frame of about 60 KiB instead of one 60 KiB
  domain, and that file's server listens on an ephemeral port.
- A path parameter that does not percent-decode (`/block/%E0%A4%A`) answers 400 `{"error":"bad request"}`. Express
  refused it before any route ran and its default handler sent an HTML page with the stack and the install path,
  since neither the Dockerfile nor the README sets `NODE_ENV`. The app's final error handler (`finalErrorHandler`)
  answers such an error in the routes' shape, with `Content-Type: application/json` set explicitly: a 4xx status with
  its name, anything else as `h()` does (500 `{"error":"internal error"}`, the error logged). It also answers `GET /`
  with an unsatisfiable `Range` (416) or a failing `If-Match` (412), which sendFile passes on after it has set the
  page's type. A 4xx that reaches it is not logged, where Express's default handler logged its stack for every such
  request; the 500 path logs as before. A response already started is passed to Express, which ends it. Every
  route's own error body is unchanged. `test/error-body.test.ts`.
- `test/checkpoint-floor.test.ts` pins the forward scan's checkpoint-floor refusal (`syncOnce`): a heavier, taller
  branch forking below the floor is refused by `reconcileTipWindow` and then by the forward scan, whose check no test
  turned red without.
- Corrected statements, no code change: events are emitted once per block when it is written, with the status of its
  depth then, and are not re-sent as `confirmed` when the block deepens (`src/events.ts`, `docs/specs/indexer.md`
  section 3); output values are exact from the parsed block on, while the node's JSON is parsed with `res.json()`,
  which rounds a value above 2^53 before `safeValue` (AGENTS.md, the spec's exact-integer line).

## 0.3.12

- `GET /proposals` and `GET /attestations` take `format`. `format=2` answers `{ format: 2, at, rows, next }`, each row
  with `outputs`, its transaction's outputs in output order as `[{ addr, value }]` (`addr` as `/tx/:id` gives it or
  null, `value` a JSON number up to 2^53 - 1 and a decimal string above it), so a replayer that needs who a record
  paid reads it from the feed instead of one `/tx/:id` per row. The outputs are joined to the page in its one
  statement, after the LIMIT: the same snapshot as the rows, one statement per page, and `limit` still counts rows.
  Without `format`, or with `format=1`, the answer is 0.3.11's, byte for byte; any other value is 400
  (`want format=1 or format=2`). README "The API" gives both row shapes and how an `expires_epoch` past 2^53 travels.
- `test/chain-feeds.test.ts`: the answer to the released resolver's request shape is pinned by the sha256 of 0.3.11's
  bytes, and the format-absent and `format=1` answers are equal for both feeds, three domain filters and three page
  sizes; format 2 for a proposal paying only change, one without outputs, several outputs to one address, a value
  past 2^53 and an output with no address, a fill paying a seller and a fee, the same rows and outputs paged by
  `after=` as in one page with one statement per page, and the refusal of an unknown format.
- A page of `/proposals` or `/attestations` reads its own rows. The page statement read every row of the feed, or of
  the domain, at or below the snapshot and sorted them for each page, so a full walk grew with the square of the row
  count. The cursor, the snapshot bound and the limit now apply inside the row source, which walks a new index in
  height order from the cursor, reads each row's position from `txs` and sorts only within a height. The snapshot
  check and the rows are still one statement, a missing snapshot block still answers 409 and an empty page 200, and
  format 2 still joins the outputs after the limit in that statement. A domain's attestations need two arms, since an
  attestation's domain is its proposal's: a domain under one full page (`FEED_DOMAIN_SMALL`, 1,000) of proposals and
  of attestations is read from its proposals, a larger one by walking attestations by height, and a CTE gives the
  chosen arm the page's limit and the other a limit of 0, which both engines stop at before the arm runs. On SQLite a
  domain with a page or more of proposals and few attestations still reads up to every attestation in the page's
  height range, where the old statement read every proposal of the domain; Postgres orders that arm's joins by its
  statistics and may read the domain's proposals instead.
- The answers are unchanged, byte for byte, but for the one change below. `test/_feed-diff.ts` sends each request
  through the real app twice, with the old statement (`test/_feed-page-legacy.ts`, kept for this comparison only) and
  the new one, and compares status and body. Over the bench rows below, for both feeds, the domain filters cairnx:v1,
  the small domain, a domain without rows, the empty string and none, limits 1, 7 and 1000, formats absent, 1 and 2,
  `at` as height and hash, height only and absent, and walks from the beginning, after the first row of a height with
  more rows, about two pages before the end, after the last row, past the snapshot and at the largest position the
  route accepts (2^31 - 1): at scale 1, 68,339 pages on SQLite and 68,339 on Postgres 16 with every walk to its end;
  at scale 100, 10,197 pages on SQLite and 7,668 on Postgres, every walk at limit 1000 to its end and those at limits
  1 and 7 stopped at 20 pages. The scale-100 runs started that walk at 2^31 instead, before the route refused it,
  where both statements answered 500 on Postgres and a page on SQLite; the page statement has not changed since.
  0 differences in each, and in every walk each row is strictly after the one before in (height, pos).
- The one deliberate change in an answer: `after=<height>:<pos>` with a position above 2^31 - 1 (`PG_INTEGER_MAX` in
  `src/db.ts`, the range of the 4-byte `txs.pos` on Postgres) answers 400 `{"error":"want after=<height>:<position in
  block>"}` on both backends, as any malformed cursor does. It answered 500 on Postgres, where the bind fails, and a
  page on SQLite. A block holds at most 2,000 transactions (the node's `MAX_BLOCK_TXS`, which csd-codec does not
  export), so no row's position comes near the bound and no cursor a page gave is refused. Heights, `at=` and the
  cursor's, bind against BIGINT and answer as before up to 2^53 - 1. `/address/:a/utxo` takes its `vout` bound from
  the same constant, unchanged. `test/feed-cursor-range.test.ts`, on both backends, fails without the check (500 on
  Postgres, 200 on SQLite).
- A start on Postgres runs the schema DDL and the totals rebuild each in its own transaction with
  `SET LOCAL statement_timeout = 0` and `SET LOCAL lock_timeout = 5000` (`bootTx` and `BOOT_LOCK_TIMEOUT_MS` in
  `src/db.ts`). The DDL ran under the pool's 30 s statement timeout, so on a large enough existing database an index
  build would be cancelled, the DDL rolled back, and every later start would try the same build again; it now runs
  as long as the build takes, and every other statement keeps the timeout. A lock another session holds is waited
  for at most 5 s per lock, where the DDL waited up to the 30 s timeout and the rebuild without a bound. The DDL takes
  SHARE locks on six tables, the rebuild SHARE ROW EXCLUSIVE on the two totals tables and ACCESS SHARE on what it
  reads (which waits only for ACCESS EXCLUSIVE). Past that the start fails with "the start waited 5000 ms for a lock
  another session holds", and the next store call starts again. SQLite has no statement timeout: a start waits
  `busy_timeout` (5 s) for another process's write lock, fails with "database is locked", and the next `store()` opens
  it again (5,008 ms in a run by hand), so it needs no change. `test/boot-rebuild-timeout.test.ts`: a start that
  builds the three indexes over 400,000 proposals and 100,000 attestations under a 50 ms statement timeout completes,
  and an ordinary read on its connection still times out; a start behind another session's SHARE ROW EXCLUSIVE lock
  on proposals fails with that error and the next one completes. The first fails without the DDL's
  `SET LOCAL statement_timeout` ("canceling statement due to statement timeout"), the second without the
  `lock_timeout` (the start hangs until the test kills it at 30 s).
- Indexes `proposals(domain, height)`, `proposals(height)` and `attestations(height)` (`FEED_INDEX_DDL` in `src/db.ts`)
  are in the boot DDL, so the first start of this version on an existing database builds them. On the scale-100 rows
  below the three builds took 308, 164 and 30 ms on SQLite and 347, 151 and 44 ms on Postgres 16 (a start on those
  rows took 5,992 ms without the indexes and 5,565 ms with them on SQLite, most of it the totals rebuild, and 1,058 and
  539 ms on Postgres). On Postgres the boot DDL is one multi-statement string, which runs as one transaction, where
  `CREATE INDEX CONCURRENTLY` is refused; each build holds a SHARE lock on its table, so reads go on and writes wait
  (checked on a scratch cluster), and every start already takes that lock for each existing index. The writer is the
  indexer process, which writes only after the DDL. The height indexes also serve `writeBlock`'s and `unwindAbove`'s
  deletes of proposals and attestations by height, which scanned both tables on every block write.
- `test/_backend-bench.mjs --feeds` loads n times the given feed rows into a scratch SQLite file, or with `--pg` into a
  scratch schema of a scratch Postgres, and walks both feeds in both formats per `--domains`; `--index-build` times
  the index builds and `--diff` runs the differential above. At 100 times the live counts read on 2026-11-18
  (cairnx:v1 122,200 proposals and 27,000 attestations, among 314,900 and 53,300 with a second domain and a small third
  one of 300 and 200), a full walk at `limit=1000` took, before and after, page p50 in parentheses:

  | feed, format 1 | SQLite before | SQLite after | Postgres before | Postgres after |
  |---|---|---|---|---|
  | proposals of cairnx:v1 | 27,548 ms (215.7) | 1,369 ms (10.8) | 17,086 ms (125.5) | 1,600 ms (12.0) |
  | all proposals | 116,398 ms (374.6) | 3,037 ms (7.6) | 109,344 ms (259.8) | 3,711 ms (10.6) |
  | attestations of cairnx:v1 | 7,548 ms (276.8) | 489 ms (16.6) | 2,829 ms (107.5) | 698 ms (22.7) |
  | all attestations | 4,721 ms (89.8) | 459 ms (7.7) | 3,875 ms (72.6) | 666 ms (10.9) |
  | attestations of the small domain, one page | 6.7 ms | 6.2 ms | 6.5 ms | 7.5 ms |
  | attestations of a domain without rows, one page | 0.4 ms | 0.6 ms | 1.4 ms | 2.2 ms |

  The median of 3 runs, except Postgres before (1 run), on a loaded shared host. Format 2 adds a primary-key read of
  `outputs` per page row (proposals of cairnx:v1 after: 2,780 ms on SQLite, 2,590 ms on Postgres). Timed alone on
  the same rows (median of 50 runs), a first attestation page of cairnx:v1 went from 314 to 11 ms on SQLite and from
  320 to 21 ms on Postgres. The arm choice counts a small domain's rows before reading them, so such a page costs
  more on SQLite (the small domain's 200 rows: 3.77 to 5.28 ms; a domain without rows: 0.06 to 0.17 ms) and the
  empty domain's on Postgres (0.57 to 1.41 ms), while the small domain's on Postgres went from 14.57 to 4.38 ms.
- `test/feed-page-plan.test.ts`: on a feed of 2,000 blocks, for every statement shape and a first and a late page,
  the SQLite plan holds no scan of a record table, txs or outputs, no sort of the whole row source and no read of the
  record table outside the page's range; SQLite's VM steps for a late page are at most twice the first page's; the
  rows Postgres reads from the record table are those of the page and the heights at its ends (for a domain under
  `FEED_DOMAIN_SMALL`, its own rows, counted and then read); the statement it
  replaced fails each check; a start creates the indexes on a database that lacks them; the deletes by height search
  them. `test/feed-page-equivalence.test.ts` runs the differential on a chain written through `writeBlock`, before
  and after a reorg, through either arm, and shows it fails on a reordered reference.

## 0.3.11

- The coinbase-totals maintenance no longer reads coinbase outputs whose row sits at another height than their `txs`
  row (`COINBASE_WHERE.txAtHeight` and `txAbove`, one probe per block write and per unwind). Since 0.3.9 an output and
  its `txs` row are written in one turn and deleted by the same height (a repeated txid writes nothing,
  `src/indexer.ts` `SQL_FIRST`), so the probes returned no row: with each one made to throw on a row, 62 tests of the
  write, reorg and totals suites ran with 0 failed (SQLite: 60 passed, 2 skipped; Postgres: 59 passed, 3 skipped),
  while a hand-made row of that shape made both throw. A database written before first occurrence that still holds
  such a row is re-indexed from empty, and the start's rebuild repairs `coinbase_totals` in any case.
  `test/coinbase-totals.test.ts` no longer checks the two plans.

- The Dockerfile installs with `npm ci --omit=dev --no-audit --no-fund` only. It fell back to `npm install`, which
  resolves the caret ranges in `package.json` afresh when the lockfile install fails; a failed install now fails the
  build. `--no-audit` keeps the build from posting the dependency tree to the registry.

- Comments in `src/db.ts` and `src/indexer.ts` state constraints only. The timing dropped from `src/db.ts` covered the
  coinbase rebuild alone; 0.3.10's entry gives both rebuilds, measured at 1,000,000 outputs. The note that a database
  with history rows of one repeated txid at two heights (written before first occurrence) serves a transaction count
  one short after an unwind until the next start, and is re-indexed from empty, stays in the `src/db.ts` bullet of
  AGENTS.md's Architecture section.

- README's "Run your own" and AGENTS.md's dev workflow install with `npm ci` (the committed lockfile) instead of
  `npm install`, for the same reason as the Dockerfile.

## 0.3.10

- `/address/:a` reads one row of the new table `address_totals` instead of summing every output and counting every
  history row of the address on each call. Anyone can add outputs to any address cheaply, and the old read grew with
  them while holding a connection of the pool the block writer and the resolver's reads share. The answer is
  unchanged, byte for byte: funded, spent, balance, `tx_count` (distinct txids in the address's history) and
  `utxo_count`, as 0.3.9's scan computed them. `/analytics/supply` and the plain-text supply routes read the zero
  address's balance (the burned figure) through the same function, so they read that one row too.
- The table is kept the way `coinbase_totals` is: rebuilt from the rows at every start of either backend, and kept
  equal to that aggregate inside every `writeBlock` and `unwindAbove` transaction, under one Postgres lock on both
  tables. A block write reads its height's share of the aggregate before its clear and after its writes and moves the
  table by the difference, one upsert per address that changed; an unwind subtracts the share above the ancestor. A
  repeated txid writes no row (0.3.9), so it changes no total.
- Each sum is held as two columns, the sums of value >> 32 and of value & 0xFFFFFFFF, so funded and spent stay exact
  past 2^63 (on SQLite 0.3.9's scan failed for such an address; on Postgres it answered the same figure). The start's
  rebuild reads every `outputs` and `address_history` row once: on a loaded test host, for 1,000,000 outputs and
  1,500,000 history rows, 1.8 s on Postgres and 8.3 s on SQLite, where the `coinbase_totals` rebuild took 1.7 s and
  17.1 s on the same rows.
- `test/address-totals.test.ts`: seeded walks of writes, re-writes and unwinds with spends and repeated txids compare
  the table with the aggregate after every step and `/address/:a` with 0.3.9's answer for every address; the same
  through `syncOnce` and two reorgs on the repeat chain; sums past 2^63; a start's rebuild; a writer waiting for
  another process's rebuild on Postgres; the maintenance reads' indexes; the route's cost for an address of 50,000
  outputs against one of one output. `test/_repeat-chain.ts` dumps the table, so the first-occurrence suites compare
  it with a fresh index too. `test/address-utxo.test.ts`, `test/json-safe-read.test.ts` and `test/analytics.test.ts`
  (whose burn figure reads the table) write rows by hand and start the store again before they read, as a
  deployment's start rebuilds the table.

- The live gate `test/_live_check.mjs` pages the coinbase payee's history (`/address/:a/txs`, then
  `/address/:a/txs/chain/:last_seen_txid`) down to the height of the coinbase's first occurrence, at most 4,000
  pages. It read only the first page (25 newest), so on a correct index it failed when the checked block's coinbase
  was first held more than a page of that payee's history earlier, as a miner's repeated coinbase is
  (`test/live-check.test.ts`: 30 blocks back now passes; a history without the coinbase fails, also when the next-page
  route answers the first page again).

- `test/first-occurrence.test.ts` pins `/block/:hash/txs` to the block's own order where a repeated txid's first
  position is higher than a later transaction's position in the repeating block (ordered by the rows' positions the
  suite passed on SQLite). No code change.

- CI runs on Node 26 (`.github/workflows/ci.yml`, both jobs), the version the maintainers' host runs since
  2026-11-12; AGENTS.md says so. `engines` stays `>=22` (what `node:sqlite` needs); no dependency or lockfile change.

- On Postgres the start's rebuild of `coinbase_totals` and `address_totals` runs without the pool's 30 s statement
  timeout (`SET LOCAL statement_timeout = 0` in its own transaction). The rebuild reads every `outputs` and
  `address_history` row, which grows with honest use and with rows anyone can add, and under the cap it failed every
  start once it took longer. Every other statement keeps the 30 s cap (`test/boot-rebuild-timeout.test.ts`: a store
  opened with a 100 ms timeout starts over 300,000 rows of each, and a read on that connection is still cut off).

- The Dockerfile builds on `node:26-slim` (was `node:22-slim`), the major CI tests.

## 0.3.9

- A transaction id keeps the place of its first occurrence: the lowest height the indexed chain holds it at and its
  position in that block (the rule of csd-sdk `packages/cairnx/CONVENTION.md` section 32, M4). When a block holds a
  txid that `txs` already holds, from a lower height or from earlier in the same block, `writeBlock` lists that
  position in the new table `tx_repeats` and writes nothing else: the rows in `txs`, `outputs`, `proposals` and
  `attestations` stay where they are, no spend marker and no `address_history` row is written, and the event stream
  carries no second proposal or attestation event. Before, the later block's write moved the one row to its own
  height. An output keeps its first spender. `/tx/:id`, its status and proof, the address lists, `/proposals`,
  `/attestations` and the per-domain and per-proposal lists therefore name one place per txid, the same at every
  snapshot, and after an unwind and replay every table equals a fresh index of the chain that is left.
- A block's transaction list is complete. `/block/:hash/txids`, `/block/:hash/txs` and the list a merkle proof is
  built from read `txs` and `tx_repeats` together, so each block that holds a txid lists it at its position and the
  proof of any transaction folds to the header root of its block. In `/block/:hash/txs` the row of a txid first held
  by an earlier block is that transaction's one row, with the earlier height and position.
- `tx_repeats(height, pos, txid)` is created at start on an existing database of either backend, with no manual step
  and no change to a stored row. On a chain where no txid is held twice it stays empty, and the rows, the API answers
  and the events are what 0.3.8 gives. A block write issues one more statement than before, the `tx_repeats` clear of
  its height; per transaction the count is unchanged (one primary-key read on `txs` takes the place of one
  coinbase-totals read).
- Not changed: an output a later occurrence creates again stays one row in its first state, so balances, the unspent
  list, `coinbase_totals` and the supply figures count it once. With `CSD_INDEX_FROM` above 0 the indexer holds
  nothing below that height, and first means first at or above it (README "Honest limits").
- `test/first-occurrence.test.ts` (through `syncOnce` against a mock node: the place in every table, one event, whole
  blocks and folding proofs, and the tables after each reorg against a fresh sync; seeded walks of writes and unwinds
  against a fresh index; a database created before the table), `test/first-occurrence-floor.test.ts`, and
  `test/coinbase-totals.test.ts`, whose case for a coinbase held again now checks that its first outputs stay counted.
- The live gate `test/_live_check.mjs` checks a txid that block tip-2 holds again at its first occurrence: the
  served proof must name an earlier block or position and verify against that block's node header, and the node's
  block tip-2 must hold the txid at its position. Before, it wanted every proof to name block tip-2 and failed on a
  correct index (`test/live-check.test.ts` runs it against a mock node, on correct and on altered indexes).
- AGENTS.md and the `writeBlock` comment say that `syncOnce` writes no height below the stored tip only while the
  `meta` tip pointer is at most one below the highest stored block; nothing in `src/` sets it lower, and a pointer
  deleted or set back by hand over stored blocks makes `syncOnce` rewrite stored heights in place. No code change.
- Dependencies: `body-parser` 1.20.9 and `qs` 6.16.2 (both through express) in `package-lock.json`; `package.json`
  is unchanged.

## 0.3.8

- The domain and uri of a Propose are text its author chooses. The indexer now stores and serves each U+0000 in them as
  U+0001, the same on SQLite and Postgres, and the rows, the API and the event stream carry that one string
  (`storableText` in `src/decode.ts`, applied where `src/rpc.ts` reads a block). JSON refuses U+0001 unescaped as it
  does U+0000, so the stored text parses as JSON exactly when the node's does, and a domain keeps its other characters.
  Text without U+0000 is stored and served as before. `test/storable-text.test.ts`.
- The reconcile gate `test/_reconcile.mjs` compares the node's per-domain counts with the indexer's after the same
  replacement, adding up node domains that share one stored form.

## 0.3.7

- CI: every job runs on `ubuntu-24.04` instead of `ubuntu-latest`. GitHub moved `ubuntu-latest` to 26.04, where
  playwright-core refuses to install its headless shell (cairn's CI failed at that step on 2026-11-05).
  `test/ci-workflow.test.ts` refuses a job on a `-latest` image.
- `/health` gains `build` (`commit`: the first 7 characters of the checkout's HEAD this process loaded, as cairn's
  `/api/health` gives it, read once at start; `startedAt`) and `checkpoint_floor` (the unwind floor in force), so a
  live query tells a tag from a later commit and shows which floor a process holds. The commit is read with a command-scope `safe.directory`, since a service user that does
  not own the tree gets "dubious ownership" from git otherwise, and is `unknown` when git or the checkout is missing.
  `test/health.test.ts`.
- CI's exact-pin step checks csd-crypto as well as csd-codec and csd-light; a caret on csd-crypto (the signer and
  payee address derivation) passed it. `test/ci-workflow.test.ts` runs the step's script on this package.json and on
  a copy with each of the three floated.
- The explorer called every issuer-mint token "fixed supply" (home card) and "Fixed supply: only the issuer could mint
  (no dilution)" (token page), and a deploy record "issuer-mint (fixed)", though cairnx lets the issuer mint up to the
  max supply. It now follows the rule of /trade's token cards: "fixed supply" only once an issuer-mint token is minted
  to its max, otherwise "issuer mint", and the token page says how much more the issuer can mint. Open mint is
  unchanged. `test/explorer-browser.test.ts`.
- `GET /address/:a` gains `chain_stats.utxo_count` (the unspent outputs, counted in the same pass over the address's
  outputs that sums funded and spent, which were two queries before), and the explorer's address page shows it
  instead of reading `/address/:a/utxo` only to count the rows. `/address/:a/utxo` answers at most 1,000 rows a call,
  in (block height, txid, vout) order, with `after=<block_height>:<txid>:<vout>` for the next page; it answered up to
  100,000 rows a call, so an address built with many small outputs made every call serialise its whole set on the
  indexer's event loop. A caller that reads the whole set must now follow `after` (cairn-sdk's `addressUtxo` reads
  one call). The row shape is unchanged. `test/address-utxo.test.ts`, and the
  explorer browser test checks the page makes no `/utxo` read.
- `/analytics/richlist` reads the top 500 holders once per tip and answers each `?limit` with a slice of it; each
  distinct limit from 1 to 500 was a full `GROUP BY` scan of the unspent outputs per tip, so a caller varying the
  limit could run 500 scans a block. The answer for every limit is unchanged. `memoByTip` caches the computation's
  promise before it settles, so concurrent reads at a new tip (every open explorer tab, `/health`'s counts,
  `/domains`) share one scan instead of each running it, and drops a rejected one, so a failed read is not kept for
  the tip. `test/analytics-memo.test.ts`; `test/analytics.test.ts` now also pins that a store error on the supply
  query answers the plain-text supply routes with 500 and no number, and that the empty index's 503 is `text/plain`.
- A WebSocket client could end the indexer process, the sync loop with the API: a subscribe frame of `null`, or
  with `track-domain` or `track-address` not an array, threw in the message handler, and a frame ws refuses (one
  that is not UTF-8) was emitted as an `error` with no listener. The handler now ignores a frame that is not a JSON
  object and a field that is not an array, closes only its own socket (1011) if handling still throws, and every
  socket, one refused over the client cap (1013) included, gets an `error` listener before anything else. Frames are capped at 64 KiB by ws's `maxPayload` (closed with 1009 before they
  are buffered; the default was 100 MiB, checked only after buffering). `test/stream.test.ts` runs these against a
  server in a child process.
- `GET /analytics/supply/total` and `GET /analytics/supply/circulating`: the total and circulating supply in whole CSD
  as a bare `text/plain` number, exact (bigint math, trailing zeros trimmed), the form CoinMarketCap asks a listing to
  serve; an empty index answers 503 without a number. Total supply is emitted supply less the unspent balance of the
  zero address, which the genesis coinbase pays and nobody holds a key for; circulating supply equals the total, since
  CSD launched by proof of work with no premine and no reserve wallets. `/analytics/supply` gains `burned_supply`,
  `total_supply` and `circulating_supply` (base units, as `emitted_supply`); its other fields are unchanged.
  `test/analytics.test.ts`, `test/analytics-memo.test.ts`.

## 0.3.6

- The explorer takes the site's shell parts by name (Plan 89 wave R11): its tab icons are the site's (the Cairn mark,
  cairn's `/favicon-32.png`, `/favicon.svg` and `/apple-touch-icon.png`) instead of its own green squares, and its
  content sits in the site's one column, cairn's `--page-max` (1280 px) with `--page-pad` inside it, instead of its own
  1200 px. Through the front door its edges are now the header's at every width (measured with cairn's shell: 16, 24,
  104 and 344 px at 390, 1280, 1440 and 1920; before, 40 px inside the header on desktop). On a direct indexer hit the
  column is 1280 px with 24 px inside, and the icons are absent. `test/explorer-shell-parts.test.ts`.
- The page-layer test also rejects a sibling combinator or a :root rule that leads out of the explorer.

## 0.3.5

- The explorer's stylesheet no longer restyles cairn's shell. Its rules sit in the `page` cascade layer, which outranks
  the shell's `components` layer whatever the specificity, so its element rules reached the first-visit Terms dialog:
  `button` drew "Agree and continue" in the button's own colour (an invisible label, both themes), `h2` shrank the
  title to 15 px and `:focus-visible` squared the dialog's corners. Every rule outside the tokens layer now starts from
  the explorer's content, `:where(.ex-wrap)` (no change in specificity), or from its own classes and ids. Through cairn's
  front door the explorer's content is unchanged (a computed-style diff of every element: 9 routes, both themes,
  1280 and 390 px, 0 differences), and the shell draws as on cairn's other pages: the Terms dialog, and the footer's
  toggle and theme buttons, which took the page's link and button rules before. The standalone brand keeps its hover
  underline and focus ring. `test/explorer-page-layer.test.ts` reads every style block and fails on a selector that
  reaches outside the explorer.

## 0.3.4

- `GET /address/:a/coinbase` and `GET /miners/coinbase?limit=N` (#17): lifetime coinbase totals per address from a
  maintained table, `coinbase_totals`, kept equal to the aggregate over `outputs` and `txs` inside every block write
  and unwind and rebuilt from the rows at every boot (about 0.3 s on Postgres at mainnet size), so a read is one row,
  for cairn's miner statistics (cairn #145). SQLite transactions begin IMMEDIATE, so a
  writer waits for another process's write lock instead of failing.
- The explorer on cairn's shell and the design direction (#16, #18): the site header, theme and tokens from cairn's
  origin (a fallback block on a direct hit), measured against the approved preview; a failed or rate-limited read is
  the failed state, never a miss or a verdict; every resolver read through one function with four outcomes.
- The explorer's verdicts come only from `/cairnx/records`: a failed or missing chunk leaves its records unread
  instead of falling back to the cached `/cairnx/log` (which could replace a current refusal with an old applied
  verdict), and a failing `/blocks/recent` is the failed view instead of a block-by-block read (the close review's
  second read of its removals).

## 0.3.3

- `GET /proposals` and `GET /attestations` (#14): `after` now needs the hashed snapshot `at=<height>:<hash>` and
  answers 400 without it (no `at`, or `at=<height>` alone), since a height-only snapshot cannot detect a reorg and a
  walk across one mixed the new chain's rows with the orphaned ones.
- The explorer (#14) words a CairnX Propose line with its effect ("Minted", "Finalized name") only when the resolver
  applied the record; without a verdict (standalone, or the read failing) it reads as the request, a refused record
  struck through.
- Tests only: each test database under `/tmp` is removed with its `-wal` and `-shm` files when the test process
  exits (`test/_tmpdb.ts`); two tests that pinned no behaviour are gone, and the `/domains` and `/address/:a` reads
  they hit moved to `test/json-safe-read.test.ts`.

## 0.3.2

- `GET /blocks/at-or-after/:time`: the lowest-height block whose time is at or after `time`, with the tip height,
  over a new `blocks(time, height)` index (created at start on both backends).
- `GET /proposals` and `GET /attestations`: every proposal or attestation, or those of one domain, in chain order
  (height, then position in the block), paged under a snapshot block with a keyset cursor; a reorg at or below the
  snapshot answers 409. These are the reads cairn's chain scanner served (its Uplink tally and publisher, network
  figures and legacy projection).
- The explorer (`public/explorer.html`, #12) words an Attest on a CairnX offer or bid by the resolver's verdict
  (`/cairnx/record`): "Bought", "Cancelled", "Reserved" only when CairnX applied it, a request line otherwise, a refused
  record struck through with its reason; the "★ primary" badge from the resolver's primary pick; token-priced amounts
  scaled by the token's decimals or labelled base units; the token note no longer calls delivery atomic.

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
