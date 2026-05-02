import type { CliFolder, CliHashtagTag, CliNote } from '../backend/types.js';

/**
 * Derive the displayed title from a note's content — first non-empty
 * line, trimmed. Mirrors the GUI's title derivation so users see the
 * same thing across surfaces.
 */
export function deriveTitle(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Build the CLI stdout schema for a note (design §3.2).
 *
 * snake_case field names, ms-number timestamps, tags flattened into
 * strings prefixed with their sigil (`#foo` / `/time:2026-05-02T…`).
 * The `title` field is derived here so every command that returns a
 * note produces the exact same shape.
 */
export function serializeNote(note: CliNote): Record<string, unknown> {
  return {
    id: note.id,
    content: note.content,
    title: deriveTitle(note.content),
    folder_id: note.folderId,
    tags: note.tags.map((t) =>
      t.tagType === '#' ? `#${t.tagValue}` : `${t.tagType}:${t.tagValue}`,
    ),
    trash_level: note.trashLevel,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    trashed_at: note.trashedAt,
    auto_delete_at: note.autoDeleteAt,
    content_hash: note.contentHash,
  };
}

/**
 * Build the short preview used by search / trash list items (design §3.2).
 * Pure CLI-local computation — no score / rank / snippet promised.
 */
export function buildPreview(content: string, limit = 200): string {
  const collapsed = content.trim().replace(/\s+/g, ' ');
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed;
}

export function serializeSearchItem(note: CliNote): Record<string, unknown> {
  return {
    id: note.id,
    title: deriveTitle(note.content),
    preview: buildPreview(note.content),
    tags: note.tags.map((t) =>
      t.tagType === '#' ? `#${t.tagValue}` : `${t.tagType}:${t.tagValue}`,
    ),
    folder_id: note.folderId,
    updated_at: note.updatedAt,
  };
}

export function serializeFolder(f: CliFolder): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    parent_id: f.parentId,
    sort_order: f.position,
  };
}

export function serializeHashtag(t: CliHashtagTag): Record<string, unknown> {
  const out: Record<string, unknown> = { value: `#${t.value}`, type: 'hashtag' };
  if (t.count !== undefined) out.count = t.count;
  return out;
}
