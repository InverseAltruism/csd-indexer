# Git hooks, secret scanning

A `pre-commit` hook that scans **staged changes** with [gitleaks](https://github.com/gitleaks/gitleaks)
and **blocks** any commit that would introduce a secret (private key, API token, etc.).

## Activate (once per clone)

```bash
bash .githooks/install.sh
```

This sets `core.hooksPath=.githooks`. Requires the `gitleaks` binary on `PATH` (or at
`~/.local/bin/gitleaks`). If gitleaks isn't installed the hook **warns and lets the commit
through:** a missing tool never blocks your workflow.

## What it does / doesn't do

- ✅ Inspects only the staged diff; **never edits, deletes, or rewrites files**.
- ✅ Blocks the commit on a finding, with a clear message.
- ✅ Uses `.gitleaks.toml` (repo root), which extends gitleaks' default rules and
  allowlists this project's public on-chain data (addresses/scriptPubkeys), conformance
  test vectors, vendored `lib/forge-std`, and documentation placeholders, verified to
  produce **zero false positives** across the repo's full history.

## When it fires

- **Real secret** → remove it, then re-commit.
- **False positive** → add `#gitleaks:allow` on that line, or extend `.gitleaks.toml`'s
  `[allowlist]`, or bypass once with `git commit --no-verify`.

## CI

The `secrets` job in `.github/workflows/ci.yml` scans the full history of every branch with the
same config, using the gitleaks 8.18.4 release binary checked against its sha256. The same scan
locally:

```bash
gitleaks detect --no-banner --redact -c .gitleaks.toml --log-opts="--full-history --all --diff-merges=first-parent"
```
