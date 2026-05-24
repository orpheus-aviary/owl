#!/usr/bin/env bash
# Guard: fail if skybridge auth tokens leak into log/string templates.
#
# Enforces P5-c §6.27 (token-mask 路 C): pino.redact masks token *fields*
# but can't reach into template strings. The fix is "don't put tokens in
# strings" — this guard makes the fix mechanical instead of trust-based.
#
# Forbidden patterns scanned in @owl/core + @owl/daemon source (NOT test
# files — tests legitimately fixture tokens for `writeSkybridgeConfig`):
#
#   - `${...token...}`           — token-bearing interpolation
#   - `+ ... .token`             — string concat with a token-named property
#   - `+ ... .authorization`     — same, for HTTP headers
#
# Allowlist: a handful of legitimate call sites that *consume* a token
# (handing it to the HTTP client, writing it to toml) — these touch
# tokens but don't leak them into log strings. Keep this list tight.
#
# Run via `just check` (lint chain).

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCES=(
  "${REPO_ROOT}/packages/core/src"
  "${REPO_ROOT}/packages/daemon/src"
)

# Patterns that should never appear outside the allowlist.
#   1. `${...token...}`     — any TS template that mentions a `.token`-named property
#   2. `${...authorization...}` — same for HTTP authorization fields
#   3. `.token}`            — pino fast-path: ${cfg.auth.token}
#   4. ` + .*\.token`       — string concat with .token
FORBIDDEN_REGEX='(\$\{[^}]*\.(token|authorization)\b)|(\+ *[^;,)]*\.(token|authorization)\b)'

# Files allowed to mention tokens (legitimate sinks, not log lines).
# Pattern matches by suffix.
ALLOWLIST=(
  packages/core/src/skybridge/config.ts
  packages/core/src/skybridge/config.test.ts
  packages/core/src/skybridge/redact.ts
  packages/core/src/skybridge/redact.test.ts
  packages/daemon/src/sync/session.ts
)

is_allowlisted() {
  local file="$1"
  for entry in ${ALLOWLIST[@]+"${ALLOWLIST[@]}"}; do
    if [[ "${file}" == *"${entry}" ]]; then
      return 0
    fi
  done
  return 1
}

violations=0

scan() {
  local src="$1"
  if [[ ! -d "${src}" ]]; then
    return
  fi
  local hits
  if command -v rg >/dev/null 2>&1; then
    hits="$(rg --no-heading --line-number --type ts \
      --glob '!*.test.ts' \
      -e "${FORBIDDEN_REGEX}" "${src}" || true)"
  else
    hits="$(grep -RnE --include='*.ts' --exclude='*.test.ts' \
      "${FORBIDDEN_REGEX}" "${src}" || true)"
  fi
  if [[ -z "${hits}" ]]; then
    return
  fi
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    local file="${line%%:*}"
    local rel="${file#${REPO_ROOT}/}"
    if is_allowlisted "${rel}"; then
      continue
    fi
    echo "✗ token-template leak: ${line}" >&2
    violations=$((violations + 1))
  done <<< "${hits}"
}

for src in "${SOURCES[@]}"; do
  scan "${src}"
done

if [[ ${violations} -gt 0 ]]; then
  echo "" >&2
  echo "P5-c §6.27 token-mask guard: ${violations} string-template token leak(s)." >&2
  echo "Tokens must not appear in \${} interpolation or string concatenation." >&2
  echo "Log structured fields ({ token } / { authorization }) — pino.redact masks those." >&2
  echo "If a call site legitimately needs to pass a token (HTTP body, toml write), add" >&2
  echo "its relative path to the ALLOWLIST in scripts/check-token-not-templated.sh." >&2
  exit 1
fi

echo "check-token-not-templated: 0 violations in ${#SOURCES[@]} source tree(s)"
