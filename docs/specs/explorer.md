# Explorer page: what it shows and how

Status: current, 2026-11-17. Moved from the `public/explorer.html` entry and the proxy notes of `AGENTS.md` on
2026-11-17; the statements are as they stood there, split into sections. `AGENTS.md` keeps the rules for changing the
page; this file keeps the page's behaviour. Change it with the page.

`public/explorer.html` is a single-file page served at `/`, read from disk per request, so an edit is live without a
restart. "The front door" is cairn, which serves the page at `/explorer` and proxies the indexer's API; "standalone"
is a direct hit on the indexer.

## 1. The two origins

- Browser-test explorer changes through the front-door proxy, not only on a direct :8793 hit, and bind events with
  `addEventListener`, never inline handlers. The proxy serves the explorer under a strict per-response nonce CSP
  (`script-src 'self' 'nonce-...'`), and a nonce never authorizes inline event-handler attributes
  (`docs/incidents/README.md` 6).
- The proxy and the direct port differ in both directions. `/header.js`, `/footer.js` and `/ui/*` exist only on the
  front-door origin and 404 on :8793 (the page keeps its own brand line, disclaimer and fallback tokens there). The
  proxy does not forward SSE, so the explorer's auto-refresh polls `/blocks/recent` every 12 s. The front door sits
  behind an edge cache, so a freshly deployed explorer may need a cache purge.
- The coupling to cairn is at runtime only; no build or test reads cairn.

## 2. Verification in the browser

- The page re-verifies merkle proofs in the browser (SubtleCrypto).
- Through the front door it hashes a proposal's content bytes from cairn's same-origin `/content/0x<hash>` and calls
  them verified only when the hash equals payload_hash (a 404 reads "not held by this front door"; standalone there
  is no content check).
