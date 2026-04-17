import type { Note, NoteTag } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';
import { useNoteStore } from './note-store';

export type EditorMode = 'edit' | 'split' | 'preview';

/**
 * Payload mirroring the daemon's `draft_ready` SSE event for `update`
 * actions. `original_*` fields capture the DB values the AI assumed at
 * draft time, so the save path can detect concurrent edits by comparing
 * them against the tab's own save baselines.
 */
export interface PendingAiUpdate {
  action: 'create' | 'update' | 'create_reminder';
  content: string;
  tags: string[]; // raw tag strings as emitted by the daemon
  folder_id: string | null;
  original_content?: string;
  original_tags?: string[];
  original_folder_id?: string | null;
  /**
   * Snapshots of what the tab *looked like to the user* right before
   * `stageAiUpdate` overwrote it with the AI payload. Populated only
   * when the tab was dirty at stage time, so `keep-mine` can restore
   * the user's in-flight work and the ConflictDialog can diff against
   * what they actually had instead of what AI already pasted over.
   */
  pre_stage_content?: string;
  pre_stage_tags?: string[];
  pre_stage_folder_id?: string | null;
}

export interface TabState {
  noteId: string;
  title: string;
  content: string;
  originalContent: string;
  tags: NoteTag[];
  originalTags: NoteTag[];
  folderId: string | null;
  /** Save-time baseline for `folderId`. Mirrors `originalContent` semantics. */
  originalFolderId: string | null;
  dirty: boolean;
  /** True for `draft_xxx` ids that have never been POSTed yet. */
  isDraft: boolean;
  /** Set when an AI draft (create or update) is staged for save. */
  pendingAiUpdate: PendingAiUpdate | null;
}

/** Compare two NoteTag arrays by tagType:tagValue pairs (order-insensitive). */
function tagsEqual(a: NoteTag[], b: NoteTag[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: NoteTag) => `${t.tagType}:${t.tagValue ?? ''}`;
  const setA = new Set(a.map(key));
  return b.every((t) => setA.has(key(t)));
}

/** Serialize NoteTag[] to raw tag strings for the daemon API. */
function serializeTags(tags: NoteTag[]): string[] {
  return tags.map((t) => {
    if (t.tagType === '#') return `#${t.tagValue}`;
    if (['/daily', '/weekly', '/monthly', '/yearly'].includes(t.tagType)) return t.tagType;
    // /time, /alarm — tagType + space + tagValue (ISO datetime)
    return `${t.tagType} ${t.tagValue}`;
  });
}

/**
 * Active conflict-resolution state. Non-null when `requestSaveOrConflict`
 * detected an AI-vs-local divergence and is waiting on the user.
 */
export interface ConflictPrompt {
  tabId: string;
  pending: PendingAiUpdate;
  conflict: PendingUpdateConflict;
}

export type ConflictDecision = 'accept-ai' | 'keep-mine';

interface EditorState {
  tabs: TabState[];
  activeTabId: string | null;
  mode: EditorMode;
  lineWrap: boolean;
  /** Populated by `requestSaveOrConflict`; consumed by `<ConflictDialog>`. */
  conflictPrompt: ConflictPrompt | null;

