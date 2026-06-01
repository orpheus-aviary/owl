/**
 * W3 (Phase 16c) — HLC-lite stamp generation for LWW.
 *
 * LWW timestamps used to be bare `Date.now()`. Two failure modes:
 *   1. A device with a fast system clock writes ever-larger `updated_at`,
 *      single-handedly winning every conflict across the workspace.
 *   2. The same device editing twice inside one millisecond produced two
 *      writes with identical `updated_at`; the second lost to the first on
 *      the peer's `>=` LWW gate.
 *
 * Fix: a hybrid logical clock (HLC) over a *server-normalized* physical
 * clock, plus a per-device monotonic counter:
 *
 *   - `server_time_offset_ms` (local_metadata): `serverTime − localNow`,
 *     refreshed every sync round (engine.ts). `phys = Date.now() + offset`
 *     re-bases a skewed local clock onto the server's timeline.
 *   - `hlc_last_ms` / `hlc_last_counter` (local_metadata): the last stamp
 *     this device emitted. When `phys` doesn't advance past `hlc_last_ms`,
 *     the counter increments so two writes in the same physical ms stay
 *     strictly ordered.
 *
 * The resulting `(ms, counter, device_id)` three-tuple is a total order
 * (engine.ts does the comparison). `serverNormalizedStamp` MUST be called
 * inside the same sqlite transaction as the business-table write so the
 * persisted HLC state and the stamped row never diverge.
 */

import type Database from 'better-sqlite3';

const KEY_OFFSET = 'server_time_offset_ms';
const KEY_HLC_MS = 'hlc_last_ms';
const KEY_HLC_COUNTER = 'hlc_last_counter';

export interface LwwStamp {
  ms: number;
  counter: number;
}

// ─── local_metadata int read/write (mirrors changes.ts device_uuid) ──────

function readInt(sqlite: Database.Database, key: string): number | null {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  if (!row || row.value === null) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

function writeInt(sqlite: Database.Database, key: string, value: number): void {
  sqlite
    .prepare(
      'INSERT INTO local_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, String(value));
}

// ─── offset (refreshed by engine each sync round) ────────────────────────

/** Persist `serverTime − localNow` so the next stamp re-bases onto the server clock. */
export function setServerTimeOffset(sqlite: Database.Database, offsetMs: number): void {
  writeInt(sqlite, KEY_OFFSET, Math.trunc(offsetMs));
}

/** Current offset, or 0 before the first successful sync (bootstrap = bare Date.now). */
export function readServerTimeOffset(sqlite: Database.Database): number {
  return readInt(sqlite, KEY_OFFSET) ?? 0;
}

// ─── stamp generation (called inside the business-write transaction) ─────

/**
 * Produce the next monotonic `{ ms, counter }` for a local write and persist
 * the advanced HLC state. `nowMs` is injectable for deterministic tests; the
 * default `Date.now` is correct for every production caller.
 */
export function serverNormalizedStamp(
  sqlite: Database.Database,
  nowMs: () => number = Date.now,
): LwwStamp {
  const offset = readInt(sqlite, KEY_OFFSET) ?? 0;
  const phys = nowMs() + offset;
  const lastMs = readInt(sqlite, KEY_HLC_MS) ?? 0;
  const lastCounter = readInt(sqlite, KEY_HLC_COUNTER) ?? 0;

  let ms: number;
  let counter: number;
  if (phys > lastMs) {
    ms = phys;
    counter = 0;
  } else {
    // Physical clock didn't advance (same ms, or a backwards offset jump) →
    // keep the logical ms and bump the counter so the order stays strict.
    ms = lastMs;
    counter = lastCounter + 1;
  }

  writeInt(sqlite, KEY_HLC_MS, ms);
  writeInt(sqlite, KEY_HLC_COUNTER, counter);
  return { ms, counter };
}

/**
 * Advance local HLC state past a remote stamp observed during pull-apply.
 *
 * Bumping only on local writes isn't enough: after pulling a peer's
 * `(ms, counter)`, a local "saw it then immediately edited" write could
 * still tie or lose under an identical-ms / skewed-clock corner case. By
 * observing every validated remote stamp, the next local
 * `serverNormalizedStamp` is guaranteed to outrank what we've already seen.
 */
export function observeRemoteLwwKey(sqlite: Database.Database, remote: LwwStamp): void {
  const lastMs = readInt(sqlite, KEY_HLC_MS) ?? 0;
  const lastCounter = readInt(sqlite, KEY_HLC_COUNTER) ?? 0;
  if (remote.ms > lastMs) {
    writeInt(sqlite, KEY_HLC_MS, remote.ms);
    writeInt(sqlite, KEY_HLC_COUNTER, remote.counter);
  } else if (remote.ms === lastMs && remote.counter > lastCounter) {
    writeInt(sqlite, KEY_HLC_COUNTER, remote.counter);
  }
  // remote strictly older → leave local HLC untouched.
}
