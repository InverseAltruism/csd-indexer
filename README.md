# csd-indexer - a block explorer & data API for Compute Substrate

The Compute Substrate (CSD) node keeps its built-in API deliberately minimal. It can't tell you
"every transaction that touched this address", "who attested to this proposal", or give you a
**proof** that a transaction is in a block. csd-indexer fills that gap.

It reads the blockchain into a regular database and serves it back as:

- **A friendly web block explorer** - browse blocks, transactions, addresses, and proposals, with
  a live feed of new blocks. Open it and look around; no account needed.
- **A developer data API** - address history, balances and unspent coins, per-attester data, and
  **merkle inclusion proofs** that let a light client (or your browser) prove a transaction is
  really in the chain.

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

It tracks the chain continuously and handles reorgs safely - if the network reorganizes, the
indexer rewinds the affected blocks and replays the correct ones, so the data always matches the
real chain.

### SQLite or Postgres?

**SQLite (the default)** needs zero setup and is perfect for one operator, CI, or re-running the
index to audit determinism. Its limit is concurrency: `node:sqlite` is synchronous, so every
query blocks the event loop and concurrent API readers serialize behind each other (and behind
the block writer). Fine for tens of users; not for hundreds.

**Postgres (the scale path)** moves queries onto a connection pool, reads keep flowing while
blocks are written. Cut over by re-indexing from genesis (it's fast; there is deliberately no
sqlite→pg copy tool, because a fresh replay IS the integrity check):

```
createdb csd_index
CSD_INDEX_PG=postgres://user:pass@127.0.0.1:5432/csd_index npx tsx src/cli.ts index   # backfill
CSD_INDEX_PG=postgres://user:pass@127.0.0.1:5432/csd_index npm run run-all            # serve
```

Both backends produce identical API responses, the test suite runs against each, and a
from-genesis reindex of mainnet matches row-for-row across backends.

## The API

**Standard explorer endpoints** (the widely-used Esplora shape, so existing tools work):
- `GET /blocks/tip/height`, `/block/:hash[/txids|/txs]`, `/block-height/:h`
- `GET /tx/:id[/status]`
- `GET /address/:a[/txs|/utxo]`

**The extras that make it useful:**
- `GET /tx/:id/merkle-proof` - a proof you can fold yourself to confirm the transaction is in its
  block (this is what light clients and the in-browser verifier use).
- `GET /proposal/:id/attestations` - the individual attestations behind a proposal (the node only
  gives totals).
- `GET /domains`, `/domain/:d/proposals` - browse posts by category.

## The explorer

A single-file page (no build step) with a live block feed, and pages for blocks,
transactions, addresses, proposals, and categories. On a transaction page it **folds the merkle
proof in your browser** and checks that it matches the merkle root of the block header the same
indexer reports: a consistency check, not a proof-of-work check (for that, use the L0 light client).
On a proposal page served through the front door it fetches the content from the front door's
`/content` and **hashes it in your browser**, calling it verified only when that hash matches the
on-chain payload hash.

Served through the cairn front door (https://cairn-substrate.com/explorer) it also shows the CSD price in USD
with the venue and time beside every figure, and charts of the emission schedule, the CSD/USD price, the network
hashrate and recent block times, drawn by the front door's chart module. A standalone instance shows the same
chain figures without the USD figures and charts.

## Honest limits

The indexer is a **convenient view of the chain, not an authority**. Inclusion proofs are trustless
when a light client checks them against proof-of-work headers it verified itself; the explorer only
checks them against the indexer's own headers. The derived data - per-attester
breakdowns, rankings, address history - is **reproducible rather than signed**: the way you audit it
is to run your own indexer and confirm you get the same numbers. SQLite comfortably handles one
indexer with many readers. MIT licensed.
