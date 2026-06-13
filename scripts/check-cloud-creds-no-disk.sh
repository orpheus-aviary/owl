#!/usr/bin/env bash
# Phase A (A3) — the cloud CredentialStore MUST stay RAM-only.
#
# A cloud daemon holds the Layer-1 skybridge token itself (no Electron main /
# keychain), but it must NEVER persist it to disk — that's what keeps the P5-d
# "daemon never writes credentials" invariant intact (§7.7). This guard fails if
# credential-store.ts grows a filesystem dependency (node:fs / fs-extra / a
# write call). A future encrypted-file impl, if ever added, must live in its own
# module + relax this guard deliberately.

set -euo pipefail

target=packages/daemon/src/credential-store.ts

hits=$(rg \
  -e "from 'node:fs" \
  -e 'from "node:fs' \
  -e "require\(['\"]node:fs" \
  -e "from 'fs-extra" \
  -e '\bwriteFileSync\s*\(' \
  -e '\bwriteFile\s*\(' \
  -e '\bappendFileSync\s*\(' \
  "$target" \
  || true)

if [ -n "$hits" ]; then
  echo "✗ credential-store.ts must stay RAM-only (no fs import / disk write)"
  echo "  cloud credentials are in-memory by design (§7.7); never persist them here."
  echo "$hits"
  exit 1
fi

echo "✓ cloud CredentialStore stays RAM-only"
