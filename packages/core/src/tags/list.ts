import type Database from 'better-sqlite3';

export interface ListHashtagTagsOptions {
  /**
   * When `true`, sort by usage count desc and include `count` in each row.
   * Aggregation joins `note_tags → notes` and filters `trash_level = 0`;
   * zero-count tags are dropped. Uses raw SQL rather than drizzle so the
   * count lives in the single `GROUP BY` query.
   *
   * When `false` (default), sort by value asc without `count`, but still
   * JOIN through `note_tags → notes` + `HAVING COUNT > 0` so 0-note
   * orphan tags don't appear in autocomplete (P5-c G6). Cheaper than
   * frequent because no count column / no count-based sort.
   */
  frequent?: boolean;
  /** Max rows to return. Applied to both modes. */
  limit?: number;
}

export interface HashtagTagRow {
  value: string;
  count?: number;
}

/**
 * Backing store for GUI `/tags` + `/tags/frequent` and CLI `owl tags list`.
 * Only returns rows with `tag_type = '#'`. Callers that need raw `/time`
 * or `/alarm` tags must query elsewhere — per P3.2-c scope.
 */
export function listHashtagTags(
  sqlite: Database.Database,
  opts: ListHashtagTagsOptions = {},
): HashtagTagRow[] {
  if (opts.frequent) {
    const limitClause = opts.limit !== undefined ? 'LIMIT ?' : '';
    const args = opts.limit !== undefined ? [opts.limit] : [];
    const rows = sqlite
      .prepare(
        `SELECT t.tag_value as value, COUNT(nt.note_id) as count
         FROM tags t
         JOIN note_tags nt ON t.id = nt.tag_id
         JOIN notes n ON nt.note_id = n.id AND n.trash_level = 0
         WHERE t.tag_type = '#'
         GROUP BY t.id
         ORDER BY count DESC, t.tag_value ASC
         ${limitClause}`,
      )
      .all(...args) as { value: string; count: number }[];
    return rows.map((r) => ({ value: r.value, count: r.count }));
  }

  const limitClause = opts.limit !== undefined ? 'LIMIT ?' : '';
  const args = opts.limit !== undefined ? [opts.limit] : [];
  const rows = sqlite
    .prepare(
      `SELECT t.tag_value as value
       FROM tags t
       JOIN note_tags nt ON t.id = nt.tag_id
       JOIN notes n ON nt.note_id = n.id AND n.trash_level = 0
       WHERE t.tag_type = '#'
       GROUP BY t.id
       HAVING COUNT(nt.note_id) > 0
       ORDER BY t.tag_value ASC
       ${limitClause}`,
    )
    .all(...args) as { value: string | null }[];
  return rows.map((r) => ({ value: r.value ?? '' }));
}
