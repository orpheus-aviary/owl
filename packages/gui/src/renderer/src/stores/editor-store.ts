import * as api from '@/lib/api';
import type { Note, NoteTag } from '@/lib/api';
import { create } from 'zustand';
import { useDataBus } from './data-bus';
import {
  adoptRemote,
  casBaseline,
  deserializeTags,
  detectPendingUpdateConflict,
  extractTitle,
  isUnsaved,
  reconcileTab,
  serializeTags,
  tagsEqual,
  versionConflictFromError,
} from './editor-tabs';
import type {
  AiDraftInput,
  ConflictDecision,
  ConflictPrompt,
  EditorMode,
  LoadNoteResult,
  PendingAiUpdate,
  ResolveOutcome,
  SaveResult,
  TabState,
  VersionConflict,
  VersionConflictDecision,
} from './editor-tabs';
import { currentGen, isStale } from './session-epoch';

// Re-export the editor data types + the pure conflict detector so the ~15
// existing consumers keep importing them from '@/stores/editor-store'.
export type {
  AiDraftInput,
  ConflictDecision,
  ConflictPrompt,
  EditorMode,
  LoadNoteResult,
  PendingAiUpdate,
  PendingUpdateConflict,
  ResolveOutcome,
  SaveResult,
  TabState,
  VersionConflict,
  VersionConflictDecision,
} from './editor-tabs';

/** Mobile-only edit⇄preview toggle (§4.2). Independent of the persisted desktop
 *  `mode` (which also has `split`); resets to `edit` per session. */
export type MobileMode = 'edit' | 'preview';
export { detectPendingUpdateConflict } from './editor-tabs';

interface EditorState {
  tabs: TabState[];
  activeTabId: string | null;
  mode: EditorMode;
  /** Mobile-only edit⇄preview toggle. Never persisted; `edit` each session.
   *  Desktop reads `mode`; mobile reads `mobileMode` (see EditorPanel §4.2). */
  mobileMode: MobileMode;
  lineWrap: boolean;
  /** Populated by `requestSaveOrConflict`; consumed by `<ConflictDialog>`. */
  conflictPrompt: ConflictPrompt | null;
  /** Populated when a web save 409s; consumed by `<VersionConflictDialog>`. */
  versionConflict: VersionConflict | null;

  openNote: (note: Note, opts?: { preview?: boolean }) => void;
  closeTab: (noteId: string) => void;
  setActiveTab: (noteId: string) => void;
  updateContent: (noteId: string, content: string) => void;
  updateTags: (noteId: string, tags: NoteTag[]) => void;
  /**
   * Sync a tab's `folderId` baseline after an out-of-editor move (drag-drop).
   * `updatedAt` rebases the optimistic-concurrency baseline — the move bumps
   * the note's `updated_at` server-side, so without it a web tab would 409
   * against its own drag on the next save.
   */
  syncTabFolderId: (noteId: string, folderId: string | null, updatedAt?: string) => void;
  markSaved: (noteId: string, content: string, tags: NoteTag[], updatedAt?: string) => void;
  saveNote: (noteId: string) => Promise<SaveResult>;
  /** Apply a version-conflict decision (409 dialog), clearing the prompt. */
  resolveVersionConflict: (decision: VersionConflictDecision) => Promise<SaveResult>;
  /**
   * Problem A / Phase 1b — a sync round applied remote changes; re-read every
   * open tab. Clean tabs adopt the new version silently; tabs with unsaved work
   * only get flagged (`remoteUpdated`) so the banner can offer the choice.
   */
  reconcileRemoteChanges: () => Promise<void>;
  /** Banner action: discard local edits and adopt the server copy. */
  loadRemoteIntoTab: (noteId: string) => Promise<void>;
  /** Banner action: keep editing. The next save still goes through CAS. */
  dismissRemoteUpdated: (noteId: string) => void;
  saveActiveNote: () => Promise<SaveResult>;
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
  requestSaveOrConflict: (noteId: string) => Promise<SaveResult>;
  /** Apply a conflict-prompt decision, clear the prompt, then save. */
  resolveConflict: (decision: ConflictDecision) => Promise<SaveResult>;
  /**
   * Mirror of `saveNote`'s guard clause at L340: a tab is "unsaved" when
   * any of dirty / isDraft / pendingAiUpdate is truthy. The quit-time
   * UnsavedTabsDialog uses these to decide whether to prompt.
   */
  hasUnsavedTabs: () => boolean;
  getUnsavedTabs: () => TabState[];
  cycleMode: () => void;
  setMode: (mode: EditorMode) => void;
  /** Mobile edit⇄preview toggle. Writes ONLY `mobileMode`, never the persisted
   *  desktop `mode` (§4.2 — no split→preview mapping to worry about). */
  setMobileMode: (mode: MobileMode) => void;
  toggleLineWrap: () => void;
  /** ③: drop all open tabs / dirty state / pending conflict prompts. `mode`
   *  is re-hydrated from the new session's config by `bootstrapSession`. */
  reset: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  mode: 'edit',
  mobileMode: 'edit',
  lineWrap: true,
  conflictPrompt: null,
  versionConflict: null,

