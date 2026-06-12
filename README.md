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

It's safe to trust because **you don't have to**: the explorer re-checks every proof *in your own
browser* against the proof-of-work block headers, and anyone who runs their own indexer against the
same node gets byte-for-byte identical data. There's nothing to take on faith.

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
| `CSD_INDEX_PG` | *(unset)* | a Postgres URL — set it to use Postgres instead of SQLite (see below) |
| `CSD_INDEX_PG_SCHEMA` | `public` | Postgres schema (namespace) for the tables |
| `CSD_INDEX_PG_POOL` | `10` | Postgres connection-pool size |
| `CSD_INDEX_LISTEN` | `127.0.0.1:8793` | where the explorer + API listen |
| `CSD_SWARM_GATEWAY` | `http://127.0.0.1:8791` | a content server, for showing post contents (optional) |
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

**Postgres (the scale path)** moves queries onto a connection pool — reads keep flowing while
blocks are written. Cut over by re-indexing from genesis (it's fast; there is deliberately no
sqlite→pg copy tool, because a fresh replay IS the integrity check):

```
createdb csd_index
CSD_INDEX_PG=postgres://user:pass@127.0.0.1:5432/csd_index npx tsx src/cli.ts index   # backfill
CSD_INDEX_PG=postgres://user:pass@127.0.0.1:5432/csd_index npm run run-all            # serve
```

Both backends produce identical API responses — the test suite runs the same 37 tests against
each, and a from-genesis reindex of mainnet matches row-for-row across backends.

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
- `GET /content/0x<hash>` - the off-chain content for a post, re-verified against its on-chain hash.
- `GET /registry/peers`, `/registry/gateways`, `/identity/:handle` - name → address lookups and
  network directories that anyone can recompute and get the same answer.

## The explorer

A single self-contained page (no build step) with a live block feed, and pages for blocks,
transactions, addresses, proposals, and categories. The key feature: on a transaction page it
**re-verifies the merkle proof in your browser** against the proof-of-work header, and on a proposal
page it **re-hashes the content** to confirm it matches the chain - so the page trusts the indexer
for nothing it can check itself.

## Honest limits

The indexer is a **convenient view of the chain, not an authority**. Inclusion proofs are trustless
(your browser/light client re-checks them against proof-of-work). The derived data - per-attester
breakdowns, rankings, address history - is **reproducible rather than signed**: the way you audit it
is to run your own indexer and confirm you get the same numbers. SQLite comfortably handles one
indexer with many readers. MIT licensed.
