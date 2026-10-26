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
npm install
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
| `CSD_INDEX_PG_POOL` | `10` | Postgres connection-pool size |
| `CSD_INDEX_LISTEN` | `127.0.0.1:8793` | where the explorer + API listen |
| `CSD_INDEX_FROM` | `0` | first block to index |
| `CSD_CONFIRMATIONS_FINAL` | `6` | depth after which blocks are treated as final |

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

Standard explorer endpoints (the widely used Esplora shape, so existing tools work):
- `GET /blocks/tip/height` (503 while the index is empty), `/blocks/tip/hash`, `/blocks/recent`
- `GET /block/:hash[/txids|/txs]`, `/block-height/:h`
- `GET /tx/:id[/status]`
- `GET /address/:a`, `/address/:a/txs`, `/address/:a/txs/chain/:last_seen_txid` (the next page),
  `/address/:a/utxo`

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
  400, and so is `after` without `at=<height>:<hash>` (a height-only snapshot cannot detect a reorg);
  an empty index is 503.
- `GET /address/:a/reputation`: aggregates over the address's newest 200 attestations; past that the
  answer says `truncated: true` and names the window.
- `GET /analytics/miners?window=`, `/analytics/richlist?limit=`, `/analytics/supply`,
  `/analytics/series?window=&points=`: miner shares and hashrate, the largest holders, supply and
  emission, and time series.
- `GET /health`: version, backend, indexed height, the node-reported tip and chainwork, and `stale`.
  The tip fields come from the node and are not proof-of-work checked by the indexer: use them as a
  liveness hint, not to pick a fork.

Live updates:
- Server-sent events: `GET /stream/all` (every event), `/stream/blocks`, `/stream/domain/:d`.
- WebSocket `/ws`: send `{"track-all": true}`, or `{"track-domain": [...]}`, `{"track-address": [...]}`,
  `{"track-proposal": id}`. Over the WebSocket, block events go only to track-all clients.

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
is to run your own indexer and confirm you get the same numbers. SQLite serves tens of readers, not
hundreds (see SQLite or Postgres above). MIT licensed.
