# csd-indexer: a block explorer and data API for Compute Substrate

The Compute Substrate (CSD) node keeps its built-in API deliberately minimal. It can't tell you
"every transaction that touched this address", "who attested to this proposal", or give you a
proof that a transaction is in a block. csd-indexer fills that gap.

It reads the blockchain into a regular database and serves it back as:

- A web block explorer: browse blocks, transactions, addresses, and proposals, with a live feed of
  new blocks. Open it and look around; no account needed.
- A developer data API: address history, balances and unspent coins, per-attester data, and merkle
  inclusion proofs that let a light client (or your browser) prove a transaction is really in the
  chain.

You don't have to take it on faith: a light client checks the merkle proofs against proof-of-work
block headers it verifies itself, and anyone who runs their own indexer against the same node gets
byte-for-byte identical data.

## Run your own

```
npm ci                                            # the committed lockfile, exact versions
CSD_RPC=http://127.0.0.1:8789 npm run run-all     # index the chain + serve the explorer/API
# explorer + API on http://localhost:8793
```

Or with Docker:

```
docker build -t csd-indexer .
docker run -p 8793:8793 -v csd-index:/data -e CSD_RPC=http://host.docker.internal:8789 csd-indexer
```

| Setting | Default | Meaning |
|---|---|---|
| `CSD_RPC` | `http://127.0.0.1:8789` | the CSD node to read from |
| `CSD_INDEX_DB` | `./csd-index.db` | the database file (SQLite; no native build needed) |
| `CSD_INDEX_PG` | *(unset)* | a Postgres URL, set it to use Postgres instead of SQLite (see below) |
| `CSD_INDEX_PG_SCHEMA` | `public` | Postgres schema (namespace) for the tables |
| `CSD_INDEX_PG_POOL` | `10` | Postgres connection-pool size for the API's reads (the block writer has one more connection of its own) |
| `CSD_INDEX_LISTEN` | `127.0.0.1:8793` | where the explorer + API listen |
| `CSD_INDEX_FROM` | `0` | first block to index |
| `CSD_CONFIRMATIONS_FINAL` | `6` | confirmations at which `/tx/:id/status` says `final` and an event says `confirmed` (a deeper reorg is still followed) |

It tracks the chain continuously and handles reorgs safely: if the network reorganizes, the
indexer rewinds the affected blocks and replays the correct ones, so the data always matches the
real chain.

### SQLite or Postgres?

SQLite (the default) needs zero setup and is perfect for one operator, CI, or re-running the
index to audit determinism. Its limit is concurrency: `node:sqlite` is synchronous, so every
query blocks the event loop and concurrent API readers serialize behind each other (and behind
the block writer). Fine for tens of users; not for hundreds.

Postgres (the scale path) moves queries onto a connection pool, reads keep flowing while
blocks are written. Cut over by re-indexing from genesis (it's fast; there is deliberately no
sqlite-to-Postgres copy tool, because a fresh replay is the integrity check):

```
createdb csd_index
CSD_INDEX_PG=postgres://user:pass@127.0.0.1:5432/csd_index npx tsx src/cli.ts index   # backfill
CSD_INDEX_PG=postgres://user:pass@127.0.0.1:5432/csd_index npm run run-all            # serve
```

Both backends produce identical API responses, the test suite runs against each, and a
from-genesis reindex of mainnet matches row-for-row across backends.

## The API

A path or query parameter that does not percent-decode, or that holds U+0000 (`%00`), answers 400
`{"error":"bad request"}` on every route.

Standard explorer endpoints (the widely used Esplora shape, so existing tools work):
- `GET /blocks/tip/height` (503 while the index is empty), `/blocks/tip/hash`, `/blocks/recent`
- `GET /block/:hash[/txids|/txs]`, `/block-height/:h`
- `GET /tx/:id[/status]`: `final` is true at `CSD_CONFIRMATIONS_FINAL` (6) confirmations or more; the indexer still
  follows a deeper reorg, so it is a depth, not a guarantee
