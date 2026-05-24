import { create } from 'zustand';

/**
 * Cross-store mutation signal. Mutation sites bump; list owners (note-store,
 * folder-store, browser-store, plus pages with local list state like
 * TrashPage) subscribe and refetch when their relevant version changes.
 *
 * Why a counter instead of an event bus: zustand subscriptions only fire on
 * referential change. Monotonic integers always change so a single bump
 * reliably wakes every subscriber, no listener registration needed.
 *
 * Why separated into note vs folder: a folder rename doesn't need to invalidate
 * trash lists; a note save doesn't need to refetch the folder tree. Splitting
 * them keeps each subscriber from re-fetching on irrelevant mutations.
 */
interface DataBus {
  /**
   * Bump on any non-trashed note CRUD: create / update / delete (move-to-trash) /
   * restore / move-folder / AI apply / batch ops. Anything that changes which
   * notes exist, where they live, or what their content is.
   */
  noteVersion: number;
  /** Bump on folder CRUD: create / rename / move / reorder / remove. */
  folderVersion: number;
  /**
   * Bump when the daemon signals `conflicts:changed` (P5-c §6.19 — sync round
   * recorded a new conflict, or ignore route soft-deleted one). Subscribers
   * refresh the count + list. Cold-start fetch lives in `MainApp` mount.
   */
  conflictVersion: number;
  bumpNotes: () => void;
  bumpFolders: () => void;
  bumpConflicts: () => void;
}

export const useDataBus = create<DataBus>((set) => ({
  noteVersion: 0,
  folderVersion: 0,
  conflictVersion: 0,
  bumpNotes: () => set((s) => ({ noteVersion: s.noteVersion + 1 })),
  bumpFolders: () => set((s) => ({ folderVersion: s.folderVersion + 1 })),
  bumpConflicts: () => set((s) => ({ conflictVersion: s.conflictVersion + 1 })),
}));
