#!/usr/bin/env bash
# P5-d Phase 9 — OWL_DAEMON_(DEV_)TOKEN must never appear outside the
# gated dev-bootstrap path.
#
# Background: P5-c §6.27 closed the loop on plaintext token handling by
# locking dev-bypass behind the double-env gate
# (OWL_DAEMON_DEV_TOKEN + OWL_ALLOW_INSECURE_DEV_TOKEN). The actual
# reads live in:
#   - packages/daemon/src/sync/dev-bootstrap.ts (the bypass + delete)
#   - packages/daemon/src/cli.ts (the partial-env startup warning)
#
# Any other daemon-src reference would silently widen the surface and
# is a bug.

set -euo pipefail

hits=$(rg --type ts \
  -e 'OWL_DAEMON_DEV_TOKEN|OWL_DAEMON_TOKEN|OWL_ALLOW_INSECURE_DEV_TOKEN' \
  packages/daemon/src \
  --glob '!**/dev-bootstrap.ts' \
  --glob '!**/cli.ts' \
  --glob '!**/*.test.ts' \
  --glob '!**/*.e2e.ts' \
  || true)

if [ -n "$hits" ]; then
  echo "✗ daemon prod paths must not read OWL_DAEMON_(DEV_)TOKEN (only dev-bootstrap.ts + cli.ts allowed)"
  echo "$hits"
  exit 1
fi

echo "✓ no env token reads outside dev-bootstrap"