  openNote: (note: Note) => void;
  closeTab: (noteId: string) => void;
  setActiveTab: (noteId: string) => void;
  updateContent: (noteId: string, content: string) => void;
  updateTags: (noteId: string, tags: NoteTag[]) => void;
  syncTabFolderId: (noteId: string, folderId: string | null) => void;
  markSaved: (noteId: string, content: string, tags: NoteTag[]) => void;
  saveNote: (noteId: string) => Promise<boolean>;
  saveActiveNote: () => Promise<boolean>;
  /** Open a brand-new AI draft (`create` / `create_reminder`) as an unsaved tab. */
  openAiDraft: (draft: AiDraftInput) => void;
  /** Apply an AI `update` draft to an already-open tab, staging it for save. */
  stageAiUpdate: (noteId: string, payload: PendingAiUpdate) => void;
  /**
   * Tier-1 auto-merge: the daemon just appended `appendedText` to a note
   * via `append_memo` / `append_note`. If a tab for that note is open,
   * reconcile with whatever the user is doing locally (see action body
   * for the three branches).
   */
  applyNoteAppliedFromAi: (noteId: string, latestDbContent: string, appendedText: string) => void;
  /**
   * Save-or-conflict wrapper. Detects whether the tab has an AI-staged
   * update whose assumed baselines diverge from the tab's own baselines;
   * if so, sets `conflictPrompt` and short-circuits. Otherwise delegates
   * to `saveNote`. Editor Cmd+S routes through this, raw callers still
   * use `saveNote` for the fast path.
   */
  requestSaveOrConflict: (noteId: string) => Promise<boolean>;
  /** Apply a conflict-prompt decision, clear the prompt, then save. */
  resolveConflict: (decision: ConflictDecision) => Promise<boolean>;
  cycleMode: () => void;
  setMode: (mode: EditorMode) => void;
  toggleLineWrap: () => void;
}

/** Subset of the SSE `draft_ready` payload needed to seed a new draft tab. */
export interface AiDraftInput {
  note_id: string; // draft_<uuid>
  content: string;
  tags: string[]; // raw tag strings
  folder_id: string | null;
  action: 'create' | 'create_reminder';
}

/**
 * Outcome of comparing a tab's save baselines against the AI-supplied
 * `original_*` baselines on a pending update. Used by P2-8 conflict UI;
 * exported here so it stays close to the data shape it's checking.
 */
export interface PendingUpdateConflict {
  contentChanged: boolean;
  tagsChanged: boolean;
  folderChanged: boolean;
}

export function detectPendingUpdateConflict(
  tab: TabState,
  pending: PendingAiUpdate,
): PendingUpdateConflict {
  // Signal 1: server-baseline mismatch. AI drafted against a stale DB
  // read; the tab's save baseline is ahead of what AI assumed.
  const tabTagStrings = serializeTags(tab.originalTags).slice().sort();
  const aiBaseline = (pending.original_tags ?? []).slice().sort();
  const serverBaselineMismatch = {
    content: tab.originalContent !== (pending.original_content ?? tab.originalContent),
    tags: tabTagStrings.join('\n') !== aiBaseline.join('\n'),
    folder: tab.originalFolderId !== (pending.original_folder_id ?? tab.originalFolderId),
  };
  // Signal 2: AI's stage overwrote in-flight user edits. `stageAiUpdate`
  // snapshots pre_stage_* only when the tab was dirty, so presence of
  // these fields already means "user had unsaved local work" — we still
  // compare to the AI payload so an identical overwrite (rare) doesn't
  // spam the dialog.
  const preStageTagsSorted = (pending.pre_stage_tags ?? []).slice().sort();
  const aiTagsSorted = pending.tags.slice().sort();
  const localOverwritten = {
    content:
      pending.pre_stage_content !== undefined && pending.pre_stage_content !== pending.content,
    tags:
      pending.pre_stage_tags !== undefined &&
      preStageTagsSorted.join('\n') !== aiTagsSorted.join('\n'),
    folder:
      pending.pre_stage_folder_id !== undefined &&
      pending.pre_stage_folder_id !== pending.folder_id,
  };
  return {
    contentChanged: serverBaselineMismatch.content || localOverwritten.content,
    tagsChanged: serverBaselineMismatch.tags || localOverwritten.tags,
    folderChanged: serverBaselineMismatch.folder || localOverwritten.folder,
  };
}

