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

# --fail-with-body so HTTP 4xx / 5xx still gets piped through jq, but
# the script exits non-zero so callers can branch on it.
curl --fail-with-body --silent -X POST "http://127.0.0.1:${PORT}/sync/run" | jq .
