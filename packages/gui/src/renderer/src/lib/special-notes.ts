/**
 * Special-note UUIDs shared by multiple renderer components
 * (delete-confirm, NoteListItem color bar, etc.).
 *
 * Kept in sync with `SPECIAL_NOTES` in `@owl/core/db/special-notes`.
 * Renderer does not import `@owl/core` directly — that package is Node-only
 * and lives in the Electron main process. Changes here must mirror core.
 */
export const SPECIAL_NOTE_IDS = {
  MEMO: '00000000-0000-0000-0000-000000000001',
  TODO: '00000000-0000-0000-0000-000000000002',
} as const;

export const SPECIAL_NOTE_ID_SET: ReadonlySet<string> = new Set(Object.values(SPECIAL_NOTE_IDS));

/** CSS custom-property name (defined in style.css :root) for the given
 *  special note's 4px accent bar. Returns null for non-special notes. */
export function specialNoteColorVar(noteId: string): string | null {
  if (noteId === SPECIAL_NOTE_IDS.MEMO) return 'var(--owl-pin-memo)';
  if (noteId === SPECIAL_NOTE_IDS.TODO) return 'var(--owl-pin-todo)';
  return null;
}
