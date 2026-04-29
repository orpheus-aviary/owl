import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { paths } from '@owl/core';

const DAEMON_PORT = 47010;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

// ESM context — recreate CommonJS-style resolver bound to this module.
const esmRequire = createRequire(import.meta.url);

// True only when THIS GUI process successfully spawned the daemon AND saw it
// respond on /status. Determines whether Cmd+Q stops the daemon.
let daemonStartedByGui = false;

/** Check if daemon is running by hitting /status endpoint. */
export async function checkDaemon(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/status`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn daemon process using Electron-as-Node (ELECTRON_RUN_AS_NODE=1).
 * Packaged app doesn't have a standalone `node` binary; run the Electron
 * binary in node mode instead. Inherits parent env so HOME/PATH/proxy/API
 * keys reach the child.
 */
function spawnDaemon(): boolean {
  let cliPath: string;
  try {
    cliPath = esmRequire.resolve('@owl/daemon/cli');
  } catch (err) {
    console.error('Failed to resolve @owl/daemon/cli:', err);
    return false;
  }

  try {
    const child = spawn(process.execPath, [cliPath, 'daemon'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch (err) {
    console.error('Failed to spawn daemon process:', err);
    return false;
  }
}

/** Poll /status until daemon responds 200 or timeout. */
async function waitForDaemonReady({ timeoutMs }: { timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const interval = 500;
  while (Date.now() < deadline) {
    if (await checkDaemon()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/**
 * Ensure a daemon is reachable. If already running, do nothing and mark the
 * daemon as NOT owned by this GUI. If not running, spawn and wait for ready.
 */
export async function ensureDaemonRunning(): Promise<void> {
  if (await checkDaemon()) {
    daemonStartedByGui = false;
    return;
  }
  const spawned = spawnDaemon();
  if (!spawned) {
    daemonStartedByGui = false;
    return;
  }
  const ready = await waitForDaemonReady({ timeoutMs: 10_000 });
  daemonStartedByGui = ready;
  if (!ready) {
    console.error('Daemon spawn returned but /status never responded');
  }
}

/** Get the daemon API base URL. */
export function getDaemonUrl(): string {
  return DAEMON_URL;
}

/**
 * Stop the daemon IF this GUI owns it. SIGTERM → poll → 3s timeout → SIGKILL.
 * Never touches a daemon we didn't start (external daemon / failed spawn).
 */
export async function stopDaemonGracefully(): Promise<void> {
  if (!daemonStartedByGui) return;

  const pid = readPid();
  if (pid === null) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone — nothing to stop.
    return;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process died between the timeout and the kill — fine.
  }
}

function readPid(): number | null {
  const path = paths.pidPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
