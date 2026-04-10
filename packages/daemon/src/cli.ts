#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import {
  createDatabase,
  createLogger,
  ensureDeviceId,
  ensureSpecialNotes,
  loadConfig,
  paths,
} from '@owl/core';
import { Command } from 'commander';
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

    const { db, sqlite } = createDatabase({ dbPath: paths.dbPath() });

    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);
    const scheduler = new ReminderScheduler(db, sqlite, logger);

    const server = buildServer({ db, sqlite, config, logger, deviceId, scheduler });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Daemon shutting down...');
      scheduler.stop();
      removePid();
      await server.close();
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
      writePid();
      logger.info({ address, pid: process.pid }, 'Daemon started');
      console.log(`Owl daemon running at ${address} (PID: ${process.pid})`);
      scheduler.start();
    } catch (err) {
      logger.error({ err }, 'Failed to start daemon');
      console.error('Failed to start daemon:', err);
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

program.parse();
