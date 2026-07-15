/**
 * Phase A (A6) — local-mode CSRF token: generation, atomic publish, cleanup.
 *
 * The token is generated in memory during ctx assembly (so the auth gate has it
 * before the first request) but only PUBLISHED to disk after `server.listen()`
 * succeeds — i.e. once this process owns the port. That ordering is what keeps a
 * failed / racing second daemon from clobbering the running daemon's token file:
 * a loser never reaches `publishLocalToken`. The write is synchronous so the
 * file is in place before the event loop dispatches the first HTTP request, and
 * the daemon's own gate reads the in-memory `ctx.localToken`, not the file.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { paths } from '@owl/core';

/** Fresh in-memory local token (no disk I/O). Rotated every boot. */
export function generateLocalToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Atomically publish `token` to the 0600 local-token file. Uses O_EXCL on a
 * per-boot unique temp (created 0600, so there is never a default-permission
 * window) then `rename` over the destination. Synchronous by design (see file
 * header). Any failure removes the temp and rethrows — the caller aborts boot.
 */
export function publishLocalToken(token: string): void {
  const dest = paths.localTokenPath();
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600); // O_CREAT | O_EXCL, mode applied at creation
    writeSync(fd, token);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, dest); // atomic replace; dest inherits the temp's 0600
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closing down — ignore
      }
    }
    try {
      unlinkSync(tmp); // never leave a stray temp behind
    } catch {
      // temp may not exist (open failed) — ignore
    }
    throw err;
  }
}

/**
 * Remove the local-token file if present. Called on a cloud boot (a cloud daemon
 * must not leave a stale local token that clients would send as a bearer). Only
 * ENOENT is swallowed; any other error propagates so the operator sees it.
 */
export function removeLocalTokenFile(): void {
  try {
    unlinkSync(paths.localTokenPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
