# csd-indexer — Compute Substrate Indexer + Explorer (L2)

> A standalone, reorg-safe indexer that serves what the deliberately-thin CSD node RPC omits —
> **merkle inclusion proofs, per-attester data, address history, content joins** — behind the
> well-trodden **Esplora REST contract**.
> **L2** of the [no-fork ecosystem roadmap](../cairn/docs/ecosystem/03-indexer-explorer.md). No fork, no token, no new on-chain data.

The node RPC is thin on purpose. It gives aggregates (`/oracle`, `/domains`), current UTXOs, and
raw blocks — but not *who* attested what, not "every tx touching this address," and **no merkle
proof endpoint** (the one thing the [L0 light client](../csd-sdk) needs to verify inclusion). So we
read consensus directly into a relational store and re-serve it. **Every claim is a derived view —
trust comes from the light client re-verifying the merkle proofs, and from anyone re-running the
indexer and getting byte-identical data** (determinism is the audit).

## How it works

```
CSD node (RPC)  ──/block/height/:h──▶  SCAN    (forward-only; one tx-list per block, in order)
                                       RESOLVE  (inputs ↔ our OWN outputs table → fees, spends, UTXO)
                                       STORE    (relational, height-tagged: blocks/txs/outputs/
                                                 address_history/proposals/attestations)
                                       REORG    (broken prev-link → unwind WHERE height>ancestor → replay)
client / light  ◀── REST + proofs ──   SERVE    (Esplora contract + merkle-proof + CSD extras)
```

The scan resolves each input against the indexer's **own** `outputs` table (every prior block is
already indexed, in order), so fees, spend-tracking, address deltas and UTXO sets need **zero extra
RPC** — the electrs/Esplora UTXO model. Everything carries `height`, so a reorg is
`DELETE … WHERE height > ancestor` + un-spending outputs orphaned by the rolled-back branch, then a
clean idempotent replay (the electrs/Subsquid pattern). Blocks deeper than `CONFIRMATIONS_FINAL` are
treated as final and never unwound.

## Run

```
npm install
CSD_RPC=http://127.0.0.1:8790 npm run run-all      # continuous indexer + API in one process
# or, separately:
npm run index                                       # one sync pass to the tip, then exit
npm run serve                                        # serve the API over the existing DB
```

| env | default | meaning |
|---|---|---|
| `CSD_RPC` | `http://127.0.0.1:8790` | node RPC (the data source) |
| `CSD_INDEX_DB` | `./csd-index.db` | sqlite file (node:sqlite — no native dep) |
| `CSD_INDEX_LISTEN` | `127.0.0.1:8793` | REST/streaming bind |
| `CSD_SWARM_GATEWAY` | `http://127.0.0.1:8791` | L1 swarm gateway for `/content` joins |
| `CSD_INDEX_FROM` | `0` | first height to index (raise to skip pre-CSD history) |
| `CSD_CONFIRMATIONS_FINAL` | `6` | reorg-immutable depth |
| `CSD_INDEX_BATCH` | `200` | blocks per persisted chunk |
| `CSD_INDEX_POLL` | `15` | continuous-loop poll interval (s) |

### Run your own (Docker)

```
docker build -t csd-indexer .
docker run -p 8793:8793 -v csd-index:/data \
  -e CSD_RPC=http://host.docker.internal:8790 \
  csd-indexer
# explorer + API on http://localhost:8793
```

Anyone running one against the same node gets byte-identical data — that reproducibility
*is* the audit. The explorer at `/` re-verifies every merkle proof **in your browser**
(SubtleCrypto, no trust in the indexer) and checks served content against its on-chain
`payload_hash`.

## API

**Esplora-compatible core** (existing clients + the light client work unchanged):
- `GET /blocks/tip/height`, `/blocks/tip/hash`
- `GET /block-height/:h` → hash · `GET /block/:hash[/txids|/txs]`
- `GET /tx/:id[/status]`
- `GET /address/:a[/txs[/chain/:last_seen]|/utxo]`

**CSD-specific extras (the reason this exists):**
- `GET /tx/:id/merkle-proof` → `{ block_height, pos, merkle:[…], merkle_root }` (Electrum format).
  Built from the stored ordered tx list via the **same** `merkleBranch` the L0 light client folds
  with `verifyMerkleProof` — prover and verifier share one convention by construction.
- `GET /proposal/:id[/attestations]` → the **per-attester** rows the node omits (aggregate-only on-chain).
- `GET /domains`, `/domain/:d/proposals`.
- `GET /address/:a/reputation` → attester-history rollup.
- `GET /content/0x<payload_hash>` → canonical bytes, proxied + cached from the [L1 swarm](../csd-swarm) (self-certifying).

## Tests

`npm test` (offline, deterministic — no node needed):
- **decode** — address recovery from a real on-chain `CSD_SIG_V1` script_sig + p2pkh script; app classification.
- **indexer** — a synthetic chain proves: coinbase/output indexing, spend→UTXO tracking, per-row
  Propose/Attest capture, merkle proofs folding to the stored header root, and — the core — a
  **reorg that unwinds orphaned blocks to EXACTLY the canonical state** (spends rolled back, rows
  removed, balances restored) followed by an **idempotent replay**.

Verified **live** against the running node (`test/_live_check.mjs`, `_reconcile.mjs`, `_browser_verify.mjs`):
- block hashes + `merkle` roots match the node exactly;
- **every served merkle proof verifies under the published L0 light-client convention** (and a
  tampered txid fails);
- the explorer's **in-browser SubtleCrypto verifier is byte-identical** to `csd-codec` on real blocks;
- per-attester rows served via HTTP reconcile to the node's aggregate for every domain;
- a from-genesis re-sync reproduces the node's own per-domain proposal/attestation aggregates exactly.

## Explorer

A self-contained SPA at `/` (phosphor-terminal aesthetic, no build step): home (live block feed via
SSE + network stats + top domains), block, tx (**in-browser merkle inclusion verification** against
the PoW header root), address (balance/UTXO/history), domain (proposals), and proposal (per-attester
breakdown + **in-browser content-integrity check** — served bytes hashed to the on-chain
`payload_hash`). The whole point: the page trusts the indexer for *nothing* it can re-verify itself.

## Honest limits

The indexer is a **derived, untrusted view**, not a consensus authority. Inclusion is trustless
(the light client re-verifies the merkle proof against a PoW-checked header); per-attester data and
rankings are **recomputable, not consensus-signed** — their integrity is "re-run it and diff." It
can't surface data the chain doesn't have (e.g. off-chain identity, until the L3 registries).
Content is resolved through the L1 swarm gateway, which self-certifies `sha256(bytes)==payload_hash`.
sqlite (single-writer) is plenty for one indexer + many readers; promote to Postgres only if
concurrent writers / `LISTEN`-NOTIFY streaming demand it. MIT.