/** Parse raw tag strings (as emitted by the daemon) back into NoteTag objects. */
function deserializeTags(raw: string[]): NoteTag[] {
  return raw.map((s) => {
    if (s.startsWith('#')) return { id: s, tagType: '#', tagValue: s.slice(1) };
    const [type, ...rest] = s.split(' ');
    return { id: s, tagType: type, tagValue: rest.join(' ') || null };
  });
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 30) || '无标题';
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  mode: 'edit',
  lineWrap: true,
  conflictPrompt: null,

  openNote: (note: Note) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.noteId === note.id);
    if (existing) {
      // Tab already open — refresh from the fresh DB snapshot so the user
      // never stares at stale content after something (AI tool, external
      // sync) mutated the note behind our back. Dirty tabs keep the user's
      // local edits; we only rebase the save baseline.
      const tags = note.tags ?? [];
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.noteId !== note.id) return t;
          if (t.dirty) {
            return {
              ...t,
              originalContent: note.content,
              originalTags: tags,
              originalFolderId: note.folderId,
            };
          }
          return {
            ...t,
            title: extractTitle(note.content),
            content: note.content,
            originalContent: note.content,
            tags,
            originalTags: tags,
            folderId: note.folderId,
            originalFolderId: note.folderId,
          };
        }),
        activeTabId: note.id,
      }));
      return;
    }
    const tags = note.tags ?? [];
    const newTab: TabState = {
      noteId: note.id,
      title: extractTitle(note.content),
      content: note.content,
      originalContent: note.content,
      tags,
      originalTags: tags,
      folderId: note.folderId,
      originalFolderId: note.folderId,
      dirty: false,
      isDraft: false,
      pendingAiUpdate: null,
    };
    set({ tabs: [...tabs, newTab], activeTabId: note.id });
  },

  closeTab: (noteId: string) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.noteId === noteId);
    if (idx === -1) return;
    const newTabs = tabs.filter((t) => t.noteId !== noteId);
    let newActiveId = activeTabId;
    if (activeTabId === noteId) {
      if (newTabs.length === 0) {
        newActiveId = null;
      } else if (idx >= newTabs.length) {
        newActiveId = newTabs[newTabs.length - 1].noteId;
      } else {
        newActiveId = newTabs[idx].noteId;
      }
    }
    set({ tabs: newTabs, activeTabId: newActiveId });
  },

  setActiveTab: (noteId: string) => {
    set({ activeTabId: noteId });
  },

  updateContent: (noteId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              content,
              title: extractTitle(content),
              dirty: content !== t.originalContent || !tagsEqual(t.tags, t.originalTags),
            }
          : t,
      ),
    }));
  },

  updateTags: (noteId: string, tags: NoteTag[]) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              tags,
              dirty: t.content !== t.originalContent || !tagsEqual(tags, t.originalTags),
            }
          : t,
      ),
    }));
  },

  syncTabFolderId: (noteId, folderId) => {
    // Folder moves persist to the DB immediately, so the save baseline must
    // travel with the live value — otherwise dirty-detection and AI-conflict
    // checks would see a phantom folder change every save.
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId ? { ...t, folderId, originalFolderId: folderId } : t,
      ),
    }));
  },

  markSaved: (noteId: string, content: string, tags: NoteTag[]) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              originalContent: content,
              originalTags: tags,
              originalFolderId: t.folderId,
              dirty: false,
              pendingAiUpdate: null,
            }
          : t,
      ),
    }));
  },

  saveNote: async (noteId: string) => {
    const tab = get().tabs.find((t) => t.noteId === noteId);
    if (!tab) return true;
    // A pending AI update may have left the tab in a non-dirty state if the
    // user immediately saves; treat the pending payload as save-required.
    if (!tab.dirty && !tab.pendingAiUpdate && !tab.isDraft) return true;
    try {
      const rawTags = serializeTags(tab.tags);

      // Branch 1: brand-new draft → POST /notes
      if (tab.isDraft) {
        const res = await api.createNote({
          content: tab.content,
          tags: rawTags,
          folder_id: tab.folderId ?? undefined,
        });
        if (!res.data) return false;
        replaceTabAfterCreate(set, tab.noteId, res.data);
        useNoteStore.getState().fetchNotes();
        return true;
      }

      // Branch 2: AI-staged update → PATCH /notes/:id (folder may change)
      if (tab.pendingAiUpdate) {
        const res = await api.patchNote(tab.noteId, {
          content: tab.content,
          tags: rawTags,
          folder_id: tab.folderId,
        });
        const savedTags = res.data?.tags ?? tab.tags;
        get().markSaved(tab.noteId, tab.content, savedTags);
        useNoteStore.getState().fetchNotes();
        return true;
      }

      // Branch 3: ordinary user edit → PUT /notes/:id (existing path)
      const res = await api.updateNote(tab.noteId, { content: tab.content, tags: rawTags });
      const savedTags = res.data?.tags ?? tab.tags;
      get().markSaved(tab.noteId, tab.content, savedTags);
      useNoteStore.getState().fetchNotes();
      return true;
    } catch {
      return false;
    }
  },

  saveActiveNote: async () => {
    const { activeTabId } = get();
    if (!activeTabId) return true;
    return get().saveNote(activeTabId);
  },

  requestSaveOrConflict: async (noteId) => {
    const tab = get().tabs.find((t) => t.noteId === noteId);
    if (!tab) return true;
    // Fast path: nothing AI-staged to reconcile.
    if (!tab.pendingAiUpdate) return get().saveNote(noteId);
    const conflict = detectPendingUpdateConflict(tab, tab.pendingAiUpdate);
    const hasConflict = conflict.contentChanged || conflict.tagsChanged || conflict.folderChanged;
    if (!hasConflict) return get().saveNote(noteId);
    set({ conflictPrompt: { tabId: noteId, pending: tab.pendingAiUpdate, conflict } });
    return false;
  },

  resolveConflict: async (decision) => {
    const prompt = get().conflictPrompt;
    if (!prompt) return true;
    const { tabId, pending } = prompt;
    if (decision === 'accept-ai') {
      // Overwrite tab state with AI payload and strip the pre-stage
      // snapshot from pendingAiUpdate — the user has explicitly taken
      // AI's side, and leaving the snapshot in place would retrigger
      // the same conflict on the next Cmd+S if the PATCH fails (e.g.
      // transient 5xx, the user just retrying).
      const aiTags = deserializeTags(pending.tags);
      const sanitisedPending: PendingAiUpdate = {
        ...pending,
        pre_stage_content: undefined,
        pre_stage_tags: undefined,
        pre_stage_folder_id: undefined,
      };
      set((state) => ({
        conflictPrompt: null,
        tabs: state.tabs.map((t) =>
          t.noteId === tabId
            ? {
                ...t,
                content: pending.content,
                tags: aiTags,
                folderId: pending.folder_id,
                title: extractTitle(pending.content),
                dirty: true,
                pendingAiUpdate: sanitisedPending,
              }
            : t,
        ),
      }));
    } else {
      // Keep-mine: drop the pending payload so saveNote falls through
      // to the plain PUT path. If stageAiUpdate captured a pre-stage
      // snapshot (the user had unsaved edits when the AI payload landed
      // on top), roll the tab back to that snapshot so the save commits
      // what the user actually had — not the AI overwrite they rejected.
      set((state) => ({
        conflictPrompt: null,
        tabs: state.tabs.map((t) => {
          if (t.noteId !== tabId) return t;
          if (pending.pre_stage_content === undefined) {
            return { ...t, pendingAiUpdate: null };
          }
          const restoredContent = pending.pre_stage_content;
          const restoredTags = deserializeTags(pending.pre_stage_tags ?? []);
          return {
            ...t,
            content: restoredContent,
            tags: restoredTags,
            folderId: pending.pre_stage_folder_id ?? t.folderId,
            title: extractTitle(restoredContent),
            dirty: true,
            pendingAiUpdate: null,
          };
        }),
      }));
    }
    return get().saveNote(tabId);
  },

  openAiDraft: (draft) => {
    const tags = deserializeTags(draft.tags);
    const newTab: TabState = {
      noteId: draft.note_id,
      title: extractTitle(draft.content),
      content: draft.content,
      originalContent: '',
      tags,
      originalTags: [],
      folderId: draft.folder_id,
      originalFolderId: draft.folder_id,
      // Drafts are dirty-on-arrival so the user can save with Cmd+S.
      dirty: true,
      isDraft: true,
      pendingAiUpdate: {
        action: draft.action,
        content: draft.content,
        tags: draft.tags,
        folder_id: draft.folder_id,
      },
    };
    set((state) => ({
      tabs: [...state.tabs.filter((t) => t.noteId !== draft.note_id), newTab],
      activeTabId: draft.note_id,
    }));
  },

  applyNoteAppliedFromAi: (noteId, latestDbContent, appendedText) => {
    const tab = get().tabs.find((t) => t.noteId === noteId);
    if (!tab) return; // No-op when nothing is open for this note.
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.noteId !== noteId) return t;
        // Clean tab → silent overwrite. The user is not editing, so just
        // sync the DB state in; title / baselines follow.
        if (!t.dirty) {
          return {
            ...t,
            content: latestDbContent,
            originalContent: latestDbContent,
            title: extractTitle(latestDbContent),
          };
        }
        // Dirty tab → auto-merge: keep the user's current edits, tack
        // AI's appended text onto the end, and rebase the save baseline
        // onto the DB-with-append so the next Cmd+S diff is correct.
        const merged = `${t.content}\n\n${appendedText}`;
        return {
          ...t,
          content: merged,
          originalContent: latestDbContent,
          title: extractTitle(merged),
          dirty: true,
        };
      }),
    }));
  },

  stageAiUpdate: (noteId, payload) => {
    const tab = get().tabs.find((t) => t.noteId === noteId);
    // Capture whatever the user was editing right before the AI payload
    // lands on top — only when the tab is actually dirty, since clean
    // tabs have nothing to lose. The ConflictDialog shows this on the
    // left pane and `keep-mine` restores from it.
    const preStage: Partial<PendingAiUpdate> = tab?.dirty
      ? {
          pre_stage_content: tab.content,
          pre_stage_tags: serializeTags(tab.tags),
          pre_stage_folder_id: tab.folderId,
        }
      : {};
    const enriched: PendingAiUpdate = { ...payload, ...preStage };
    const tags = deserializeTags(payload.tags);
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              content: payload.content,
              tags,
              folderId: payload.folder_id,
              title: extractTitle(payload.content),
              dirty: true,
              pendingAiUpdate: enriched,
            }
          : t,
      ),
    }));
  },

  cycleMode: () => {
    const order: EditorMode[] = ['edit', 'split', 'preview'];
    const { mode } = get();
    const next = order[(order.indexOf(mode) + 1) % order.length];
    set({ mode: next });
  },

  setMode: (mode: EditorMode) => {
    set({ mode });
  },

  toggleLineWrap: () => {
    set((state) => ({ lineWrap: !state.lineWrap }));
  },
}));

