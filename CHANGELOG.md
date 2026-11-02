# Changelog

## Unreleased

- The explorer called every issuer-mint token "fixed supply" (home card) and "Fixed supply: only the issuer could mint
  (no dilution)" (token page), and a deploy record "issuer-mint (fixed)", though cairnx lets the issuer mint up to the
  max supply. It now follows the rule of /trade's token cards: "fixed supply" only once an issuer-mint token is minted
  to its max, otherwise "issuer mint", and the token page says how much more the issuer can mint. Open mint is
  unchanged. `test/explorer-browser.test.ts`.
- `GET /address/:a` gains `chain_stats.utxo_count` (one index-backed count of the unspent outputs), and the explorer's
  address page shows it instead of reading `/address/:a/utxo` only to count the rows. `/address/:a/utxo` answers at
  most 1,000 rows a call, in (block height, txid, vout) order, with `after=<block_height>:<txid>:<vout>` for the next
  page; it answered up to 100,000 rows a call, so an address built with many small outputs made every call serialise
  its whole set on the indexer's event loop. A caller that reads the whole set must now follow
  `after` (cairn-sdk's `addressUtxo` reads one call). The row shape is unchanged. `test/address-utxo.test.ts`, and the
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
  socket has an `error` listener. Frames are capped at 64 KiB by ws's `maxPayload` (closed with 1009 before they
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
