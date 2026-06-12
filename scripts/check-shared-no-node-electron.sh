#!/usr/bin/env bash
# Step 0 (G9) — @orpheus-aviary/owl-shared is the wire contract + HTTP client
# consumed by web and React Native, so it MUST stay mobile-safe: no Node-only
# imports (node: builtins), no Electron, no host packages (@owl/core, @owl/daemon
# are Node-only), and no window.owlAPI. Its tsconfig already drops node types and
# uses lib DOM; this guard catches imports that would re-introduce a Node/Electron
# dependency and break the React Native bundle.

set -euo pipefail

hits=$(rg \
  -e "from '(node:[^']*|electron|@owl/core|@owl/daemon)'" \
  -e "require\('(node:[^']*|electron|@owl/core|@owl/daemon)'\)" \
  -e 'window\.owlAPI' \
  packages/shared/src \
  --glob '!**/*.test.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ @orpheus-aviary/owl-shared must stay mobile-safe (no node:/electron/@owl-core/@owl-daemon/window.owlAPI)"
  echo "$hits"
  exit 1
fi

echo "✓ owl-shared stays mobile-safe"