  openNote: (note: Note, opts?: { preview?: boolean }) => {
    const requestPreview = opts?.preview === true;
    const { tabs } = get();
    const existing = tabs.find((t) => t.noteId === note.id);
    if (existing) {
      // Tab already open — refresh from the fresh DB snapshot so the user
      // never stares at stale content after something (AI tool, external
      // sync) mutated the note behind our back. Dirty tabs keep the user's
      // local edits; we only rebase the save baseline.
      //
      // Preview semantics overlay on top of refresh:
      // - Already pinned (preview=false): NEVER demote. Ignore opts.preview.
      // - Already preview (preview=true): match opts.preview (true keeps
      //   preview, false promotes to pinned).
      const tags = note.tags ?? [];
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.noteId !== note.id) return t;
          const nextPreview = t.preview ? requestPreview : false;
          if (t.dirty) {
            return {
              ...t,
              originalContent: note.content,
              originalTags: tags,
              originalFolderId: note.folderId,
              originalUpdatedAt: note.updatedAt,
              preview: nextPreview,
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
            originalUpdatedAt: note.updatedAt,
            preview: nextPreview,
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
      originalUpdatedAt: note.updatedAt,
      dirty: false,
      isDraft: false,
      pendingAiUpdate: null,
      preview: requestPreview,
      remoteUpdated: false,
    };
    // Preview insertion replaces the existing preview tab in place so the
    // user's tab order doesn't shuffle every time they click through the
    // list. Pinned opens (and preview when no prior preview exists) append.
    set((state) => {
      if (requestPreview) {
        const previewIdx = state.tabs.findIndex((t) => t.preview);
        if (previewIdx !== -1) {
          const nextTabs = [...state.tabs];
          nextTabs[previewIdx] = newTab;
          return { tabs: nextTabs, activeTabId: note.id };
        }
      }
      return { tabs: [...state.tabs, newTab], activeTabId: note.id };
    });
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
    set((state) => ({
      tabs: newTabs,
      activeTabId: newActiveId,
      // Drop a dangling 409 prompt that pointed at the tab we just closed.
      versionConflict: state.versionConflict?.tabId === noteId ? null : state.versionConflict,
    }));
  },

  setActiveTab: (noteId: string) => {
    set({ activeTabId: noteId });
  },

  updateContent: (noteId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.noteId !== noteId) return t;
        const nextDirty = content !== t.originalContent || !tagsEqual(t.tags, t.originalTags);
        // Edge-trigger: the first keystroke that makes the tab dirty
        // promotes it out of preview. Writing preview on every call would
        // be wasteful and risks stale-equality surprises.
        const becomingDirty = !t.dirty && nextDirty;
        return {
          ...t,
          content,
          title: extractTitle(content),
          dirty: nextDirty,
          preview: becomingDirty ? false : t.preview,
        };
      }),
    }));
  },

  updateTags: (noteId: string, tags: NoteTag[]) => {
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (t.noteId !== noteId) return t;
        const nextDirty = t.content !== t.originalContent || !tagsEqual(tags, t.originalTags);
        const becomingDirty = !t.dirty && nextDirty;
        return {
          ...t,
          tags,
          dirty: nextDirty,
          preview: becomingDirty ? false : t.preview,
        };
      }),
    }));
  },

  syncTabFolderId: (noteId, folderId, updatedAt) => {
    // Folder moves persist to the DB immediately, so the save baseline must
    // travel with the live value — otherwise dirty-detection and AI-conflict
    // checks would see a phantom folder change every save. The move also bumps
    // `updated_at` server-side, so rebase the optimistic-concurrency baseline
    // too (when the caller passes it back) to avoid a self-409 on web.
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              folderId,
              originalFolderId: folderId,
              originalUpdatedAt: updatedAt ?? t.originalUpdatedAt,
            }
          : t,
      ),
    }));
  },

  markSaved: (noteId: string, content: string, tags: NoteTag[], updatedAt?: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              originalContent: content,
              originalTags: tags,
              originalFolderId: t.folderId,
              // Advance the optimistic-concurrency baseline to the version the
              // server just wrote, so the next save checks against it.
              originalUpdatedAt: updatedAt ?? t.originalUpdatedAt,
              dirty: false,
              pendingAiUpdate: null,
              // The save settled whatever divergence the banner was warning
              // about — either it went through, or CAS turned it into the
              // version-conflict dialog and we never got here.
              remoteUpdated: false,
              // A saved tab is user-authoritative — don't let the next
              // preview click replace it.
              preview: false,
            }
          : t,
      ),
    }));
  },

  saveNote: async (noteId: string): Promise<SaveResult> => {
    const gen = currentGen();
    const tab = get().tabs.find((t) => t.noteId === noteId);
    if (!tab) return { status: 'noop', ok: true, noteId: null };
    // Nothing to persist — dirty / draft / pending-AI are the only save
    // triggers (a pending AI update can leave a tab non-dirty yet save-worthy).
    if (!isUnsaved(tab)) return { status: 'noop', ok: true, noteId: tab.noteId };
    const cas = casBaseline(tab);
    try {
      const rawTags = serializeTags(tab.tags);

      // Brand-new draft → POST /notes (no CAS baseline yet).
      if (tab.isDraft) return await saveDraft(set, tab, rawTags, gen);

      // Existing note → PATCH /notes/:id with the full current state. Covers
      // both an ordinary user edit and an AI-staged update (same wire call);
      // `cas` carries `expected_updated_at` only on the web host.
      const res = await api.patchNote(tab.noteId, {
        content: tab.content,
        tags: rawTags,
        folder_id: tab.folderId,
        ...cas,
      });
      // Session switched mid-save → don't touch new session, don't navigate.
      if (isStale(gen)) return { status: 'cancelled', ok: false, noteId: null };
      const savedTags = res.data?.tags ?? tab.tags;
      get().markSaved(tab.noteId, tab.content, savedTags, res.data?.updatedAt);
      useDataBus.getState().bumpNotes();
      return { status: 'saved', ok: true, noteId: tab.noteId };
    } catch (err) {
      return handleSaveFailure(set, err, noteId, gen);
    }
  },

  saveActiveNote: async (): Promise<SaveResult> => {
    const { activeTabId } = get();
    if (!activeTabId) return { status: 'noop', ok: true, noteId: null };
    return get().saveNote(activeTabId);
  },

  resolveVersionConflict: async (decision): Promise<SaveResult> => {
    const conflict = get().versionConflict;
    if (!conflict) return { status: 'noop', ok: true, noteId: null };
    const { tabId, remote } = conflict;

    if (decision === 'dismiss') {
      // Keep local edits + the stale baseline; the user stays in the editor.
      // `cancelled` (not success): the note-nav guard must NOT navigate away.
      set({ versionConflict: null });
      return { status: 'cancelled', ok: false, noteId: tabId };
    }

    if (decision === 'load-remote') {
      // Discard local edits, load the server copy as the new clean baseline.
      set((state) => ({
        versionConflict: null,
        tabs: state.tabs.map((t) => (t.noteId === tabId ? adoptRemote(t, remote) : t)),
      }));
      // Loaded the server copy as a clean baseline — safe to navigate away.
      return { status: 'noop', ok: true, noteId: tabId };
    }

    // 'overwrite' — keep the local edits but rebase the baseline onto the
    // version we just fetched, then re-save. Still a checked write: a fresh
    // concurrent edit landing in the gap re-raises the dialog rather than
    // clobbering blindly.
    set((state) => ({
      versionConflict: null,
      tabs: state.tabs.map((t) =>
        t.noteId === tabId ? { ...t, originalUpdatedAt: remote.updatedAt } : t,
      ),
    }));
    return get().saveNote(tabId);
  },

  reconcileRemoteChanges: async (): Promise<void> => {
    const gen = currentGen();
    // Drafts have no server copy yet, so there is nothing to reconcile them
    // against. Cost is bounded by open tabs, not by how much the round applied.
    const open = get().tabs.filter((t) => !t.isDraft);
    if (open.length === 0) return;

    const fetched = await Promise.all(
      open.map(async (t) => {
        try {
          const res = await api.getNote(t.noteId);
          return res.data ? { noteId: t.noteId, remote: res.data } : null;
        } catch {
          // Trashed/deleted remotely, or a transient failure. Leave the tab as
          // it is rather than guessing — the user's content stays on screen.
          return null;
        }
      }),
    );
    if (isStale(gen)) return;

    const byId = new Map(fetched.filter((f) => f !== null).map((f) => [f.noteId, f.remote]));
    set((state) => ({
      tabs: state.tabs.map((t) => reconcileTab(t, byId.get(t.noteId))),
    }));
  },

  loadRemoteIntoTab: async (noteId: string): Promise<void> => {
    const gen = currentGen();
    let remote: Note | undefined;
    try {
      remote = (await api.getNote(noteId)).data;
    } catch {
      return; // keep the banner up; the user can retry or resolve at save time
    }
    if (isStale(gen) || !remote) return;
    const fresh = remote;
    set((state) => ({
      tabs: state.tabs.map((t) => (t.noteId === noteId ? adoptRemote(t, fresh) : t)),
    }));
  },

  dismissRemoteUpdated: (noteId: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.noteId === noteId ? { ...t, remoteUpdated: false } : t)),
    }));
  },

  hasUnsavedTabs: () => get().tabs.some(isUnsaved),
  getUnsavedTabs: () => get().tabs.filter(isUnsaved),

  requestSaveOrConflict: async (noteId): Promise<SaveResult> => {
    const tab = get().tabs.find((t) => t.noteId === noteId);
    if (!tab) return { status: 'noop', ok: true, noteId: null };
    // Fast path: nothing AI-staged to reconcile.
    if (!tab.pendingAiUpdate) return get().saveNote(noteId);
    const conflict = detectPendingUpdateConflict(tab, tab.pendingAiUpdate);
    const hasConflict = conflict.contentChanged || conflict.tagsChanged || conflict.folderChanged;
    if (!hasConflict) return get().saveNote(noteId);
    // Divergence — raise the AI ConflictDialog and pause; the guard must not
    // navigate until the user resolves it.
    set({ conflictPrompt: { tabId: noteId, pending: tab.pendingAiUpdate, conflict } });
    return { status: 'conflict', ok: false, noteId };
  },

  resolveConflict: async (decision): Promise<SaveResult> => {
    const prompt = get().conflictPrompt;
    if (!prompt) return { status: 'noop', ok: true, noteId: null };
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
      // Never POSTed → no server version yet; the create (not a CAS PATCH)
      // establishes the first baseline via replaceTabAfterCreate.
      originalUpdatedAt: '',
      // Drafts are dirty-on-arrival so the user can save with Cmd+S.
      dirty: true,
      isDraft: true,
      pendingAiUpdate: {
        action: draft.action,
        content: draft.content,
        tags: draft.tags,
        folder_id: draft.folder_id,
      },
      // Drafts are pinned — they carry unsaved user intent and must not
      // be replaced by a subsequent preview click.
      preview: false,
      remoteUpdated: false,
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
              // AI update carries unsaved intent — pin so the next preview
              // click can't replace it.
              preview: false,
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

  setMobileMode: (mobileMode: MobileMode) => {
    set({ mobileMode });
  },

  toggleLineWrap: () => {
    set((state) => ({ lineWrap: !state.lineWrap }));
  },

  reset: () => {
    // ③/§4.1.7: also drop the mobile mode and the draft→real alias table so a
    // session switch can't carry them into the new account.
    clearDraftAliases();
    set({
      tabs: [],
      activeTabId: null,
      mode: 'edit',
      mobileMode: 'edit',
      lineWrap: true,
      conflictPrompt: null,
      versionConflict: null,
    });
  },
}));

