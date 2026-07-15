import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { paths } from '@owl/core';

/** Thrown by `acquireDaemonLock` when a live daemon already holds the lock. */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`Daemon is already running (PID: ${pid})`);
    this.name = 'DaemonAlreadyRunningError';
  }
}

/**
 * Atomically acquire the daemon PID lock (Phase A A6). Replaces the old
 * check-then-write (`isDaemonRunning()` + `writePid()`), which let two
 * concurrent boots both pass the check and the loser's `removePid()` delete the
 * winner's file. Creates the PID file with O_EXCL: on EEXIST we consult
 * `readPid()` — a live owner throws `DaemonAlreadyRunningError`, a dead one
 * leaves a stale file that `readPid()` removes, so we retry the exclusive
 * create once.
 */
export function acquireDaemonLock(): void {
  const p = paths.pidPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(p, 'wx'); // O_CREAT | O_EXCL — fails if the file exists
      writeSync(fd, process.pid.toString());
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readPid(); // live → returns pid; stale → unlinks + null
      if (existing !== null) throw new DaemonAlreadyRunningError(existing);
      // stale file removed → loop to retry the exclusive create
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new DaemonAlreadyRunningError(readPid() ?? process.pid);
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
