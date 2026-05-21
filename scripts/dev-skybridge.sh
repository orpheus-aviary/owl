#!/usr/bin/env bash
# P5-a Step 9 — boot the full local skybridge debug stack.
#
# Layout:
#   skybridge server  (background, ../skybridge `just server-start`)
#   owl daemon        (background, `just dev-daemon`)
#   owl GUI           (foreground, `just dev`)
#
# Honors $OWL_NEST_DIR so a non-default profile can be exercised. PIDs of
# the two background children are tracked + killed on EXIT trap, including
# the case where the user hits Ctrl-C while the foreground GUI is alive.
#
# macOS / Linux only (uses `kill`); Windows users boot the three manually.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKYBRIDGE_DIR="${SKYBRIDGE_DIR:-$REPO_ROOT/../skybridge}"

if [ ! -d "$SKYBRIDGE_DIR" ]; then
  echo "[dev-skybridge] expected skybridge repo at $SKYBRIDGE_DIR — set SKYBRIDGE_DIR to override" >&2
  exit 1
fi

NEST_DIR="${OWL_NEST_DIR:-$HOME/orpheus-aviary-nest}"
echo "[dev-skybridge] nest=$NEST_DIR"

SERVER_PID=""
DAEMON_PID=""

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[dev-skybridge] stopping owl daemon (pid=$DAEMON_PID)"
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[dev-skybridge] stopping skybridge server (pid=$SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[dev-skybridge] starting skybridge server..."
(
  cd "$SKYBRIDGE_DIR" && just server-start
) &
SERVER_PID=$!
echo "[dev-skybridge] skybridge server pid=$SERVER_PID"

# Give the server a beat to bind a port — purely informational; the daemon
# only contacts it on first /sync/run, not at boot.
sleep 1

echo "[dev-skybridge] starting owl daemon..."
(
  cd "$REPO_ROOT" && OWL_NEST_DIR="$NEST_DIR" just dev-daemon
) &
DAEMON_PID=$!
echo "[dev-skybridge] owl daemon pid=$DAEMON_PID"

echo "[dev-skybridge] starting owl GUI (foreground; Ctrl-C to stop everything)..."
cd "$REPO_ROOT"
OWL_NEST_DIR="$NEST_DIR" just dev
