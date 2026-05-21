#!/usr/bin/env bash
# Guard: fail if committed manifests reference @skybridge/*.
#
# Enforces the P5-a invariant from design §11.1: skybridge tarballs are
# NOT npm-published yet, so daemon / cli / root manifests must stay clean
# of any @skybridge/* references in their git-committed state. Local
# development uses `just skybridge-install` to patch them temporarily;
# this guard blocks accidental commits of that patched state.
#
# Run via `just check` (lint chain) — see justfile `check` target.

set -euo pipefail

# Files that MUST NOT mention "@skybridge/" in their committed state.
# Root package.json's pnpm.overrides is the install target; daemon /
# cli manifests must not list @skybridge/* in deps or devDeps.
files=(
  package.json
  packages/daemon/package.json
  apps/cli/package.json
)

violations=()
for f in "${files[@]}"; do
  if [ ! -f "$f" ]; then
    continue
  fi
  if grep -q '"@skybridge/' "$f"; then
    violations+=("$f")
  fi
done

if [ ${#violations[@]} -gt 0 ]; then
  {
    echo "[guard] committed manifest references @skybridge/* —"
    echo "[guard] run 'just skybridge-uninstall' before committing:"
    printf '  %s\n' "${violations[@]}"
  } >&2
  exit 1
fi

echo "[guard] no @skybridge/* in committed manifests — ok"
