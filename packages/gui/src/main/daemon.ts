import { spawn } from 'node:child_process';

const DAEMON_PORT = 47010;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

/** Check if daemon is running by hitting /status endpoint. */
export async function checkDaemon(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/status`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Spawn daemon process in the background. */
export function spawnDaemon(): void {
  try {
    const child = spawn('node', [require.resolve('@owl/daemon/cli'), 'daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Daemon spawn failed — will be retried on next check
    console.error('Failed to spawn daemon process');
  }
}

/** Get the daemon API base URL. */
export function getDaemonUrl(): string {
  return DAEMON_URL;
}