- `GET /address/:a` (its `chain_stats` also carry `utxo_count`, the number of unspent outputs; read from one row the
  block writer keeps per address, so its cost does not grow with the address's outputs), `/address/:a/txs`,
  `/address/:a/txs/chain/:last_seen_txid` (the next page), `/address/:a/utxo`: at most 1,000 unspent outputs in
  (block height, txid, vout) order; pass `after=<block_height>:<txid>:<vout>` of the last row for the next page, and
  a page shorter than 1,000 is the last (a malformed `after` is 400). A client that reads only the first answer gets
  the first 1,000. The pages are not a snapshot: between calls a new block or a reorg can add, spend or remove rows
  below or above the cursor.
- `GET /address/:a/coinbase`: lifetime count and sum of the coinbase outputs paying the address on the indexed
  chain, with `indexed_height`; 400 on a malformed address, 503 on an empty index.

The extras:
- `GET /tx/:id/merkle-proof`: a proof you can fold yourself to confirm the transaction is in its
  block (this is what light clients and the in-browser verifier use).
- `GET /proposal/:id` and `/proposal/:id/attestations`: a proposal and the individual attestations
  behind it (the node only gives totals), paginated with `limit`, `after_height` and `after_txid`.
- `GET /domains`, `/domain/:d/proposals`: browse posts by category.
- `GET /blocks/at-or-after/:time`: the lowest-height block whose time (unix seconds) is at or after
  `time`, as `{ height, hash, time, tip_height }`, or 404 when there is none. Block times are not
  monotonic, so this is not the block after the last one at or before `time`. The indexer indexes to
  the tip: a caller that wants the block buried N deep checks `height <= tip_height - N`.
- `GET /proposals` and `GET /attestations`: every proposal or attestation in chain order (height,
  then position in the block), each row with its `pos`; `domain=` keeps the proposals of one domain
  and the attestations of that domain's proposals. Answers `{ at, rows, next }`, at most `limit`
  rows (default and cap 1000), only rows at or below the snapshot block `at`. Pass `at=<height>` (or
  nothing, for the tip) on the first page, then `at=<height>:<hash>` from the answer and `after=` set
  to `next` until `next` is null. A reorg above the snapshot leaves the walk unchanged; one at or
  below it makes the next page answer 409, and the walk starts again. A malformed `at` or `after` is
  400, a position above 2^31 - 1 included (a block holds at most 2,000 transactions), and so is
  `after` without `at=<height>:<hash>` (a height-only snapshot cannot detect a reorg); an empty index
  is 503.
  - Without `format`, or with `format=1`, a proposal row is `{ txid, domain, payload_hash, uri, expires_epoch,
    proposer, fee, height, time, pos }` and an attestation row `{ txid, proposal_id, attester, score, confidence,
    fee, height, time, pos }`. Any other `format` is 400.
  - With `format=2` the answer is `{ format: 2, at, rows, next }` and each row also carries `outputs`: its
    transaction's outputs in output order, `[{ addr, value }]`, one entry per output (two outputs to one address are
    two entries; a transaction without outputs has `[]`). `addr` is the address as `/tx/:id` gives it (`0x` and 40
    lowercase hex), or null for an output whose script is no address; `value` is in base units. The rows and their
    outputs are one read of the chain the snapshot `at` names, so a walk under one `at=<height>:<hash>` gets the
    outputs of the same transactions as its rows, and `limit` counts rows (a row's outputs are never split across
    pages).
  - Integers in either format, `value` included, are a JSON number up to 2^53 - 1 and a decimal string above it.
    An `expires_epoch` above 2^53 - 1 is stored as 2^53 and travels as the string `"9007199254740992"` in both
    formats.
- `GET /address/:a/reputation`: aggregates over the address's newest 200 attestations; past that the
  answer says `truncated: true` and names the window.
- `GET /miners/coinbase?limit=N`: the same totals for every address, most outputs first (limit 1 to 1000,
  default 1000).
- `GET /analytics/miners?window=`, `/analytics/richlist?limit=`, `/analytics/supply`,
  `/analytics/series?window=&points=`: miner shares and hashrate, the largest holders, supply and
  emission, and time series.
  `/analytics/supply` gives each supply figure in base units as a decimal string: `emitted_supply`
  (coinbase outputs less fees), `burned_supply` (the unspent balance of the zero address
  `0x0000000000000000000000000000000000000000`, which the genesis coinbase pays and nobody holds a
  key for), `total_supply` (emitted less burned) and `circulating_supply` (equal to the total: CSD
  launched by proof of work with no premine and no team, locked or reserve wallets).
- `GET /analytics/supply/total` and `/analytics/supply/circulating`: only that figure in whole CSD,
  as `text/plain` (for example `6553149.49800771`, or `6553150` when whole), exact to the base unit,
  for listing sites such as CoinMarketCap. An empty index answers 503 and an error 500, never a
  number.
- `GET /health`: version, backend, indexed height, the node-reported tip and chainwork, and `stale`; `build`
  (`commit`, the first 7 characters of the checkout's HEAD this process loaded, or `unknown`, and `startedAt` in
  milliseconds), read once at start, so a pull without a restart shows as a mismatch with the tree; and
  `checkpoint_floor`, the height below which this process does not unwind.
  The tip fields come from the node and are not proof-of-work checked by the indexer: use them as a
  liveness hint, not to pick a fork.

