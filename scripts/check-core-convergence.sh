#!/usr/bin/env bash
#
# P4 Phase 1 invariant — every business-table mutation in @owl/daemon must
# go through @owl/core. Phase 2 will rely on this so that core write
# functions can append `sync_changes` rows in the same transaction.
#
# This script grep-scans @owl/daemon/src for direct drizzle / raw-sqlite
# mutations against business tables and fails if any are found outside
# the explicit allowlist.
#
# Allowed direct DB usage in daemon (whitelisted):
#   - schema-shape SELECTs (read-only, e.g. scheduler frequency lookup)
#   - migration runner (lives in @owl/core anyway, just imported here)
#
# Forbidden patterns (any match outside allowlist = exit 1):
#   - drizzle:    db.insert(schema.X)…  db.update(schema.X)…  db.delete(schema.X)…
#   - raw sqlite: sqlite.prepare(`INSERT ...`).run / `UPDATE` / `DELETE`
#
# Phase 2 will need to update this script: `sync_changes` writes from core
# are fine, but daemon code still must never write business tables directly.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_SRC="${REPO_ROOT}/packages/daemon/src"

if [[ ! -d "${DAEMON_SRC}" ]]; then
  echo "check-core-convergence: ${DAEMON_SRC} not found" >&2
  exit 2
fi

# Forbidden drizzle mutation patterns. We match `.insert(schema.` etc.
# rather than `.insert(` alone so that drizzle reads / sub-query builders
# don't false-match. .test.ts files are out of scope (test fixtures may
# poke the DB directly to set up state).
DRIZZLE_PATTERN='\.(insert|update|delete)\(schema\.'

# Forbidden raw-sqlite mutation patterns. The daemon still uses
# better-sqlite3 directly for ai_conversations / ai_messages reads, but
# all writes (INSERT/UPDATE/DELETE) must come from @owl/core.
#
# We don't try to chase `prepare(SOME_CONST)` because the SQL string then
# lives elsewhere. Instead, scan for SQL keywords that only appear in
# mutation queries — `INSERT INTO`, `UPDATE foo SET`, `DELETE FROM`. Any
# of those tokens in daemon source is a violation.
RAW_SQLITE_PATTERN='(INSERT INTO|UPDATE [A-Za-z_]+ SET|DELETE FROM)'

# Files that legitimately call core mutation functions but happen to use
# the raw substring for read-only purposes can be added here. Keep this
# list tight — it's an audit trail.
ALLOWLIST=(
  # (none currently)
)

is_allowlisted() {
  local file="$1"
  # ${ALLOWLIST[@]+...} expands only when the array has elements,
  # avoiding "unbound variable" under `set -u` for an empty array.
  for entry in ${ALLOWLIST[@]+"${ALLOWLIST[@]}"}; do
    if [[ "${file}" == *"${entry}" ]]; then
      return 0
    fi
  done
  return 1
}

violations=0

scan() {
  local pattern="$1"
  local label="$2"
  local hits
  # rg if available, else grep -E. -n shows line numbers; --include filters.
  if command -v rg >/dev/null 2>&1; then
    hits="$(rg --no-heading --line-number --type ts \
      --glob '!*.test.ts' \
      -e "${pattern}" "${DAEMON_SRC}" || true)"
  else
    hits="$(grep -RnE --include='*.ts' --exclude='*.test.ts' \
      "${pattern}" "${DAEMON_SRC}" || true)"
  fi
  if [[ -z "${hits}" ]]; then
    return
  fi
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    local file="${line%%:*}"
    if is_allowlisted "${file}"; then
      continue
    fi
    echo "✗ ${label}: ${line}" >&2
    violations=$((violations + 1))
  done <<< "${hits}"
}

scan "${DRIZZLE_PATTERN}" "drizzle mutation"
scan "${RAW_SQLITE_PATTERN}" "raw sqlite mutation"

if [[ ${violations} -gt 0 ]]; then
  echo "" >&2
  echo "P4 Phase 1 convergence violation: daemon contains ${violations} direct DB mutation(s)." >&2
  echo "Move the write into @owl/core and call it from daemon instead." >&2
  echo "See docs/plans/2026-05-08-p4-phase1-entry-convergence-design.md" >&2
  exit 1
fi

echo "core-convergence: 0 violations in packages/daemon/src"