// ─── draft → real id alias (§4.1.6 b) ──────────────────────
//
// When a draft tab saves, its placeholder `draft_<uuid>` id becomes the real
// note id. A mobile URL that still points at the draft (a stale `/note/draft_*`
// left in history, or forward navigation after the canonical replace) resolves
// through this table so EditorPage can canonical-`replace` to the real id. The
// table lives for the session only and is wiped by `reset()` (via
// `resetAllStores`), so it never leaks across accounts and can't grow unbounded.
const draftAliases = new Map<string, string>();

/** Register a draft→real mapping after a successful create. */
export function registerDraftAlias(draftId: string, realId: string): void {
  draftAliases.set(draftId, realId);
}

/** Resolve a possibly-stale draft id to its real id, or undefined if unknown. */
export function resolveDraftAlias(draftId: string): string | undefined {
  return draftAliases.get(draftId);
}

/** Drop a single alias — EditorPage calls this right after it canonical-replaces
 *  the URL, since the mapping is then single-use. */
export function forgetDraftAlias(draftId: string): void {
  draftAliases.delete(draftId);
}

function clearDraftAliases(): void {
  draftAliases.clear();
}

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
            originalUpdatedAt: saved.updatedAt,
            dirty: false,
            isDraft: false,
            pendingAiUpdate: null,
            // Draft → saved transition: tab is user-authoritative now.
            preview: false,
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

