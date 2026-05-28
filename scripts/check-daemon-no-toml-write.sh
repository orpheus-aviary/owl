#!/usr/bin/env bash
# P5-d Phase 10 — daemon source MUST NOT write skybridge_config.toml.
#
# GUI main (packages/gui/src/main/sync-auth.ts) is the sole writer via
# the Phase 7 keychain path: encrypted_token + atomic-write. The daemon
# only reads the config (via readSkybridgeConfig) for /sync/status
# display purposes; it never persists credentials, never drops [auth]
# on 401, never lazy-registers device / workspace.
#
# This guard catches regressions where someone calls writeSkybridgeConfig
# or clearSkybridgeAuth in daemon source — both functions still exist in
# @owl/core (used by GUI main + tests), but daemon prod code must not
# touch them.

set -euo pipefail

hits=$(rg --type ts \
  -e '\bwriteSkybridgeConfig\s*\(' \
  -e '\bclearSkybridgeAuth\s*\(' \
  packages/daemon/src \
  --glob '!**/*.test.ts' \
  --glob '!**/*.e2e.ts' \
  --glob '!**/*.d.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ daemon source must not call writeSkybridgeConfig / clearSkybridgeAuth"
  echo "  GUI main is the sole toml writer (Phase 7 keychain path)."
  echo "$hits"
  exit 1
fi

echo "✓ daemon does not write skybridge toml"
