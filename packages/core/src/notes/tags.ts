import type Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { updateFtsTagsText } from '../db/fts.js';
import type { OwlDatabase } from '../db/index.js';
import { noteTags, tags } from '../db/schema.js';
import type { ParsedTag } from '../tags/parser.js';

/**
 * Replace a note's `note_tags` rows with the provided set, inserting new
 * `tags` rows for any (tag_type, tag_value) pair not yet known, and refreshing
 * `notes_fts.tags_text` so FTS hash-tag queries stay in sync.
 *
 * Originally a private helper inside `notes/index.ts`. Lifted to its own
 * module in P5-b §5.1 so the sync apply path can reuse it when replaying
 * remote note/create + note/update payloads that include `tags`.
 *
 * Callers must run this inside the same transaction that owns the
 * note insert/update so a write failure rolls back both halves together.
 */
export function syncNoteTags(
  db: OwlDatabase,
  sqlite: Database.Database,
  noteId: string,
  parsedTags: ParsedTag[],
): void {
  // Remove existing associations
  db.delete(noteTags).where(eq(noteTags.noteId, noteId)).run();

  // Upsert tags and create associations
  for (const pt of parsedTags) {
    // Find or create tag
    let tag = db
      .select()
      .from(tags)
      .where(and(eq(tags.tagType, pt.tagType), eq(tags.tagValue, pt.tagValue)))
      .get();

    if (!tag) {
      const tagId = uuidv4();
      db.insert(tags).values({ id: tagId, tagType: pt.tagType, tagValue: pt.tagValue }).run();
      tag = { id: tagId, tagType: pt.tagType, tagValue: pt.tagValue };
    }

    db.insert(noteTags).values({ noteId, tagId: tag.id }).onConflictDoNothing().run();
  }

  // Update FTS tags_text
  const noteRow = sqlite.prepare('SELECT rowid FROM notes WHERE id = ?').get(noteId) as
    | { rowid: number }
    | undefined;
  if (noteRow) {
    const hashTags = parsedTags.filter((t) => t.tagType === '#').map((t) => t.tagValue);
    updateFtsTagsText(sqlite, noteRow.rowid, hashTags.join(' '));
  }
}
