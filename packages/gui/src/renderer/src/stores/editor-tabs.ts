// Pure, store-free data types + helpers for the editor. Split out of
// editor-store.ts (which stayed the zustand store + actions) so neither file
// crosses the 800-line limit. Everything here is stateless — no zustand
// set/get, no data-bus — so the store can call these and remain the single
// owner of all mutation. `casBaseline` / `versionConflictFromError` take
// `remoteClient` as a parameter rather than reading the platform adapter, so
// this module stays platform-free.

import { ApiError, type Note, type NoteTag } from '@/lib/api';
import * as api from '@/lib/api';

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
  /**
   * Optimistic-concurrency baseline: the `updatedAt` (ISO string) of the note
   * as last loaded / saved. Web saves send `new Date(originalUpdatedAt)
   * .getTime()` as `expected_updated_at` so a stale write 409s instead of
   * clobbering a concurrent edit. `''` for never-saved drafts (no baseline →
   * POST, not CAS). Tracked on every host but only read on `remoteClient`.
   */
  originalUpdatedAt: string;
  dirty: boolean;
  /** True for `draft_xxx` ids that have never been POSTed yet. */
  isDraft: boolean;
  /** Set when an AI draft (create or update) is staged for save. */
  pendingAiUpdate: PendingAiUpdate | null;
  /**
   * VSCode-style preview flag. `true` = tab opened from a NoteList single
   * click / keyboard nav and is eligible to be **replaced** by the next
   * preview. `false` = "pinned" tab, stays put until explicit close.
   *
   * Invariants (see P3.4-e design doc):
   * - `openNote(note, {preview:true})` is the ONLY entry point that sets
   *   this true. Default is false.
   * - clean → dirty transition forces preview=false.
   * - `markSaved` / `stageAiUpdate` / `openAiDraft` / `replaceTabAfterCreate`
   *   all force preview=false — any tab with unsaved AI state or committed
   *   saves is user-authoritative, not ephemeral.
   * - Pinned (preview=false) is a one-way state; `openNote({preview:true})`
   *   on an already-pinned tab will NOT demote it.
   */
  preview: boolean;
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

/**
 * Active server-side version conflict (web optimistic concurrency). Non-null
 * after a `saveNote` PATCH 409'd with `VERSION_MISMATCH`: the local edits live
 * on the tab, `remote` is the freshly re-fetched server copy. Consumed by
 * `<VersionConflictDialog>`; resolved via `resolveVersionConflict`.
 */
export interface VersionConflict {
  tabId: string;
  remote: Note;
}

export type VersionConflictDecision = 'overwrite' | 'load-remote' | 'dismiss';

/**
 * Discriminated result of the whole save family (`saveNote` / `saveActiveNote`
 * / `saveDraft` / `requestSaveOrConflict` / `resolveVersionConflict` /
 * `resolveConflict`). The note-navigation guard (§4.1) reads `status` to tell a
 * real failure from a user-parked conflict from a no-op — a plain boolean
 * couldn't distinguish "409 dialog is up" from "save failed" from "dismissed":
 *   - `saved`     — persisted. `noteId` is the CURRENT id (a draft's real id
 *                   after create, otherwise the tab id).
 *   - `noop`      — nothing to persist, or resolved to a clean baseline → safe
 *                   to navigate away.
 *   - `conflict`  — a conflict dialog (AI `ConflictDialog` or web
 *                   `VersionConflictDialog`) is now showing; navigation pauses.
 *   - `failed`    — a real transport / daemon failure.
 *   - `cancelled` — the user kept their local edits (`dismiss`), or the session
 *                   switched mid-save → do not navigate, do not claim success.
 * `ok` is `true` for `saved` / `noop` only, so callers gate with `if (r.ok)`.
 */
export type SaveResult =
  | { status: 'saved' | 'noop'; ok: true; noteId: string | null }
  | { status: 'conflict' | 'failed' | 'cancelled'; ok: false; noteId: string | null };

/**
 * Result of `loadNoteById` — a pure fetch that never writes the store (unlike
 * `openNoteById`). The mobile master-detail resolver (§4.1.2) branches on it:
 *   - `found`     — render the note.
 *   - `not-found` — ONLY a 404 → the note is gone → show the empty state.
 *   - `stale`     — the session switched during the fetch → discard silently.
 * A 401 / network error / a 200 missing `data` (protocol error) is NOT modelled
 * here: `loadNoteById` rethrows those so the caller shows「加载失败·重试」rather
 * than mislabelling them as「不存在」.
 */
