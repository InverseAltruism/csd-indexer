# Incidents and the rules they left (csd-indexer)

Status: history with current rules. Moved from the "Gotchas and incident history" section of `AGENTS.md`, and from
the history inside its other bullets, on 2026-11-17. `AGENTS.md` keeps each rule where it applies and names the
narrative as "incident N", the numbers below. The narratives describe the dates they name and are not updated.

1. Node loss (2026-07-05): an upstream node was killed mid-reorg, lost its datadir, and resynced from genesis; the
   indexer saw the low tip "converge" at a buried height and hard-deleted about 41k rows. It produced the chainwork
   regression guard, the checkpoint floor and the multi-backend failover.
2. GRX-WIRE-CLAMP-1: `clampInt` saturating an `expires_epoch` above 2^53 to a safe integer made the indexer-fed
   resolver accept what SPV replay rejects, a canonicalState fork seam masked until V22. Rule: consensus-bound app
   integers feeding arithmetic or a range comparison go through `safeValue` or `safeEpoch`, never `clampInt`.
3. CAIRN-IDXREORG-1 and 2: a latched tip mismatch plus a node withholding deeper blocks could wipe the index to
   genesis. Fixed: unwind only on confirmed contiguous divergence.
4. Pagination data loss: the old height-only address-txs cursor dropped same-height txids and answered 500 on
   Postgres; it is now a (height, txid) keyset (`test/pagination.test.ts`).
5. The Postgres port bug class, to watch when touching SQL: coinbase vout 0xFFFFFFFF overflows int4; DISTINCT with
   ORDER BY random() is rejected; bind counts are strict; ORDER BY tie order depends on the engine (tie-break with txid
   or vout). node:sqlite has no `.transaction()` helper; `Store.tx` runs BEGIN and COMMIT by hand.
6. Explorer search dead through the front door: the proxy serves the explorer under a strict per-response nonce CSP
   (`script-src 'self' 'nonce-...'`), and a nonce never authorizes inline event-handler attributes. The search form's
   inline `onsubmit=` was silently blocked there while it worked on :8793 (fixed in db7b198). Rule: browser-test
   explorer changes through the front-door proxy, not only on a direct :8793 hit, and bind events with
   `addEventListener`, never inline handlers.
7. A hand-listed test set once silently dropped `analytics.test.ts`, the money math. Rule: `npm test` globs
   `test/*.test.ts`; never hand-list files.
8. Test files run concurrently, and on Postgres the files left on the default `public` schema read each other's
   `blocks` rows; that shared schema was the Postgres CI failure from July to October 2026. Rule: every file that
   touches the store sets its own `CSD_INDEX_PG_SCHEMA` before importing `src/`.
9. Terms dialog restyled by the explorer (2026-10-26): the page's stylesheet outranks cairn's `components` layer, and
   a bare `button` rule hid the label of the Terms dialog's button. Rule: every rule outside the tokens layer starts
   from the explorer's content, `:where(.ex-wrap)`, or from its own classes and ids, and rules stay flat
   (`test/explorer-page-layer.test.ts`).
10. Pool wait queue filled by a list read: a per-row lookup on `/address/:a/txs` filled the Postgres wait queue at
    four concurrent reads of a busy address. Rule: a list endpoint reads a page in a constant number of queries, one
    at a time, so a request holds at most one pool connection (`test/address-fanout.test.ts`).

Not an incident, a standing caution: in a low-hashrate regime (after a dominant pool left the network) a
`CSD_STALE_SECS` of 600 can false-flag until LWMA retargets; raise it if noisy.
