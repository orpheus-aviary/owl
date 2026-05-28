#!/usr/bin/env bash
# P5-d Phase 9 — daemon process must stay electron-free.
#
# safeStorage / keychain access lives in the GUI main process only (see
# packages/gui/src/main/sync-auth.ts). If the daemon ever imports
# 'electron', it implies one of:
#   - safeStorage logic crept into a daemon-side path (Phase 7 boundary
#     violation), OR
#   - daemon picked up an electron module by mistake at top level
#
# Either way the result is a daemon binary that can't run headless.
#
# This guard covers three import forms — static, CJS, and dynamic — so
# the violation can't sneak in under `await import('electron')`.

set -euo pipefail

hits=$(rg --type ts \
  -e "from ['\"]electron['\"]" \
  -e "require\(['\"]electron['\"]\)" \
  -e "import\(['\"]electron['\"]\)" \
  packages/daemon/src \
  --glob '!**/*.test.ts' \
  --glob '!**/*.e2e.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ daemon src must not import electron (safeStorage belongs in GUI main only)"
  echo "$hits"
  exit 1
fi

echo "✓ daemon stays electron-free"
