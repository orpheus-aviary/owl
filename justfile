# owl justfile

# ─── Lint & Format ──────────────────────────────────────

[group('lint')]
lint:
    pnpm run lint

[group('lint')]
lint-fix:
    pnpm run lint:fix

[group('lint')]
typecheck:
    pnpm run typecheck

[group('lint')]
core-convergence:
    bash scripts/check-core-convergence.sh

# P5-c §6.27 — skybridge auth tokens must not appear in string templates
# or concatenation. pino.redact covers structured fields but can't reach
# into `${tok}`. See scripts/check-token-not-templated.sh header.
[group('lint')]
token-not-templated:
    bash scripts/check-token-not-templated.sh

# P5-d Phase 9 — daemon process must stay electron-free. safeStorage /
# keychain logic lives in GUI main only. Catches daemon-src imports of
# 'electron' in all three forms (static / CJS / dynamic).
[group('lint')]
daemon-no-electron-storage:
    bash scripts/check-daemon-no-electron-storage.sh

# P5-d Phase 9 — OWL_DAEMON_(DEV_)TOKEN must never appear outside
# dev-bootstrap.ts + cli.ts. Anywhere else widens the dev bypass.
[group('lint')]
no-prod-env-token:
    bash scripts/check-no-prod-env-token.sh

# P5-d Phase 9 — /sync/session handler holds plaintext skybridge token in
# req.body. Pino redact + token-not-templated cover structured /
# templated leaks; this guards the route handler against logging
# req.body / token / password via ctx.logger.* (multi-line aware).
[group('lint')]
session-body-not-logged:
    bash scripts/check-session-body-not-logged.sh

[group('lint')]
check: lint typecheck core-convergence token-not-templated daemon-no-electron-storage no-prod-env-token session-body-not-logged
    @echo "All checks passed."

# ─── Test ───────────────────────────────────────────────

[group('test')]
test: ensure-node-abi
    pnpm run test

[group('test')]
test-core: ensure-node-abi
    pnpm --filter @owl/core run test

[group('test')]
test-daemon: ensure-node-abi
    pnpm --filter @owl/daemon run test

# ─── Build ──────────────────────────────────────────────

[group('build')]
build:
    pnpm run build

[group('build')]
build-core:
    pnpm --filter @owl/core run build

[group('build')]
build-daemon:
    pnpm --filter @owl/daemon run build

[group('build')]
build-gui:
    pnpm --filter @owl/gui run build

[group('build')]
build-cli:
    pnpm --filter @owl/cli run build

# Build the CLI bundle and smoke-test `--help` and `doctor` from dist.
# `doctor` exits non-zero under `--all` / `--llm` or when env checks fail,
# so we only require `--help` to succeed.
[group('build')]
cli-smoke: build-cli ensure-node-abi
    node apps/cli/dist/index.js --help
    @echo "--- doctor ---"
    node apps/cli/dist/index.js doctor || true

# Produce the macOS arm64 dmg via electron-builder.
# `pnpm package` internally runs build:deps + build:icons + electron-vite build
# + install-app-deps (Electron-ABI rebuild). After packaging, better-sqlite3
# is on Electron ABI — `just test` / `just migrate` will auto-switch it back
# to Node ABI via ensure-node-abi.
[group('build')]
package: ensure-electron-abi
    pnpm --filter @owl/gui package

# Escape hatch: force-rebuild better-sqlite3 for Node ABI. Normally you don't
# need this — `just test` depends on ensure-node-abi which only rebuilds when
# the current binding is NOT Node-loadable. Run this manually if the probe
# ever lies (corrupt .node file, CI cache weirdness, etc.).
[group('build')]
unpackage:
    cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && pnpm run install

# ─── ABI toggling ───────────────────────────────────────
#
# better-sqlite3 ships a single compiled .node per install, and its ABI
# version must match the runtime that loads it. Node 22 is NODE_MODULE_VERSION
# 137; Electron 34 is 132. `pnpm install` produces a Node-ABI binding; only
# `electron-builder install-app-deps` (run from packages/gui, not repo root,
# so it locates electron-builder.yml and actually triggers @electron/rebuild)
# produces an Electron-ABI one. Switching between `just dev` (Electron) and
# `just test` (Node) therefore requires a rebuild.
#
# The ensure-*-abi recipes probe by instantiating a real Database — merely
# require()'ing the JS wrapper does NOT load the .node binding, so a looser
# probe would always pass and silently skip the rebuild. Instantiation
# succeeds → Node ABI active; instantiation fails with NODE_MODULE_VERSION
# error → Electron ABI active. Measures truth on disk, not a stale marker.

