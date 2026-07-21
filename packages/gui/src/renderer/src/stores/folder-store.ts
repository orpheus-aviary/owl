import type { Folder, FolderReorderItem, Note } from '@/lib/api';
import * as api from '@/lib/api';
import { LAYOUT_KEYS } from '@/lib/layout-keys';
import { create } from 'zustand';
import { useDataBus } from './data-bus';
import { currentGen, isStale } from './session-epoch';

export interface FolderNode extends Folder {
  children: FolderNode[];
}

interface FolderState {
  folders: Folder[];
  /** All non-trashed notes, used to display notes inline in the folder tree. */
  panelNotes: Note[];
  /** Ids of folders whose subtree is currently expanded in the panel. */
  expanded: Set<string>;
  /** Panel visibility toggled from the sidebar button. */
  panelOpen: boolean;
  loading: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  fetchPanelNotes: () => Promise<void>;
  create: (name: string, parentId: string | null) => Promise<Folder | null>;
  rename: (id: string, name: string) => Promise<void>;
  move: (id: string, parentId: string | null) => Promise<void>;
  reorder: (items: FolderReorderItem[]) => Promise<void>;
  remove: (id: string) => Promise<void>;

  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  toggleExpanded: (id: string) => void;
  expand: (id: string) => void;
  /** ③: drop account-scoped state. `panelOpen` is a device UI pref (localStorage)
   *  and stays untouched across session switches. */
  reset: () => void;
}

/**
 * Assemble a tree from the flat folder list. The daemon already orders rows
 * by (parent_id, position, created_at), so children land in the correct
 * sibling order when we iterate the input once.
 */
export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) byId.set(f.id, { ...f, children: [] });

  const roots: FolderNode[] = [];
  for (const f of folders) {
    const node = byId.get(f.id);
    if (!node) continue;
    if (f.parent_id && byId.has(f.parent_id)) {
      byId.get(f.parent_id)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortSiblings = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    for (const n of nodes) sortSiblings(n.children);
  };
  sortSiblings(roots);
  return roots;
}

/**
 * Returns true iff `targetId` lives anywhere in the subtree rooted at
 * `ancestorId` (exclusive of ancestor itself). Used to reject drags that
 * would create a cycle (dragging a folder into its own descendant).
 */
export function isDescendant(folders: Folder[], ancestorId: string, targetId: string): boolean {
  if (ancestorId === targetId) return false;
  const childrenByParent = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parent_id) continue;
    const arr = childrenByParent.get(f.parent_id) ?? [];
    arr.push(f.id);
    childrenByParent.set(f.parent_id, arr);
  }
  const stack = [...(childrenByParent.get(ancestorId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) break;
    if (id === targetId) return true;
    const kids = childrenByParent.get(id);
    if (kids) stack.push(...kids);
  }
  return false;
}

function readPanelOpen(): boolean {
  return window.localStorage.getItem(LAYOUT_KEYS.folderPanelOpen) === '1';
}

function writePanelOpen(open: boolean): void {
  window.localStorage.setItem(LAYOUT_KEYS.folderPanelOpen, open ? '1' : '0');
}

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  panelNotes: [],
  expanded: new Set<string>(),
  panelOpen: readPanelOpen(),
  loading: false,
  error: null,

  fetch: async () => {
    const gen = currentGen();
    set({ loading: true, error: null });
    try {
      const res = await api.listFolders();
      if (isStale(gen)) return;
      set({ folders: res.data ?? [] });
    } catch (err) {
      if (isStale(gen)) return;
      set({ error: (err as Error).message });
    } finally {
      if (!isStale(gen)) set({ loading: false });
    }
  },

  fetchPanelNotes: async () => {
    const gen = currentGen();
    try {
      // P3.4-a: FolderPanel displays per-folder order. Use the position sort
      // so DnD reordering shows up immediately; pin group does NOT apply here
      // (pin status is property-only in the panel — sorting by pinned_at
      // would move notes out of their folder-scoped position).
      const res = await api.listNotes({ limit: 10000, sort_by: 'position' });
      if (isStale(gen)) return;
      set({ panelNotes: res.data ?? [] });
    } catch {
      // ignore — panel notes are non-critical
    }
  },

  create: async (name, parentId) => {
    const gen = currentGen();
    try {
      const res = await api.createFolder({ name, parent_id: parentId });
      if (isStale(gen)) return null;
      if (parentId) get().expand(parentId);
      useDataBus.getState().bumpFolders();
      return res.data ?? null;
    } catch (err) {
      if (isStale(gen)) return null;
      set({ error: (err as Error).message });
      return null;
    }
  },

  rename: async (id, name) => {
    const gen = currentGen();
    try {
      await api.updateFolder(id, { name });
      if (isStale(gen)) return;
      useDataBus.getState().bumpFolders();
    } catch (err) {
      if (isStale(gen)) return;
      set({ error: (err as Error).message });
    }
  },

  move: async (id, parentId) => {
    const gen = currentGen();
    try {
      await api.updateFolder(id, { parent_id: parentId });
      if (isStale(gen)) return;
      if (parentId) get().expand(parentId);
      useDataBus.getState().bumpFolders();
    } catch (err) {
      if (isStale(gen)) return;
      set({ error: (err as Error).message });
    }
  },

  reorder: async (items) => {
    const gen = currentGen();
    try {
      await api.reorderFolders(items);
      if (isStale(gen)) return;
      useDataBus.getState().bumpFolders();
    } catch (err) {
      if (isStale(gen)) return;
      set({ error: (err as Error).message });
      // Bump anyway to reconcile after a failed optimistic update —
      // the subscriber refetches the canonical server-side list.
      useDataBus.getState().bumpFolders();
    }
  },

  remove: async (id) => {
    const gen = currentGen();
    try {
      await api.deleteFolder(id);
      if (isStale(gen)) return;
      // Drop the deleted id from expanded set so it doesn't leak across reloads.
      const next = new Set(get().expanded);
      next.delete(id);
      set({ expanded: next });
      // A folder delete reassigns its notes to unfiled (folder_id=null), so
      // both folder tree AND note lists need to refresh.
      useDataBus.getState().bumpFolders();
      useDataBus.getState().bumpNotes();
    } catch (err) {
      if (isStale(gen)) return;
      set({ error: (err as Error).message });
    }
  },

  setPanelOpen: (open) => {
    writePanelOpen(open);
    set({ panelOpen: open });
  },

  togglePanel: () => {
    const next = !get().panelOpen;
    writePanelOpen(next);
    set({ panelOpen: next });
  },

  toggleExpanded: (id) => {
    const next = new Set(get().expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ expanded: next });
  },

  expand: (id) => {
    const next = new Set(get().expanded);
    next.add(id);
    set({ expanded: next });
  },

  reset: () =>
    set({
      folders: [],
      panelNotes: [],
      expanded: new Set<string>(),
      loading: false,
      error: null,
    }),
}));

// Auto-refetch on data-bus signals. noteVersion → panelNotes (for inline
// notes-in-folder display). folderVersion → folders (tree structure).
useDataBus.subscribe((state, prev) => {
  if (state.noteVersion !== prev.noteVersion) {
    void useFolderStore.getState().fetchPanelNotes();
  }
  if (state.folderVersion !== prev.folderVersion) {
    void useFolderStore.getState().fetch();
  }
});
