# @orpheus-aviary/owl-cli

Agent-first command-line interface for the **owl** note database.

`owl` talks to a local daemon via HTTP when one is running, and falls back
to direct sqlite access otherwise. Read commands auto-switch, write commands
have guard rails (`--direct` + `--force` combo required if the daemon is
up). Output is structured JSON by default so the binary composes cleanly
with other tools.

## Quick start

```bash
# Create a note from stdin
echo "My first note" | owl create --stdin --tag inbox

# List recent notes
owl search --limit 5

# Full note with pretty-printed JSON
owl get <id> --pretty

# Append to a note (CAS by default — refuses if someone else has written)
owl append <id> --body "another line"

# Fetch just the raw markdown
owl get <id> --raw

# Compose with xargs
owl search --id-only --limit 3 | xargs -I{} owl get {} --raw
```

## Global flags

| flag | effect |
|---|---|
| `--json` / `--pretty` | JSON output (default); `--pretty` adds 2-space indent |
| `--ndjson` | list/search → one JSON object per line |
| `--id-only` | list/search/trash → ids only, one per line |
| `--direct` | force direct sqlite mode |
| `--force` | allow direct write while daemon is running (dangerous) |
| `--overwrite` | skip optimistic concurrency check |
| `--config <path>` | override `owl_config.toml` location |
| `--db <path>` | override sqlite db path (implies `--direct`) |

## Commands

`search`, `get`, `create`, `edit`, `append`, `tag`, `delete`, `restore`,
`trash list`, `folders list`, `tags list`, `doctor`, `migrate`.

Run `owl <command> --help` for per-command flags.

## Exit codes

| code | meaning |
|---|---|
| 0 | success (doctor `warn` also 0) |
| 1 | ordinary failure (NOTE_NOT_FOUND, HTTP_ERROR, …) |
| 2 | usage / invalid input |
| 3 | environment / config / doctor fail |
| 4 | daemon required but not available |
| 5 | conflict (VERSION_MISMATCH, ALREADY_TRASHED, MIGRATION_BUSY, …) |
| 130 | user cancelled |

## License

MIT.
