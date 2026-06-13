#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import {
  IncompatibleDbError,
  LATEST_KNOWN_VERSION,
  MigrationRequiredError,
  createDatabase,
  createLogger,
  ensureDeviceId,
  ensureSpecialNotes,
  loadConfig,
  paths,
  readSkybridgeConfig,
  resolveActiveProfileDbPath,
  resolveLlmConfig,
} from '@owl/core';
import { Command } from 'commander';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import { createBuiltinRegistry } from './ai/tools/index.js';
import type { AppContext } from './context.js';
import { EventsBus } from './events/bus.js';
import { isDaemonRunning, readPid, removePid, writePid } from './pid.js';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';
import { DaemonStartupError, assertDaemonStartupSafe } from './startup-guard.js';
import { ensureBackgroundHandles, stopBackgroundHandles } from './sync/bridge-lifecycle.js';
import { DevTokenInProductionError, tryConsumeDevSession } from './sync/dev-bootstrap.js';
import { type ParentProbeHandle, startParentProbe } from './sync/parent-probe.js';
import { installSkybridgeSession } from './sync/session.js';
import { createSwitchGate } from './sync/switch-gate.js';

const program = new Command();

program.name('owl').description('Owl note-taking daemon').version('0.1.0');

program
  .command('daemon')
  .description('Start the daemon HTTP server')
  .action(async () => {
    if (isDaemonRunning()) {
      console.error(`Daemon is already running (PID: ${readPid()})`);
      process.exit(1);
    }

    // Ensure data directories exist
    const owlDir = paths.owlDir();
    if (!existsSync(owlDir)) mkdirSync(owlDir, { recursive: true });

    const config = loadConfig();
    const logger = createLogger({
      filePath: paths.daemonLogPath(),
      config: config.log,
      name: 'daemon',
    });

    // Phase A (A0) — fail-closed startup guards. Refuse to boot on an unsafe /
    // incoherent [daemon] config (mode×bind matrix, cloud account_lock /
    // public_url, off + server AI key, field validation). Runs before any side
    // effect (no pid written, no db opened on refusal). local defaults pass
    // unchanged → today's desktop behaviour is untouched.
    try {
      assertDaemonStartupSafe(config, { resolvedApiKey: resolveLlmConfig(config).api_key });
    } catch (err) {
      if (err instanceof DaemonStartupError) {
        logger.error({ kind: 'startup-guard' }, err.message);
        console.error(`\n${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }

    // Write pid BEFORE opening the database so the migration runner's Layer 1
    // daemon probe can see us the instant this process exists. If DB open
    // fails, removePid() runs in the catch below.
    writePid();

    let db: ReturnType<typeof createDatabase>['db'];
    let sqlite: ReturnType<typeof createDatabase>['sqlite'];
    try {
      // P5-d Phase 12 (B6): open the active profile's db. Pre-migration this
      // resolves to the legacy global db, so daemon boot is unchanged today.
      ({ db, sqlite } = createDatabase({ dbPath: resolveActiveProfileDbPath() }));
    } catch (err) {
      removePid();
      if (err instanceof MigrationRequiredError) {
        logger.error({ dbPath: err.dbPath }, 'database requires migration');
        console.error(`\n数据库需要迁移至 v${LATEST_KNOWN_VERSION}。`);
        console.error('请运行 `just migrate`（GUI 内迁移 UI 将在后续版本提供）。\n');
        process.exit(1);
      }
      if (err instanceof IncompatibleDbError) {
        logger.error(
          { dbVersion: err.dbVersion, maxSupported: err.maxSupported },
          'incompatible database',
        );
        console.error(
          `\n数据库来自更新版本（v${err.dbVersion}），本应用支持到 v${err.maxSupported}。`,
        );
        console.error('请升级应用。\n');
        process.exit(1);
      }
      throw err;
    }

    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);
    const scheduler = new ReminderScheduler(db, sqlite, config, logger);
    const toolRegistry = createBuiltinRegistry();
    const conversationStore = new ConversationStore(sqlite);
    const previewStore = new PreviewStore();
    const eventsBus = new EventsBus();

    const ctx: AppContext = {
      db,
      sqlite,
      config,
      logger,
      deviceId,
      scheduler,
      toolRegistry,
      conversationStore,
      previewStore,
      eventsBus,
      skybridgeSession: null,
      // P5-c §2.2-bis — populated by ensureBackgroundHandles below (and
      // re-populated mid-session from manual.ts:doRunManualSync after a
      // post-boot login). Shutdown reads from ctx.
      sseBridge: null,
      syncScheduler: null,
      // P5-d Phase 14 — serialises profile switches + quiesces mutating HTTP
      // during a db swap (no live switch trigger until Phase 15).
      switchGate: createSwitchGate(),
    };
    const server = buildServer(ctx);

    // P5-d Phase 6 — parent-process probe handle (started post-listen);
    // shutdown reads it to cancel the interval timer.
    let parentProbe: ParentProbeHandle | null = null;

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Daemon shutting down...');
      // P5-d Phase 14: read the *current* handles off ctx, not the boot-time
      // locals — a profile switch replaces ctx.scheduler / ctx.sqlite, so the
      // boot locals would stop an already-stopped scheduler and close an
      // already-closed sqlite while leaking the live ones.
      ctx.scheduler.stop();
      parentProbe?.stop();
      // P5-c §2.2-bis: bridge + sync scheduler live on ctx so mid-session
      // restart can swap them; stopBackgroundHandles reads + clears both.
      stopBackgroundHandles(ctx);
      removePid();
      // server.close() triggers fastify's preClose → onClose chain. The
      // /events route registers a preClose hook that ends live SSE streams
      // so this call returns promptly instead of waiting out the SIGKILL.
      await server.close();
      eventsBus.close();
      ctx.sqlite.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      const address = await server.listen({
        host: config.daemon.bind,
        port: config.daemon.port,
      });
      logger.info({ address, pid: process.pid }, 'Daemon started');
      // Tell the operator whether skybridge config is present at boot — no
      // network probe, just file existence + [server].url. Sync routes are
      // always registered; an absent config just makes them fail with
      // SKYBRIDGE_NOT_CONFIGURED.
      const skybridgeEnabled = (() => {
        try {
          readSkybridgeConfig();
          return true;
        } catch {
          return false;
        }
      })();
      logger.info(
        { enabled: skybridgeEnabled },
        `skybridge: ${skybridgeEnabled ? 'enabled' : 'disabled'}`,
      );
      console.log(`Owl daemon running at ${address} (PID: ${process.pid})`);
      scheduler.start();

      // P5-d Phase 6 — dev env gate + (optional) parent-process probe.
      // Hard-panic on production-env misuse; otherwise the daemon proceeds
      // unauthenticated until /sync/session arrives.
      await runDevBootstrapOrPanic(ctx, logger, async () => {
        removePid();
        await server.close();
      });
      if (!ctx.skybridgeSession) {
        logger.info({ kind: 'sync-session' }, 'unauthenticated mode, awaiting POST /sync/session');
      }
      parentProbe = maybeStartParentProbe(ctx, logger);

      // P5-c §2.2-bis: kick off background handles (SSE bridge if ctx
      // session is populated by dev-bootstrap above, or toml fully
      // bootstrapped via the legacy path; plus the sync scheduler —
      // disabled inside when interval_min <= 0). Both populated on
      // ctx; idempotent so manual.ts:doRunManualSync can call again
      // mid-session after a post-boot /sync/session install transitions
      // ctx to authenticated.
      await ensureBackgroundHandles(ctx, logger);
    } catch (err) {
      logger.error({ err }, 'Failed to start daemon');
      console.error('Failed to start daemon:', err);
      removePid();
      process.exit(1);
    }
  });

program
  .command('daemon-status')
  .description('Check if daemon is running')
  .action(() => {
    const pid = readPid();
    if (pid) {
      console.log(`Daemon is running (PID: ${pid})`);
    } else {
      console.log('Daemon is not running');
    }
  });

program
  .command('stop-daemon')
  .description('Stop the running daemon')
  .action(() => {
    const pid = readPid();
    if (!pid) {
      console.log('Daemon is not running');
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to daemon (PID: ${pid})`);
    } catch {
      console.error(`Failed to stop daemon (PID: ${pid})`);
      removePid();
    }
  });

// `from: 'node'` is explicit so the CLI works both from plain node and from
// Electron-as-Node (ELECTRON_RUN_AS_NODE=1). Without this, commander detects
// `process.versions.electron` and only strips argv[0], misreading the script
// path as the first subcommand.
program.parse(process.argv, { from: 'node' });

// ─── Phase 6 helpers ─────────────────────────────────────────────────

async function runDevBootstrapOrPanic(
  ctx: AppContext,
  logger: ReturnType<typeof createLogger>,
  onPanic: () => Promise<void>,
): Promise<void> {
  let dev: ReturnType<typeof tryConsumeDevSession>;
  try {
    dev = tryConsumeDevSession();
  } catch (err) {
    if (err instanceof DevTokenInProductionError) {
      logger.error({ kind: 'dev-bootstrap' }, err.message);
      console.error(err.message);
      // Hard panic — packaged daemon must never honor a dev env.
      await onPanic();
      process.exit(1);
    }
    throw err;
  }
  if (dev.reason === 'accepted' && dev.input) {
    await installSkybridgeSession(ctx, dev.input);
    logger.info(
      {
        kind: 'dev-bootstrap',
        user_id: dev.input.user_id,
        workspace_id: dev.input.workspace.id,
        device_id: dev.input.device.id,
      },
      'dev session installed from env (token redacted)',
    );
  } else if (dev.reason === 'partial-env') {
    logger.warn(
      { kind: 'dev-bootstrap' },
      'partial OWL_DAEMON_DEV_TOKEN / OWL_ALLOW_INSECURE_DEV_TOKEN — both required, ignoring',
    );
  } else if (dev.reason === 'toml-incomplete') {
    logger.info(
      { kind: 'dev-bootstrap' },
      'dev env present but toml lacks identity fields — pre-seed skybridge_config.toml',
    );
  }
}

function maybeStartParentProbe(
  ctx: AppContext,
  logger: ReturnType<typeof createLogger>,
): ParentProbeHandle | null {
  const raw = process.env.OWL_GUI_PARENT_PID;
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    logger.warn(
      { kind: 'parent-probe', raw },
      'OWL_GUI_PARENT_PID is not a positive integer; probe skipped',
    );
    return null;
  }
  return startParentProbe(
    pid,
    () => {
      stopBackgroundHandles(ctx);
      ctx.skybridgeSession = null;
    },
    logger,
  );
}
