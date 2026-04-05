import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { paths } from '@owl/core';

/** Write current PID to file. */
export function writePid(): void {
  writeFileSync(paths.pidPath(), process.pid.toString(), 'utf-8');
}

/** Remove PID file. */
export function removePid(): void {
  const p = paths.pidPath();
  if (existsSync(p)) unlinkSync(p);
}

/** Read PID from file, or null if not running. */
export function readPid(): number | null {
  const p = paths.pidPath();
  if (!existsSync(p)) return null;

  const raw = readFileSync(p, 'utf-8').trim();
  const pid = Number(raw);
  if (Number.isNaN(pid)) return null;

  // Check if process is alive
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process not running, clean up stale PID file
    unlinkSync(p);
    return null;
  }
}

/** Check if daemon is already running. */
export function isDaemonRunning(): boolean {
  return readPid() !== null;
}
