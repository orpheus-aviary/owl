/**
 * P5-d Phase 21 (W10, layer C) — cross-process profile-switch lockfile.
 *
 * GUI main holds this file across the critical section of a profile switch (the
 * window where the daemon's active db and the toml `active_profile` can
 * disagree). CLI direct mode reads it before opening the active profile db and
 * refuses if a switch is in flight, instead of racing onto a db mid-swap.
 *
 * Three properties make it safe:
 *   - **atomic writes** (temp + rename): a concurrent reader never sees a torn
 *     file, even while GUI main heartbeats the timestamp.
 *   - **owner token** (`nonce`): `release`/`touch` only act on the lock THIS
 *     holder wrote, so a stray actor can't delete someone else's lock.
 *   - **liveness + TTL**: a lock is "active" only if its pid is alive AND it was
 *     refreshed within the TTL. A crashed holder's pid goes away immediately; a
 *     pid that gets reused after a crash is bounded by the TTL. GUI main
 *     heartbeats well inside the TTL so a genuinely in-flight switch never
 *     looks stale.
 *
 * Pure Node (no timers) — the heartbeat interval lives in GUI main, which calls
 * `touchSwitchLock` on a schedule.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { switchLockPath } from '../config/paths.js';

/** A switch lock is considered stale once its timestamp is older than this. */
export const SWITCH_LOCK_TTL_MS = 30_000;

export interface SwitchLock {
  pid: number;
  started_at: number;
  nonce: string;
}

/** A fresh owner token for a new switch-lock acquisition. */
export function newSwitchLockNonce(): string {
  return randomUUID();
}

function isSwitchLock(value: unknown): value is SwitchLock {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.pid === 'number' &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.started_at === 'number' &&
    Number.isInteger(o.started_at) &&
    o.started_at > 0 &&
    typeof o.nonce === 'string' &&
    o.nonce.length > 0
  );
}

function atomicWrite(path: string, lock: SwitchLock): void {
  // Temp + rename: rename is atomic on POSIX, so a concurrent reader sees either
  // the old complete file or the new one, never a half-written one.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(lock), 'utf8');
  renameSync(tmp, path);
}

/** Write a fresh lock owned by this process under `nonce`. */
export function writeSwitchLock(nonce: string, path = switchLockPath()): void {
  atomicWrite(path, { pid: process.pid, started_at: Date.now(), nonce });
}

/** Heartbeat: refresh `started_at` iff we still own the lock (nonce matches). */
export function touchSwitchLock(nonce: string, path = switchLockPath()): void {
  const cur = readSwitchLock(path);
  if (!cur || cur.nonce !== nonce) return; // gone, or owned by someone else now
  atomicWrite(path, { pid: cur.pid, started_at: Date.now(), nonce });
}

/** Release: delete the lock iff we own it (owner-token guard). */
export function releaseSwitchLock(nonce: string, path = switchLockPath()): void {
  const cur = readSwitchLock(path);
  if (!cur || cur.nonce !== nonce) return; // never delete a lock we don't own
  try {
    unlinkSync(path);
  } catch {
    // already gone — nothing to do
  }
}

/** Read + shape-validate the lock; `null` for missing / torn / malformed. */
export function readSwitchLock(path = switchLockPath()): SwitchLock | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // missing
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // torn / corrupt
  }
  return isSwitchLock(parsed) ? parsed : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signal 0 succeeded → process exists
  } catch (err) {
    // EPERM → exists but owned by another user (treat as alive); ESRCH → gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True iff a live switch is in flight (holder alive AND lock not stale). */
export function isSwitchLockActive(lock: SwitchLock | null): boolean {
  if (!lock) return false;
  if (!pidAlive(lock.pid)) return false;
  return Date.now() - lock.started_at < SWITCH_LOCK_TTL_MS;
}
