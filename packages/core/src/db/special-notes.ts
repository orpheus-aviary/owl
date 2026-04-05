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
 * Ensure special notes exist. Called on startup.
 * If user deletes them, they are automatically recreated.
 */
export function ensureSpecialNotes(db: OwlDatabase): void {
  const now = new Date();
  for (const [, id] of Object.entries(SPECIAL_NOTES)) {
    const existing = db.select().from(notes).where(eq(notes.id, id)).get();
    if (!existing) {
      const defaults = SPECIAL_NOTE_DEFAULTS[id];
      if (defaults) {
        db.insert(notes)
          .values({
            id,
            content: defaults.content,
            createdAt: now,
            updatedAt: now,
            trashLevel: 0,
          })
          .run();
      }
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
