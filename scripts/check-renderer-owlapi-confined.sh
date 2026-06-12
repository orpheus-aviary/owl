#!/usr/bin/env bash
# Step 0 (G10) — the renderer must reach the Electron preload (`window.owlAPI`)
# ONLY through the platform adapter, so the same bundle stays web-safe.
#
# `packages/gui/src/renderer/src/platform/` is the adapter layer (electron.ts
# is the sole legitimate reader); everything else — components, stores, pages,
# lib, hooks — must go through `getPlatform()`. Tests, the test bootstrap, and
# the ambient type declaration legitimately reference the symbol and are
# excluded.
#
# This guard catches regressions where a component reads `window.owlAPI`
# directly, which would throw the moment the bundle runs in a browser.

set -euo pipefail

hits=$(rg --fixed-strings 'window.owlAPI' \
  packages/gui/src/renderer/src \
  --glob '!**/platform/**' \
  --glob '!**/test-setup.ts' \
  --glob '!**/types/owl-api.d.ts' \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.tsx' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ renderer must reach window.owlAPI only via getPlatform() / the platform adapter"
  echo "  Use getPlatform() from '@/platform' instead of touching window.owlAPI directly."
  echo "$hits"
  exit 1
fi

echo "✓ renderer confines window.owlAPI to the platform adapter"
