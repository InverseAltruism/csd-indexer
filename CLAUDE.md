> Onboarding briefing for coding agents and human contributors. `AGENTS.md` is the canonical briefing and this file imports it: edit `AGENTS.md` only. Production and operations specifics are intentionally out of scope here and are maintained privately by the maintainers.

# CLAUDE.md (csd-indexer)

The full technical briefing for this repo lives in `AGENTS.md` (the L2 indexer/explorer/API: architecture, ingest/reorg/serve flows, invariants, dev/test workflow, incident history, cross-repo map). It is the single source of truth; read it first and keep both files in sync by editing `AGENTS.md`.

@AGENTS.md

## Claude Code operating notes

- **The CairnX resolver's canonical state flows through this indexer's data.** Single most important rule: the reorg path is where value safety lives. The chainwork regression guard, the checkpoint floor (38142), and "never unwind on absence of evidence" exist because a 2026-07-05 incident hard-deleted ~41k rows. Do not weaken them.
- The backend is selected purely by `CSD_INDEX_PG` (Postgres when set, SQLite otherwise). Maintainers deploy; never assume restart or deploy access. `public/explorer.html` serves per-request (edits take effect without a restart).
- Never add fetch/fs/timer awaits inside a `dbTx` callback (breaks the sqlite isolation invariant). Determinism deps (codec/registry) stay exact-pinned.
- Hardening may reject MORE, never accept DIFFERENT: historical replays must stay byte-identical.
- Security fixes must never regress UX; no em dashes / AI-slop in user-facing docs. Commit/tag only when asked; investigations default to read-only.