export type LoadNoteResult =
  | { status: 'found'; note: Note }
  | { status: 'not-found' }
  | { status: 'stale' };

/**
 * Result of `resolveOpen` — the mobile master-detail resolver behind
 * `/note/:id` (§4.1.1/4.1.2). EditorPage's effect commits it:
 *   - `opened`      — the note is staged (activated an open tab, or fetched +
 *                     opened as a preview) → render the editor.
 *   - `aliased`     — the URL still points at a saved draft's dead `draft_*` id;
 *                     canonical-`replace` to `realId` (§4.1.6 b).
 *   - `not-found`   — a 404 → the note is gone → empty state.
 *   - `load-failed` — 401 / network / protocol error → 加载失败·重试.
 *   - `stale`       — the session switched during the fetch → discard silently
 *                     (the epoch-keyed root remounts).
 */
export type ResolveOutcome =
  | { kind: 'opened' }
  | { kind: 'aliased'; realId: string }
  | { kind: 'not-found' }
  | { kind: 'load-failed' }
  | { kind: 'stale' };

/** Subset of the SSE `draft_ready` payload needed to seed a new draft tab. */
export interface AiDraftInput {
  note_id: string; // draft_<uuid>
  content: string;
  tags: string[]; // raw tag strings
  folder_id: string | null;
  action: 'create' | 'create_reminder';
}

// ─── Pure helpers ──────────────────────────────────────

/** Compare two NoteTag arrays by tagType:tagValue pairs (order-insensitive). */
export function tagsEqual(a: NoteTag[], b: NoteTag[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: NoteTag) => `${t.tagType}:${t.tagValue ?? ''}`;
  const setA = new Set(a.map(key));
  return b.every((t) => setA.has(key(t)));
}

/** Serialize NoteTag[] to raw tag strings for the daemon API. */
export function serializeTags(tags: NoteTag[]): string[] {
  return tags.map((t) => {
    if (t.tagType === '#') return `#${t.tagValue}`;
    if (['/daily', '/weekly', '/monthly', '/yearly'].includes(t.tagType)) return t.tagType;
    // /time, /alarm — tagType + space + tagValue (ISO datetime)
    return `${t.tagType} ${t.tagValue}`;
  });
}

/** Parse raw tag strings (as emitted by the daemon) back into NoteTag objects. */
export function deserializeTags(raw: string[]): NoteTag[] {
  return raw.map((s) => {
    if (s.startsWith('#')) return { id: s, tagType: '#', tagValue: s.slice(1) };
    const [type, ...rest] = s.split(' ');
    return { id: s, tagType: type, tagValue: rest.join(' ') || null };
  });
}

export function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 30) || '无标题';
}

/**
 * A tab counts as unsaved when any of dirty / isDraft / pendingAiUpdate
 * is truthy — same condition as the `saveNote` guard clause in editor-store.
 * Keep in sync; `UnsavedTabsDialog` reads it at quit time.
 */
export function isUnsaved(tab: TabState): boolean {
  return tab.dirty || tab.isDraft || tab.pendingAiUpdate !== null;
}

/**
 * Web optimistic-concurrency baseline for a PATCH. Returns the
 * `expected_updated_at` field when the host is a remote client and the tab has
 * a server version to check against; empty on desktop (= last-write-wins, the
 * existing behavior) and for never-saved drafts.
 */
export function casBaseline(
  tab: TabState,
  remoteClient: boolean,
): { expected_updated_at?: number } {
  return remoteClient && tab.originalUpdatedAt
    ? { expected_updated_at: new Date(tab.originalUpdatedAt).getTime() }
    : {};
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

/**
 * Map a `saveNote` failure to a version conflict, or null. Only a web 409
 * `VERSION_MISMATCH` qualifies: re-fetch the server copy so the UI can show
 * local-vs-remote. Any other failure (network, other 409 codes, desktop, or a
 * failed re-fetch) yields null → plain save-failed.
 */
export async function versionConflictFromError(
  err: unknown,
  noteId: string,
  remoteClient: boolean,
): Promise<VersionConflict | null> {
  const isMismatch =
    remoteClient &&
    err instanceof ApiError &&
    err.status === 409 &&
    err.errorCode === 'VERSION_MISMATCH';
  if (!isMismatch) return null;
  try {
    const fresh = await api.getNote(noteId);
    return fresh.data ? { tabId: noteId, remote: fresh.data } : null;
  } catch {
    return null;
  }
}
