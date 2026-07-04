#!/usr/bin/env node

import { Command } from 'commander';
import { boot } from './boot.js';
import { computeOwnerProfileId } from './cloud-login.js';
import { promptHiddenPassword, readPasswordStdin } from './password.js';
import { readPid, removePid } from './pid.js';

const program = new Command();

program.name('owl').description('Owl note-taking daemon').version('0.1.0');

program
  .command('daemon')
  .description('Start the daemon HTTP server')
  .action(() => boot());

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

// Phase A (A3c) — bootstrap helper for cloud `account_lock`. One-shot login →
// print the owner profileId → discard the token. Never starts the daemon, so
// it works even on an instance configured with a server-side AI key (the
// §3.3 ① off-login fallback is blocked there by guard #4). Password comes from
// an interactive hidden prompt, or `--password-stdin` for scripting.
program
  .command('compute-owner')
  .description('Compute the owner profileId for [daemon].account_lock (does not start the daemon)')
  .requiredOption('--server-url <url>', 'skybridge server URL')
  .requiredOption('--email <email>', 'account email')
  .option('--password-stdin', 'read the password from stdin instead of an interactive prompt')
  .action(async (opts: { serverUrl: string; email: string; passwordStdin?: boolean }) => {
    try {
      const password = opts.passwordStdin
        ? await readPasswordStdin()
        : await promptHiddenPassword('Password: ');
      const profileId = await computeOwnerProfileId({
        serverUrl: opts.serverUrl,
        email: opts.email,
        password,
      });
      // profileId is the ONLY thing on stdout → pipe-friendly.
      console.log(profileId);
    } catch (err) {
      console.error(`compute-owner failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// `from: 'node'` is explicit so the CLI works both from plain node and from
// Electron-as-Node (ELECTRON_RUN_AS_NODE=1). Without this, commander detects
// `process.versions.electron` and only strips argv[0], misreading the script
// path as the first subcommand.
program.parse(process.argv, { from: 'node' });
