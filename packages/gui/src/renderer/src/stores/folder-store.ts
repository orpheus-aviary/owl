import type { Folder } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';

export interface FolderNode extends Folder {
  children: FolderNode[];
}

interface FolderState {
  folders: Folder[];
  /** Ids of folders whose subtree is currently expanded in the panel. */
  expanded: Set<string>;
  /** Panel visibility toggled from the sidebar button. */
  panelOpen: boolean;
  loading: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  create: (name: string, parentId: string | null) => Promise<Folder | null>;
  rename: (id: string, name: string) => Promise<void>;
  move: (id: string, parentId: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;

  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  toggleExpanded: (id: string) => void;
  expand: (id: string) => void;
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

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  expanded: new Set<string>(),
  panelOpen: false,
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.listFolders();
      set({ folders: res.data ?? [] });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  create: async (name, parentId) => {
    try {
      const res = await api.createFolder({ name, parent_id: parentId });
      await get().fetch();
      if (parentId) get().expand(parentId);
      return res.data ?? null;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  rename: async (id, name) => {
    try {
      await api.updateFolder(id, { name });
      await get().fetch();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  move: async (id, parentId) => {
    try {
      await api.updateFolder(id, { parent_id: parentId });
      await get().fetch();
      if (parentId) get().expand(parentId);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  remove: async (id) => {
    try {
      await api.deleteFolder(id);
      // Drop the deleted id from expanded set so it doesn't leak across reloads.
      const next = new Set(get().expanded);
      next.delete(id);
      set({ expanded: next });
      await get().fetch();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setPanelOpen: (open) => set({ panelOpen: open }),

  togglePanel: () => set({ panelOpen: !get().panelOpen }),

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
}));
