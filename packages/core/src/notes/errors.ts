/**
 * Thrown when a CAS (compare-and-set) write detects that the row was
 * modified by another writer since the caller's baseline read.
 *
 * Callers can inspect `expected` vs `current` to decide whether to retry,
 * abort, or surface a merge UI. `id` identifies the affected note.
 */
export class VersionMismatchError extends Error {
  readonly id: string;
  readonly expected: number;
  readonly current: number;

  constructor(id: string, expected: number, current: number) {
    super(`note ${id} version mismatch: expected ${expected}, current ${current}`);
    this.name = 'VersionMismatchError';
    this.id = id;
    this.expected = expected;
    this.current = current;
  }
}

/**
 * Thrown by `deleteNote({ rejectIfTrashed: true })` when the target is
 * already at `trash_level >= 1`. The default deleteNote path (used by
 * GUI, AI tools, batch ops) never throws this — level 1 → level 2 upgrade
 * still works there. Only the CLI opt-in wrapper raises it.
 */
export class AlreadyTrashedError extends Error {
  readonly id: string;
  readonly currentTrashLevel: number;

  constructor(id: string, currentTrashLevel: number) {
    super(`note ${id} already trashed (level ${currentTrashLevel})`);
    this.name = 'AlreadyTrashedError';
    this.id = id;
    this.currentTrashLevel = currentTrashLevel;
  }
}
