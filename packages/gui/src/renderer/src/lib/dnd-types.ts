/**
 * Drag-and-drop data contracts for the folder panel.
 * See docs/plans/2026-04-15-p2-5c-dnd-design.md §3.
 */

export type DragData =
  | { kind: 'folder'; folderId: string; parentId: string | null }
  | { kind: 'note'; noteId: string };

export type DropTarget =
  | { kind: 'folder-node'; folderId: string }
  | { kind: 'folder-gap'; parentId: string | null; index: number }
  | { kind: 'root-blank' };

/** Type guards for narrowing dnd-kit's `active.data.current` / `over.data.current`. */
export function isDragData(x: unknown): x is DragData {
  if (typeof x !== 'object' || x === null || !('kind' in x)) return false;
  const k = (x as { kind: unknown }).kind;
  return k === 'folder' || k === 'note';
}

export function isDropTarget(x: unknown): x is DropTarget {
  if (typeof x !== 'object' || x === null || !('kind' in x)) return false;
  const k = (x as { kind: unknown }).kind;
  return k === 'folder-node' || k === 'folder-gap' || k === 'root-blank';
}
