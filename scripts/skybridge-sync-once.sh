#!/usr/bin/env bash
# P5-a Step 9 — trigger one manual sync round against the local daemon.
#
# Honors $OWL_NEST_DIR so profile B doesn't accidentally hit profile A's
# daemon. Port comes from `packages/core/scripts/read-daemon-port.mjs`,
# which reads owl_config.toml inside the chosen nest and falls back to
# 47010 on any read failure.
#
# Output: raw `data` payload (RunSyncResult) on success; raw envelope
# (with success: false + error_code + message) on failure. Either way
# pretty-printed via jq.

set -euo pipefail

NEST_DIR="${OWL_NEST_DIR:-$HOME/orpheus-aviary-nest}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[sync-once] jq is required (brew install jq / apt install jq)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=$(OWL_NEST_DIR="$NEST_DIR" node "$REPO_ROOT/packages/core/scripts/read-daemon-port.mjs")

echo "[sync-once] nest=$NEST_DIR port=$PORT"

# A6 — the daemon requires a local token in local mode. Read it from the 0600
# file and pass the Authorization header via `curl --config -` (stdin), NOT on
# the command line: `read`/`printf` are bash builtins, so the token never lands
# in any process's argv (visible in `ps`). Absent file → send no header (cloud /
# daemon down), and let the daemon respond.
#
# --fail-with-body so HTTP 4xx / 5xx still gets piped through jq, but
# the script exits non-zero so callers can branch on it.
TOKEN_FILE="$NEST_DIR/owl/daemon-token"
if [ -r "$TOKEN_FILE" ]; then
  read -r TOK < "$TOKEN_FILE"
  printf 'header = "Authorization: Bearer %s"\n' "$TOK" |
    curl --config - --fail-with-body --silent -X POST "http://127.0.0.1:${PORT}/sync/run" | jq .
else
  curl --fail-with-body --silent -X POST "http://127.0.0.1:${PORT}/sync/run" | jq .
fi