- The trust statement (a derived, untrusted view; inclusion checked against the indexer's own header) is a muted line
  on the page under the view in both modes (`#trust-note`), not a footer note, since cairn's footer folds page notes
  into its closed site map.

## 3. Shell, column and cascade layer

- The page carries cairn's shell from cairn's origin, as the redesign's other pages do: `/ui/theme-init.js` first in
  `<head>`, `/ui/tokens.css`, `/ui/fonts.css`, `/ui/theme.css`, `/ui/components.css`, and `/ui/theme.js` before
  `/header.js` (which fills the `#site-header` placeholder) and `/footer.js`. The page follows the theme they set and
  mounts its charts again on a theme switch (the chart module reads its colours at mount).
- Its own CSS stays inline, on the `--ui-*` tokens.
- Its content sits in the site's one column by name: `.ex-wrap` is `var(--page-max, 1280px)` wide and every edge is
  padded by `--ex-pad`, cairn's `--page-pad` (24 px without it), so its edges are the header's. Its tab icons are the
  site's `/favicon-32.png`, `/favicon.svg` and `/apple-touch-icon.png` (`test/explorer-shell-parts.test.ts`).
- It sits in the `page` cascade layer, which outranks cairn's `components` layer whatever the specificity, so every
  rule outside the tokens layer starts from the explorer's content, `:where(.ex-wrap)` (no specificity change), or
  from its own classes and ids, and the shell's header, footer, Terms dialog and toasts keep their own look
  (`test/explorer-page-layer.test.ts`, which reads every style block and wants rules flat;
  `docs/incidents/README.md` 9).
- On a direct :8793 hit the shell files 404: a fallback token block placed before `tokens.css` (light only; the page's
  only colour literals) applies, `#site-header` keeps its own brand line and `#site-footer` stays empty and hidden.
- The chart library lays its pane out in a `<table>`, so the page's own `td` rules are undone under `.cc-plot`.

## 4. Formatting

- Numbers go through one grouping (`group`, `fmtInt`, `fmtCSD`, `fmtAmt`): commas whatever the browser locale, a
  negative figure with the minus sign U+2212.
- A block's difficulty is a grouped integer (`fmtDifficulty`; in millions with M from a billion).
- Dates go through `fmtDate` (UTC).
- A hash's 0x and leading zeros are dimmed by colour only, in the faint step `--ui-faint` (`hashHtml`).
- A record line starts with its family label (`kind`: Token, Name, Market, Bridge, Record, CSD).
- Addresses show in groups of four by spacing only (`addrGroups`; a copy carries no spaces), with copy buttons that
  copy the raw value.
- Token-priced amounts go through `amt` (scaled by `/cairnx/tokens` decimals, labelled base units when the token is
  unknown).
- Colour follows the design direction (`test/fixtures/off-palette.js` measures it on every view): the neutral ramp,
  and the up, down and caution tokens for state.

## 5. Layout

The layout follows the approved design preview's explorer.

- The search, with `/` to focus it: a number, hash or address as pasted, a .csd name in one word; else `#/search/`
  opens a domain only when `/domains` lists it and otherwise reads "Nothing found" naming the query.
- A four-figure strip.
- Latest blocks beside the CairnX activity. The activity is a ledger as the preview's latest transactions: the family
  label in its own column, the record in words, the transaction; `HOME_ROWS` rows each of one height, the record cut
  to one line with its refusal tag whole, so the columns end level. The activity is read again by the blocks' own poll
  on each new block, and a record not shown before enters with the block's `ex-row-in`. View all opens the domain's
  ledger.
- Then the CSD section and the rest.
- A route change crossfades the views (a view transition on the shared curve, 320 ms, kept under reduced motion;
  without the API a 200 ms fade).
- Detail views open with a title and its status badge, then the record in words and the keys.
- A block page links the next block (or says it is the indexer's tip), and its confirmations badge counts from the
  indexer's own tip (`/health`).

## 6. Indexer state, misses and failures

- The indexer's state is read from `/health` every 15 s. Live, the latest-blocks heading says "Live". Behind the node
  (2 or more blocks between `node_tip_height` and `indexed_height`; no badge when the process serving the page runs no
  sync loop and so has no node tip), at an old tip, or not answering, one badge beside the search says which and the "Live" goes. A 429 from cairn's
  `explorerLimiter`, which /explorer/api and /trade/api share, reads "Too many requests" and an answer that is not
  JSON "Could not check", never "Indexer offline".
- Only a read the indexer answers with a 400 or a 404 is a miss (`isMiss`: "Nothing found", naming the value; a
  malformed escape in a route's value too). A 429 ("Too many requests, try again in a minute") and any other failure
  is the failed state, with Try again.
- A home panel whose own read fails (domains, miners, top holders, activity, the hashrate series) says it could not
  check, never an empty answer. `/blocks/recent` comes from the indexer serving the page, so any failure of it (a 404
  or a 200 without a list included) is the failed state, with no block-by-block reads.
- A domain with no proposals is a miss too. A domain's ledger shows the indexer's newest 100 with the total from
  `/domains` ("Latest 100" without it) and Load more (100 more a read, the indexer's `limit`, up to 10,000).

## 7. Reads of the front door's siblings

- Every read of a front-door sibling (the resolver, the node, the market) goes through `sib()` in one of four states:
  standalone (no sibling), ok, a miss (a 404 answered in JSON: "Not registered" for a name inside the resolver's name
  rule `NAME_RE`, "No token with that ticker"), and failed ("Could not check ...", with Try again, never a verdict).
  A failed read is not kept for the session (decimals, gates, primary names), so the next view asks again.
- A name record is shape-checked (its owner a 0x address); a 200 without one is the failed state.
- A registered name's page draws cairn's identity avatar (`/ui/avatar.js`, seeded `identitySeed(name, owner)` as
  /names seeds a name, awaited before the head is drawn), and the neutral disc with the initial without the module or
  for a name nobody holds. Its owner and resolves-to rows stay grouped addresses, with the primary name beside them
  only when it is another name. The name page's primary badge is the resolver's `/cairnx/primary/:owner` pick, and
  its history rows carry their verdicts.
- A token page carries the design direction's trust badge (Verified, Look-alike, Unverified) from cairn's
  `/trade/verified-tokens.json`, judged by /trade's `trustLevel` (`/trade/discover.js`): Verified only for an entry
  bound to this token's deploy, Unverified only for a ticker the list does not name, and no badge for anything else
  or while either is unread; standalone it shows neither.
- A token's supply wording follows the rule of /trade's token cards (cairn `public/trade/manage.js`) through
  `supplyKind`: fixed only once an issuer-mint token is minted to its max, otherwise issuer mint (the token page says
  how much more the issuer can mint), or open mint.
- A salted `name` record (a reveal) reads "Reserved" at or above the resolver's V25 height and "Claimed" below it, the
  height taken from `/cairnx/health` `gates`; without it (standalone, or that read failing) it reads "Revealed".

## 8. CairnX record verdicts

- A view's CairnX record verdicts (applied or refused) are read for the records it shows from the resolver's
  `/cairnx/records?ids=` (100 txids a read). Each read that answers gives its verdicts, and the txids of one that does
  not (a 404 included) stay unread. The page never reads `/cairnx/log` for them (an edge-cached log can be older than
  the records).
- A record line names its effect ("Minted", "Finalized name", "Bought") only for an applied verdict; with none
  (standalone, or the reads failing) it reads as a request ("Mint request for"), and the ledger says why in one quiet
  line (`verdictLine`; under one record's line `recordLine`).
- Each view keeps its own verdicts (`verdictBook`), so another view's read never changes its line. A txid whose read
  failed stays unread and is asked again by the view's next read (a Load more included), its row is worded again once
  answered, and the line follows every row shown.
- A name's history rows name their effect only with an applied verdict too (`kindLabel`).
- An Attest on a CairnX offer or bid reads by its own verdict (`/cairnx/record/:txid` on the transaction page, the
  batch on the address page; `describeOfferAttest`): the words for an effect (bought, cancelled, reserved, took the
  offer) only when the resolver applied it, a refused one struck with its reason, one without a verdict as the
  request it made, since the node mines a paid fill whose delivery CairnX refuses.

## 9. Market figures and charts

- Through the front door the page reads cairn's `/api/market/csd` and `/api/market/series` (CSD/USD, display only,
  each USD figure with its source line; hidden while they answer 503).
- It draws its charts (emission schedule, CSD/USD, network hashrate, block times) with cairn's `/charts/chart.js`,
  imported on demand from the same origin. Reference levels, the 120 s target and the emission so far, are the
  module's unlabelled dashed `extra` lines, since a price line's axis label covers a tick; the block-times domain top
  `btTop` lands the module's padded scale half a 50 s step above a tick.
- A CSD/USD figure that moved on a re-read slides in and flashes as the preview's price update (`rollFlash`; reduced
  motion keeps the tint).
- The hashrate tile and chart are `/analytics/miners?window=1d` and `/analytics/series?window=1d`, labelled with the
  window's real span by the chart module's `hashrateWindowText` (standalone, without the module, the label names no
  window and the tile's title names the block range).
