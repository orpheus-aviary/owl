import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { OwlDatabase } from './index.js';
import { localMetadata, notes } from './schema.js';

export const SPECIAL_NOTES = {
  MEMO: '00000000-0000-0000-0000-000000000001',
  TODO: '00000000-0000-0000-0000-000000000002',
} as const;

const SPECIAL_NOTE_DEFAULTS: Record<string, { content: string }> = {
  [SPECIAL_NOTES.MEMO]: { content: '# 随记\n\n' },
  [SPECIAL_NOTES.TODO]: { content: '# 待办\n\n- [ ] ' },
};

/**
 * Timestamp a freshly-seeded special note carries (Problem A / Phase 4).
 *
 * Special notes are cross-device user data with a FIXED id, materialised
 * locally on every device rather than synced into existence (`ensureSpecialNotes`
 * writes no outbox row; migration 0008 skips them). Seeding with `Date.now()`
 * made that local materialisation compete in LWW: a device starting up today
 * stamped `updated_at = now`, which beats yesterday's real edit from the other
 * device, so the pulled `update` was skipped and the content never arrived.
 *
 * A constant fixes it — every device's pristine seed is byte-identical and
 * loses to any real edit (`ms > 0`). Zero specifically means "never edited",
 * which is exactly what a pristine seed is. Two pristine seeds never need
 * comparing: neither one emits a change.
 *
 * Visible trade-off: on a brand-new device 随记/待办 sort to the bottom of a
 * by-updated_at list and display as 1970 until first edited.
 */
export const SEED_TS = 0;

/**
 * Ensure special notes exist and are visible (trash_level = 0). Called on
 * startup. Handles three cases: missing → recreate from defaults; soft-
 * deleted (trash_level > 0) → restore so they show up in the note list
 * again; already visible → no-op. Content is preserved across restores so
 * users don't lose what the AI `append_memo`/`append_todo` tools wrote.
 */
export function ensureSpecialNotes(db: OwlDatabase): void {
  const seededAt = new Date(SEED_TS);
  // P5-b: read local_device_uuid here rather than thread sqlite through —
  // ensureDeviceId must have run by now (call order in daemon/cli.ts:80-81).
  const meta = db.select().from(localMetadata).where(eq(localMetadata.key, 'device_uuid')).get();
  const localDeviceUuid = meta?.value;
  if (!localDeviceUuid) {
    throw new Error('ensureSpecialNotes: call ensureDeviceId first');
  }
  for (const [, id] of Object.entries(SPECIAL_NOTES)) {
    const existing = db.select().from(notes).where(eq(notes.id, id)).get();
    if (!existing) {
      const defaults = SPECIAL_NOTE_DEFAULTS[id];
      if (defaults) {
        db.insert(notes)
          .values({
            id,
            content: defaults.content,
            // Deterministic, not `now` — see SEED_TS. `lwwCounter` stays at its
            // column default of 0, completing the (ms, counter) pair that any
            // real edit outranks.
            createdAt: seededAt,
            updatedAt: seededAt,
            lwwCounter: 0,
            trashLevel: 0,
            localDeviceUuid,
          })
          .run();
      }
      continue;
    }
    if (existing.trashLevel > 0) {
      db.update(notes)
        .set({ trashLevel: 0, trashedAt: null, autoDeleteAt: null })
        .where(eq(notes.id, id))
        .run();
    }
  }
}

/**
 * Ensure device UUID exists in local_metadata.
 * Generated once per device, never changes.
 */
export function ensureDeviceId(db: OwlDatabase): string {
  const row = db.select().from(localMetadata).where(eq(localMetadata.key, 'device_uuid')).get();
  if (row?.value) {
    return row.value;
  }

  const deviceUuid = uuidv4();
  db.insert(localMetadata)
    .values({ key: 'device_uuid', value: deviceUuid })
    .onConflictDoUpdate({ target: localMetadata.key, set: { value: deviceUuid } })
    .run();
  return deviceUuid;
}
