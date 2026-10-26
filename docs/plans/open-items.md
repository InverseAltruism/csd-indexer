# Open items

Status: open list, 2026-10-26. Ideas carried over from the "Gotchas" section of `AGENTS.md`; none is scheduled.

- A server-side inclusion-verification convenience endpoint.
- Humanized registration labels in the explorer.
- A second independent indexer for cross-checking.
- A blocks list behind a "View all" on the explorer home (the design preview has one): it needs a height-range route;
  `/blocks/recent` stops at 50 (noted 2026-10-26).
- A newest-first cursor on `/domain/:d/proposals` (a `before` height): the explorer's Load more asks for the newest 100
  more each time (`limit`, up to 10,000), so every page re-reads the ones shown (noted 2026-10-26).
- Explorer shortcuts that lean on cairn's chart module (noted 2026-10-26): a price line's axis label covers the tick
  under it, and so can the last-value label, so the explorer draws its reference levels as the module's unlabelled
  dashed `extra` lines; the fix for every page belongs in the module (a tick label under a line's label left out). The
  block-times domain top (`btTop`) assumes the module's price-scale margins (18% above, 12% below) and ticks on
  multiples of 50 s in that chart's range; a change to either moves the top tick back to the edge.

Done and dropped from the list: the per-tip memo for `/domains` (`domainsByTip` in `src/server.ts`, since 0.2.9).