Live updates:
- Server-sent events: `GET /stream/all` (every event), `/stream/blocks`, `/stream/domain/:d`.
- WebSocket `/ws`: send `{"track-all": true}`, or `{"track-domain": [...]}`, `{"track-address": [...]}`,
  `{"track-proposal": id}`. Over the WebSocket, block events go only to track-all clients; `track-domain` delivers that
  domain's proposals, `track-proposal` the attestations on that proposal and `track-address` the attestations that
  address made (not its payments); every client gets reorg events. Each subscribe is
  acknowledged with what the socket now tracks; a frame that is not a JSON object is ignored, a field that is not
  the documented array adds nothing, a key longer than any the chain carries (a domain over 128 UTF-8 bytes, an
  address over 42 characters, a proposal id over 66) adds nothing, and a frame over 64 KiB or one that is not valid
  WebSocket closes that socket (1009, 1007). A client of the WebSocket or of an SSE stream that stops reading is dropped
  once more than 4 MiB (the default) is queued for it. A WebSocket ping is answered with a pong carrying its payload
  when nothing is queued for that socket; a client still receiving a large ack can miss one, so a keepalive should
  tolerate a missed pong.
- The streams are a hint, not a record: events carry no id, a reconnect replays nothing, a block written while no
  one listened (or before a restart) sends nothing later, and a block written more than `CSD_CONFIRMATIONS_FINAL` + 5
  below the node's tip (a catch-up) sends none. The complete read is the chain-order feeds (`/proposals`,
  `/attestations`) from a cursor.

## The explorer

A single-file page (no build step) with a live block feed, and pages for blocks,
transactions, addresses, proposals, and categories. On a transaction page it folds the merkle
proof in your browser and checks that it matches the merkle root of the block header the same
indexer reports: a consistency check, not a proof-of-work check (for that, use the L0 light client).
On a proposal page served through the front door it fetches the content from the front door's
`/content` and hashes it in your browser, calling it verified only when that hash matches the
on-chain payload hash.
Through the front door a CairnX record, a fill or a cancel among them, reads by the CairnX resolver's verdict:
the chain mines a paid fill whose delivery CairnX refuses, and the explorer shows that one as having no effect.
A record names its effect ("Minted", "Finalized name", "Bought") only when the resolver applied it; a standalone page, or
one whose verdict read failed, words it as the request it is ("Mint request for", "Fill request on"), and the page says
in one line that the verdicts could not be checked.
When the indexer is behind the node, its newest block is old, or it does not answer, a badge beside the search says
which. A record the indexer does not hold reads "Nothing found"; a read that fails, the front door's rate limit
included, reads as a failure, with a way to try again. The same holds for what the page asks the resolver: a name reads "Not registered" only when the resolver says
nobody holds it, and a token "No token with that ticker" only when the resolver has none; when the resolver does not
answer the page says it could not check, never that a name is free. A search that is no block, transaction, address
or name opens a category only when this indexer holds one by that name, and otherwise says that nothing matches.

Served through the cairn front door (https://cairn-substrate.com/explorer) it also shows the CSD price in USD
with the venue and time beside every figure, and charts of the emission schedule, the CSD/USD price, the network
hashrate and recent block times, drawn by the front door's chart module, a registered name's identity avatar, and a
token's listing badge from the front door's list of the tokens Cairn lists (a display convenience, not a consensus
claim). A standalone instance shows the same chain figures without the USD figures, charts, avatars and badges.

## Honest limits

The indexer is a convenient view of the chain, not an authority. Inclusion proofs are trustless
when a light client checks them against proof-of-work headers it verified itself; the explorer only
checks them against the indexer's own headers. The derived data (per-attester
breakdowns, rankings, address history) is reproducible rather than signed: the way you audit it
is to run your own indexer and confirm you get the same numbers. The indexer reads blocks from one node at a time
and does not check a block's transactions against its header: with several backends configured, another backend
replaces the first only with proof-of-work headers above a block the first, or the index, already holds, and is then
trusted as the first was. A proposal's `domain` and `uri` are the
node's text with one change, on both backends: each U+0000 is stored and served as U+0001. JSON refuses both
characters unescaped, so a uri is JSON here exactly when it is JSON on the chain; a consumer that compares a row with
the node's bytes applies the same replacement first, and a `domain` or `uri` that holds U+0001 here may hold U+0000
on the chain, so a hash over the text is checked against the node's bytes. A transaction id that two blocks hold is
one transaction here, placed at its first occurrence (the lower height and its position in that block) in every
route, the proposal and attestation feeds and the event stream included; the later block adds no event. Both blocks
list it (`/block/:hash/txids`, and `/block/:hash/txs`, where its row is the transaction's one row and so carries the
first block's height and position), so the merkle proof of any transaction folds to the header root of its block. Its
outputs keep their first state: an output a later occurrence creates again is counted once in balances, the unspent
list and the coinbase totals, and keeps its first spender. With `CSD_INDEX_FROM` above 0 the indexer holds nothing
below that height, so first means first at or above it. SQLite serves tens of readers, not
hundreds (see SQLite or Postgres above). `/analytics/miners` credits a block to the address its coinbase names (the
signer of its first input, else its first output), which the miner chooses: the shares are a display figure, not
proof of who mined. MIT licensed.
