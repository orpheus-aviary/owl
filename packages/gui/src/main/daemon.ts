import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const DAEMON_PORT = 47010;
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

// We're in an ESM context (package.json "type": "module"), so the classic
// `require.resolve` global isn't available. Recreate a CommonJS-style
// resolver bound to this module's URL so `@owl/daemon` can be located.
const esmRequire = createRequire(import.meta.url);

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
    const cliPath = esmRequire.resolve('@owl/daemon/cli');
    const child = spawn('node', [cliPath, 'daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    // Daemon spawn failed — will be retried on next check.
    console.error('Failed to spawn daemon process:', err);
  }
}

/** Get the daemon API base URL. */
export function getDaemonUrl(): string {
  return DAEMON_URL;
}
