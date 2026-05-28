#!/usr/bin/env bash
# P5-d Phase 9 — /sync/session route handler must never log req.body /
# token / password through ctx.logger.*.
#
# The /sync/session handler carries the plaintext skybridge token from
# GUI main to daemon over localhost. pino's redact handles structured
# fields whose paths are listed in createLogger (auth.token / token /
# headers.authorization / req.headers.authorization). This guard
# protects what redact can't see: the route handler explicitly logging
# the raw body OR an explicit { token: ... } / { password: ... } field.
#
# Multi-line is mandatory: routes/sync.ts:73 and :105 are already
# multi-line `ctx.logger.info(\n  { kind: 'sync-session', ... },\n  'msg',\n);`
# so a single-line regex would silently miss:
#
#   ctx.logger.info(
#     { body: req.body },         <- this MUST be caught
#     'debug',
#   );
#
# Strategy: rg `-U` (multiline) + `--multiline-dotall`. `[^)]*?` is
# non-greedy and stops at the first `)`. Negated character classes
# match `\n` in multiline mode by default, but we keep
# `--multiline-dotall` explicit so future tweaks using `.` don't slip.
#
# Limitations: nested function calls inside the logger args (e.g.
# `ctx.logger.info({ x: f() })`) would truncate the [^)] window. The
# current daemon code has no such pattern in routes/sync.ts; if it ever
# does, switch to the perl-extract variant in the v4 design doc.
#
# What we DON'T grep for: words like `session` / `auth`. The baseline
# log message includes `kind: 'sync-session'` and accesses
# `session.config.auth?.user_id` — both legitimate. Catching those
# would red-light the baseline.

set -euo pipefail

file="packages/daemon/src/routes/sync.ts"
if [ ! -f "$file" ]; then
  echo "✗ expected $file"
  exit 1
fi

hits=$(rg -U --multiline-dotall \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\breq\.body\b' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\btoken\s*:' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\.token\b' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\bpassword\s*:' \
  -e 'ctx\.logger\.[a-z]+\s*\([^)]*?\.password\b' \
  "$file" \
  || true)

if [ -n "$hits" ]; then
  echo "✗ /sync/session route must not log req.body / token / password via ctx.logger.*"
  echo "$hits"
  exit 1
fi

echo "✓ /sync/session body not logged"