/**
 * Persist a never-saved draft via POST /notes, then swap its placeholder id
 * for the real one. Returns false when the create yields no note; throws on
 * transport failure (the caller's try/catch maps that to save-failed).
 */
/**
 * Map a failed save (draft POST or note PATCH) to a `SaveResult`. Optimistic
 * concurrency: a 409 VERSION_MISMATCH surfaces the remote copy as a `conflict`
 * (VersionConflictDialog) instead of silently dropping the save; anything else
 * is a plain `failed`. ③-guarded: a session switch mid-failure yields
 * `cancelled` and drops the dialog write.
 */
async function handleSaveFailure(
  set: (update: ConfigUpdater<EditorState> | Partial<EditorState>) => void,
  err: unknown,
  noteId: string,
  gen: number,
): Promise<SaveResult> {
  const conflict = await versionConflictFromError(err, noteId);
  if (isStale(gen)) return { status: 'cancelled', ok: false, noteId: null };
  if (conflict) {
    set({ versionConflict: conflict });
    return { status: 'conflict', ok: false, noteId };
  }
  return { status: 'failed', ok: false, noteId };
}

async function saveDraft(
  set: (update: ConfigUpdater<EditorState> | Partial<EditorState>) => void,
  tab: TabState,
  rawTags: string[],
  gen: number,
): Promise<SaveResult> {
  const res = await api.createNote({
    content: tab.content,
    tags: rawTags,
    folder_id: tab.folderId ?? undefined,
  });
  // Session switched mid-create → don't cross accounts, don't navigate.
  if (isStale(gen)) return { status: 'cancelled', ok: false, noteId: null };
  if (!res.data) return { status: 'failed', ok: false, noteId: tab.noteId };
  replaceTabAfterCreate(set, tab.noteId, res.data);
  // Remember draft→real so a stale `/note/draft_*` URL can canonical-replace.
  registerDraftAlias(tab.noteId, res.data.id);
  useDataBus.getState().bumpNotes();
  // `noteId` is the freshly-minted real id (the draft id is now dead).
  return { status: 'saved', ok: true, noteId: res.data.id };
}

