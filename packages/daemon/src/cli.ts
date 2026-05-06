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
} from '@owl/core';
import { Command } from 'commander';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import { createBuiltinRegistry } from './ai/tools/index.js';
import { EventsBus } from './events/bus.js';
import { isDaemonRunning, readPid, removePid, writePid } from './pid.js';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';

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

    // Write pid BEFORE opening the database so the migration runner's Layer 1
    // daemon probe can see us the instant this process exists. If DB open
    // fails, removePid() runs in the catch below.
    writePid();

    let db: ReturnType<typeof createDatabase>['db'];
    let sqlite: ReturnType<typeof createDatabase>['sqlite'];
    try {
      ({ db, sqlite } = createDatabase({ dbPath: paths.dbPath() }));
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

    const server = buildServer({
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
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Daemon shutting down...');
      scheduler.stop();
      removePid();
      // server.close() triggers fastify's preClose → onClose chain. The
      // /events route registers a preClose hook that ends live SSE streams
      // so this call returns promptly instead of waiting out the SIGKILL.
      await server.close();
      eventsBus.close();
      sqlite.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      const address = await server.listen({
        host: '127.0.0.1',
        port: config.daemon.port,
      });
      logger.info({ address, pid: process.pid }, 'Daemon started');
      console.log(`Owl daemon running at ${address} (PID: ${process.pid})`);
      scheduler.start();
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