# Guarantee the current better-sqlite3 binding is Node-loadable. Prepended to
# every test / migrate recipe. No-op (~200ms) when already on Node ABI.
[private]
ensure-node-abi:
    #!/usr/bin/env bash
    set -euo pipefail
    if (cd packages/core && node -e "const D = require('better-sqlite3'); new D(':memory:').close();" 2>/dev/null); then
        echo "[abi] better-sqlite3 already on Node ABI — skip"
    else
        echo "[abi] rebuilding better-sqlite3 for Node ABI..."
        # Use build-release (force node-gyp from source). Plain `pnpm run install`
        # runs `prebuild-install || node-gyp rebuild`, and the prebuilt grabbed
        # by `prebuild-install` is for npm's bundled Node (currently 22 / ABI
        # 132), which silently re-breaks Node 24 (ABI 137) every time
        # `pnpm install` runs. 2026-05-25 manual M-checklist hit this 4× in
        # one session, hence this guard.
        SRC_DIR=node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
        (cd $SRC_DIR && pnpm run build-release)
        # Mirror the freshly built binary to the hoisted top-level copy
        # (pnpm install ships an independent .node there that doesn't get
        # rebuilt by the inner script).
        cp -p node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
            node_modules/better-sqlite3/build/Release/better_sqlite3.node
    fi

# Guarantee the current better-sqlite3 binding is Electron-loadable. Prepended
# to every dev / package recipe. No-op when Node's probe fails (which we take
# to mean Electron ABI is already in place).
#
# macOS Sequoia (≥15) post-rebuild step: @electron/rebuild produces fresh
# .node files without a valid code signature, and Electron now refuses to
# load them — `just dev` SIGKILLs with "Code Signature Invalid" on first
# launch. Ad-hoc sign every .node + Electron.app to clear the failure. The
# step is a no-op on non-macOS and harmless when the binaries were already
# signed correctly.
[private]
ensure-electron-abi:
    #!/usr/bin/env bash
    set -euo pipefail
    if (cd packages/core && node -e "const D = require('better-sqlite3'); new D(':memory:').close();" 2>/dev/null); then
        echo "[abi] rebuilding better-sqlite3 for Electron ABI..."
        (cd packages/gui && pnpm exec electron-builder install-app-deps)
        if [[ "$(uname)" == "Darwin" ]]; then
            echo "[abi] ad-hoc codesigning .node files + Electron.app..."
            find node_modules -name "*.node" -type f -print0 \
              | xargs -0 -n1 codesign --force --deep --sign - 2>/dev/null || true
            if [[ -d node_modules/electron/dist/Electron.app ]]; then
                codesign --force --deep --sign - node_modules/electron/dist/Electron.app 2>/dev/null || true
            fi
        fi
    else
        echo "[abi] better-sqlite3 not Node-loadable — assume Electron ABI, skip"
    fi

# ─── Dev ────────────────────────────────────────────────

# Stop daemon + rebuild core/daemon + launch GUI (safe default)
[group('dev')]
dev: ensure-electron-abi stop-daemon build-core build-daemon
    pnpm run dev

# Launch GUI without touching the daemon (faster HMR iteration)
[group('dev')]
dev-fast: ensure-electron-abi
    pnpm run dev

[group('dev')]
dev-daemon: ensure-node-abi
    pnpm --filter @owl/daemon run dev

# Stop the running daemon process.
[group('dev')]
stop-daemon:
    node packages/daemon/dist/cli.js stop-daemon

# ─── Migration ──────────────────────────────────────────

# Run the one-shot v0.2 -> v0.3 legacy database migration. Interactive —
# prompts y/N before rebuilding. Requires daemon + GUI to be stopped.
[group('migration')]
migrate: ensure-node-abi build-core
    node packages/core/scripts/migrate.mjs

# ─── Clean ──────────────────────────────────────────────

[group('clean')]
clean:
    rm -rf packages/*/dist apps/*/dist
    rm -rf packages/*/*.tsbuildinfo apps/*/*.tsbuildinfo

[group('clean')]
clean-all: clean
    rm -rf node_modules packages/*/node_modules apps/*/node_modules
    rm -f pnpm-lock.yaml

# ─── Install ────────────────────────────────────────────

[group('setup')]
install:
    pnpm install

[group('setup')]
reinstall: clean-all install

# ─── Skybridge ──────────────────────────────────────────
#
# `@orpheus-aviary/skybridge-{client,server}` are published on npm and
# installed as regular workspace dependencies; the previous dev-tarball
# workflow (skybridge-overrides.mjs + skybridge-install / uninstall
# recipes + check-skybridge-not-committed.sh guard) is retired.

# One-shot manual sync via daemon HTTP (POST /sync/run).
# Requires daemon running; reads OWL_NEST_DIR for profile B isolation.
[group('skybridge')]
skybridge-sync-once:
    bash scripts/skybridge-sync-once.sh

# Full debug stack: skybridge server + owl daemon + owl GUI.
# Trap on EXIT/INT/TERM kills both background children when the
# foreground GUI exits.
[group('skybridge')]
dev-skybridge: ensure-electron-abi
    bash scripts/dev-skybridge.sh

# Run the gated daemon e2e suite. `@orpheus-aviary/skybridge-{client,server}`
# is already installed via daemon's regular deps — no manifest patching
# needed. The file is named `sync.e2e.ts` (no `.test.` suffix) so the
# default `just test-daemon` glob never picks it up — only this recipe
# does. SKYBRIDGE_E2E=1 also unlocks the runtime `{ skip }` gate as
# belt-and-suspenders.
[group('skybridge')]
test-skybridge-e2e: ensure-node-abi build-daemon
    SKYBRIDGE_E2E=1 pnpm --filter @owl/daemon run test:e2e
