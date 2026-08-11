/**
 * P5-d Phase 14 — daemon profile switch (design §5.4.2 / §5.4.2-bis).
 *
 * Swap the daemon onto a different profile's owl.db with a full state
 * rebuild, NOT just `ctx.db = newDb`. Several boot-constructed objects close
 * over the old db/sqlite (ReminderScheduler, ConversationStore) or cache a
 * stale snapshot keyed by ctx identity (SyncStatusBroadcaster WeakMap); the
 * switch rebuilds / evicts them all.
 *
 * Phase 14 is plumbing-only: nothing calls this live yet (login flip is
 * Phase 15, GUI quick-switch Phase 17). It does NOT write toml
 * (`active_profile` is GUI main's job) and does NOT install a session.
 *
 * Contract: it throws only from PREPARE — the db open/validate runs while the
 * old ctx is fully intact, so a throw means "nothing changed, old profile
 * still live". Once it resolves the swap is COMMITTED; post-commit failures
 * (e.g. `scheduler.start()`) are collected into `warnings`, never rejected,
 * so a caller can't mistake a committed switch for a failed one and skip
 * writing toml/session (split-brain).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LOCAL_PROFILE,
  type Logger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
  isHexProfileId,
  paths,
} from '@owl/core';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import type { AppContext } from '../context.js';
import { ReminderScheduler } from '../scheduler.js';
import { ensureBackgroundHandles, stopBackgroundHandles } from './bridge-lifecycle.js';
import { resetSyncSuccess } from './last-success.js';
import { drainManualSync, messageForError, resetOutboxPruneThrottle } from './manual.js';
import { evictSyncStatusBroadcaster } from './status-broadcaster.js';
import { ensureSwitchGate } from './switch-gate.js';

export interface SwitchProfileResult {
  /** Non-fatal failures from the post-commit rebuild. Empty on a clean switch. */
  warnings: string[];
}

export async function switchProfile(
  ctx: AppContext,
  targetDbPath: string,
  logger: Logger,
): Promise<SwitchProfileResult> {
  const gate = ensureSwitchGate(ctx);

  const warnings = await gate.runExclusive(async () => {
    // ── PREPARE — fallible; old ctx untouched, so a throw aborts cleanly ──
    const { db: newDb, sqlite: newSqlite } = createDatabase({ dbPath: targetDbPath });
    let newDeviceId: string;
    try {
      newDeviceId = ensureDeviceId(newDb); // must precede ensureSpecialNotes
      ensureSpecialNotes(newDb);
    } catch (err) {
      newSqlite.close();
      throw err;
    }

    // ── QUIESCE — stop sync triggers, then drain the in-flight round ──
    stopBackgroundHandles(ctx);
    await drainManualSync();

    // ── COMMIT — past here nothing throws out; failures go to warnings ──
    const w: string[] = [];
    ctx.scheduler.stop();
    ctx.skybridgeSession = null;
    const oldSqlite = ctx.sqlite;
    ctx.db = newDb;
    ctx.sqlite = newSqlite;
    ctx.deviceId = newDeviceId;
    ctx.previewStore = new PreviewStore();
    try {
      oldSqlite.close();
    } catch (err) {
      w.push(`old db close: ${messageForError(err)}`);
    }
    ctx.scheduler = new ReminderScheduler(newDb, newSqlite, ctx.config, logger);
    try {
      ctx.scheduler.start();
    } catch (err) {
      w.push(`scheduler start: ${messageForError(err)}`);
    }
    ctx.conversationStore = new ConversationStore(newSqlite);
    evictSyncStatusBroadcaster(ctx);
    // 0.6.2 W2 — the retention throttle is keyed on this (in-place mutated)
    // ctx, so the new database would otherwise inherit the old one's clock.
    resetOutboxPruneThrottle(ctx);
    // 0.6.3 V3 — same reason: the WeakMap is keyed on this in-place mutated
    // ctx, so without an explicit reset the new account would report the old
    // account's last successful sync on GET /status.
    resetSyncSuccess(ctx);
    return w;
  });

  // Restart background handles OUTSIDE the lock: ensureBackgroundHandles
  // no-ops while switching, so it must run with switching=false (generation
  // already bumped) to actually re-attach on the new db.
  try {
    await ensureBackgroundHandles(ctx, logger);
  } catch (err) {
    warnings.push(`bg handles: ${messageForError(err)}`);
  }

  return { warnings };
}

/** Thrown when a profile_id is neither `local` nor a 32-hex id. */
export class InvalidProfileIdError extends Error {
  readonly code = 'USAGE_ERROR';
  constructor(profileId: unknown) {
    super(`invalid profile_id: ${JSON.stringify(profileId)}`);
    this.name = 'InvalidProfileIdError';
  }
}

/**
 * Map a profileId to its owl.db path: `local` → the local db; a 32-hex id →
 * `profiles/<id>/owl.db` (its dir is created here — a first login has none yet
 * and `createDatabase` won't mkdir). Throws `InvalidProfileIdError` otherwise.
 * Shared by the `/sync/switch` route and the cloud self-login chain (A3/A4).
 */
export function profileDbPathFor(profileId: string): string {
  if (profileId === LOCAL_PROFILE) return paths.localProfileDbPath();
  if (isHexProfileId(profileId)) {
    const dbPath = paths.profileDbPath(profileId);
    mkdirSync(dirname(dbPath), { recursive: true });
    return dbPath;
  }
  throw new InvalidProfileIdError(profileId);
}

/** Switch the daemon onto a profile by id (maps to its db path, then switches). */
export function switchToProfileId(
  ctx: AppContext,
  profileId: string,
  logger: Logger,
): Promise<SwitchProfileResult> {
  return switchProfile(ctx, profileDbPathFor(profileId), logger);
}