// Selector for active tab
export function useActiveTab(): TabState | null {
  return useEditorStore((s) => s.tabs.find((t) => t.noteId === s.activeTabId) ?? null);
}

// Open note by ID (fetches from API then opens). ③ guards the write: this is
// reachable from an SSE `open_note` frame as well as direct callers, so a
// session switch between the GET and the openNote must not splice an old
// account's note into the new session's editor.
export async function openNoteById(noteId: string): Promise<void> {
  const gen = currentGen();
  const res = await api.getNote(noteId);
  if (isStale(gen)) return;
  if (res.data) {
    useEditorStore.getState().openNote(res.data);
  }
}

/**
 * Pure loader for the mobile master-detail resolver (§4.1.2): fetches a note
 * and returns a discriminated result WITHOUT writing the store, so the caller
 * controls exactly how (and whether) the tab opens. Contrast `openNoteById`,
 * which opens straight into the editor.
 *
 * `stale` when the session switched across the fetch. `not-found` ONLY for a
 * 404. A 200 that somehow lacks `data`, a 401, or any network error is a
 * protocol/transport failure → rethrown so the caller shows「加载失败·重试」
 * instead of the「不存在」empty state.
 */
export async function loadNoteById(noteId: string): Promise<LoadNoteResult> {
  const gen = currentGen();
  try {
    const res = await api.getNote(noteId);
    if (isStale(gen)) return { status: 'stale' };
    if (!res.data) throw new Error(`getNote(${noteId}): 200 without data`);
    return { status: 'found', note: res.data };
  } catch (err) {
    if (isStale(gen)) return { status: 'stale' };
    if (err instanceof api.ApiError && err.status === 404) return { status: 'not-found' };
    throw err;
  }
}