/**
 * After saving a draft tab, swap its placeholder `draft_xxx` id for the
 * real id returned from the daemon and clear draft/AI state. The tab also
 * becomes the active one if a different tab claimed focus mid-save.
 */
function replaceTabAfterCreate(
  set: (update: ConfigUpdater<EditorState> | Partial<EditorState>) => void,
  draftId: string,
  saved: Note,
): void {
  set((state) => {
    const updatedTabs = state.tabs.map((t) =>
      t.noteId === draftId
        ? {
            ...t,
            noteId: saved.id,
            title: extractTitle(saved.content),
            originalContent: saved.content,
            originalTags: saved.tags ?? t.tags,
            folderId: saved.folderId,
            originalFolderId: saved.folderId,
            dirty: false,
            isDraft: false,
            pendingAiUpdate: null,
          }
        : t,
    );
    return {
      tabs: updatedTabs,
      activeTabId: state.activeTabId === draftId ? saved.id : state.activeTabId,
    };
  });
}

type ConfigUpdater<T> = (state: T) => Partial<T>;

// Selector for active tab
export function useActiveTab(): TabState | null {
  return useEditorStore((s) => s.tabs.find((t) => t.noteId === s.activeTabId) ?? null);
}

// Open note by ID (fetches from API then opens)
export async function openNoteById(noteId: string): Promise<void> {
  const res = await api.getNote(noteId);
  if (res.data) {
    useEditorStore.getState().openNote(res.data);
  }
}
