# owl-ts justfile

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
test:
    pnpm run test

[group('test')]
test-core:
    pnpm --filter @owl/core run test

[group('test')]
test-daemon:
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

# ─── Dev ────────────────────────────────────────────────

# Stop daemon + rebuild core/daemon + launch GUI (safe default)
[group('dev')]
dev: stop-daemon build-core build-daemon
    pnpm run dev

# Launch GUI without touching the daemon (faster HMR iteration)
[group('dev')]
dev-fast:
    pnpm run dev

[group('dev')]
dev-daemon:
    pnpm --filter @owl/daemon run dev

# Stop the running daemon process.
[group('dev')]
stop-daemon:
    node packages/daemon/dist/cli.js stop-daemon

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
