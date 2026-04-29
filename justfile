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
check: lint typecheck
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
        cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && pnpm run install
    fi

# Guarantee the current better-sqlite3 binding is Electron-loadable. Prepended
# to every dev / package recipe. No-op when Node's probe fails (which we take
# to mean Electron ABI is already in place).
[private]
ensure-electron-abi:
    #!/usr/bin/env bash
    set -euo pipefail
    if (cd packages/core && node -e "const D = require('better-sqlite3'); new D(':memory:').close();" 2>/dev/null); then
        echo "[abi] rebuilding better-sqlite3 for Electron ABI..."
        cd packages/gui && pnpm exec electron-builder install-app-deps
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
