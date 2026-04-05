import type Database from 'better-sqlite3';
import type { OwlDatabase } from '../db/index.js';
import type { NoteWithTags } from '../notes/index.js';
import { getNote } from '../notes/index.js';

export interface SearchResult {
  id: string;
  rank: number;
}

/**
 * Full-text search across notes content and tags.
 * Returns note IDs ranked by relevance.
 */
export function searchNotes(sqlite: Database.Database, query: string, limit = 20): SearchResult[] {
  const results = sqlite
    .prepare(
      `SELECT rowid, rank FROM notes_fts
       WHERE notes_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as { rowid: number; rank: number }[];

  // Map rowid → note id
  return results
    .map((r) => {
      const note = sqlite.prepare('SELECT id FROM notes WHERE rowid = ?').get(r.rowid) as
        | { id: string }
        | undefined;
      return note ? { id: note.id, rank: r.rank } : null;
    })
    .filter((r): r is SearchResult => r !== null);
}

/**
 * Search and return full note objects with tags.
 */
export function searchNotesWithDetails(
  db: OwlDatabase,
  sqlite: Database.Database,
  query: string,
  limit = 20,
): NoteWithTags[] {
  const results = searchNotes(sqlite, query, limit);
  return results
    .map((r) => getNote(db, r.id))
    .filter((n): n is NoteWithTags => n !== null && n.trashLevel === 0);
}