/**
 * Resolve a `/note/:id` route param into the editor store for the mobile
 * master-detail detail view (§4.1.1/4.1.2). EditorPage's effect awaits this and
 * commits the returned `ResolveOutcome` under its token guard. Resolution order:
 *   1. Already-open tab (real id OR an in-store draft) → `setActiveTab`, no
 *      reload (preserves the dirty baseline; a `draft_*` id lives only in the
 *      store, so fetching it would 404 — this is the only correct branch for it).
 *   2. Stale saved-draft URL (`/note/draft_*` reached via forward / old history)
 *      → `aliased` so the caller canonical-replaces to the real id (§4.1.6 b).
 *   3. Fetch via `loadNoteById` → open as a `preview` tab (a clean preview slot
 *      auto-replaces), or surface `not-found` / `load-failed` / `stale`.
 */
export async function resolveOpen(noteId: string): Promise<ResolveOutcome> {
  const gen = currentGen();
  const editor = useEditorStore.getState();
  if (editor.tabs.some((t) => t.noteId === noteId)) {
    editor.setActiveTab(noteId);
    return { kind: 'opened' };
  }
  const realId = resolveDraftAlias(noteId);
  if (realId) return { kind: 'aliased', realId };
  try {
    const r = await loadNoteById(noteId);
    // A session switch across the fetch: don't splice an old account's note in.
    if (isStale(gen) || r.status === 'stale') return { kind: 'stale' };
    if (r.status === 'not-found') return { kind: 'not-found' };
    useEditorStore.getState().openNote(r.note, { preview: true });
    return { kind: 'opened' };
  } catch {
    return { kind: 'load-failed' };
  }
}
