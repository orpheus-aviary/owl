import { create } from 'zustand';
import { useEditorStore } from './editor-store';
import { type TabState, isUnsaved } from './editor-tabs';

/**
 * ⑤ note-navigation guard (mobile master-detail, §4.1.5a).
 *
 * The single owner of "open note B while note A may be unsaved" on the mobile
 * shell. NOT reused for the profile-level `switch-guard` (that gates a whole
 * session teardown) nor the quit-time `UnsavedDialog` (UI only). Desktop never
 * engages this — `useOpenNote` branches to a plain open + navigate there.
 *
 * Two hard problems it solves:
 *   - last-wins: a `navSeq` (bumped on every open + on reset) invalidates any
 *     in-flight open. After every await, callers check `navSeq === mySeq`; a
 *     superseded open resolves `cancelled` and never stages / navigates.
 *   - dirty current: when the active tab is unsaved, pause and prompt
 *     save / discard / cancel before leaving it.
 *
 * Navigation itself is injected (`NavContext`) because a store can't call
 * `useNavigate`; `useOpenNote` supplies it with LIVE getters so continuations
 * read the current route, not a stale closure (§4.1.6 a).
 */

export type OpenOutcome = 'opened' | 'cancelled' | 'failed';
export type PrepareResult = 'ok' | 'not-found' | 'stale' | 'failed';

export interface OpenNoteIntent {
  noteId: string;
  /**
   * Runs ONLY after the guard clears (not-dirty, or the user chose save/discard)
   * and BEFORE navigation commits. Stages whatever the target needs (AI draft /
   * update). Must self-check `isCurrent()` after each of its own awaits and bail
   * without writing the store when it returns false.
   */
  prepare?: (ctx: { isCurrent: () => boolean }) => Promise<PrepareResult> | PrepareResult;
}

/** History `state` written on every mobile note navigation (§4.1.3). */
export interface NavState {
  appNavigation: true;
  canPop: boolean;
  returnTo: string;
}

/** Router seam supplied per-call by `useOpenNote`; getters read live values. */
export interface NavContext {
  navigate: (to: string, opts: { replace: boolean; state: NavState }) => void;
  path: () => string;
  search: () => string;
  state: () => NavState | undefined;
}

export type NavChoice = 'save' | 'discard' | 'cancel';

type PromptPhase = 'prompting' | 'saving' | 'save-failed';

interface PendingOpen {
  intent: OpenNoteIntent;
  nav: NavContext;
  mySeq: number;
  currentId: string;
  title: string;
  resolve: (outcome: OpenOutcome) => void;
}

// Module-scoped so `isCurrent()` closures and the pending resolver survive
// re-renders (mirrors switch-guard's `pendingResolve`).
let navSeq = 0;
let pendingOpen: PendingOpen | null = null;

interface NoteNavGuardState {
  /** Non-null while the dirty-tab prompt is showing (drives the mobile dialog). */
  prompt: { title: string; phase: PromptPhase } | null;
  /** Open a note under the last-wins + dirty guard. Resolves the outcome. */
  open: (intent: OpenNoteIntent, nav: NavContext) => Promise<OpenOutcome>;
  /** Dialog button → settle the current prompt with the user's choice. */
  choose: (choice: NavChoice) => Promise<void>;
  /**
   * ③/§4.1.7 reset: bump navSeq so every in-flight open/prepare is invalidated,
   * settle any pending resolver as `cancelled`, and drop the prompt. Called by
   * `resetAllStores` on session teardown so no stale prepare stages/navigates
   * into the new account.
   */
  reset: () => void;
}

function activeUnsavedTab(): TabState | null {
  const { tabs, activeTabId } = useEditorStore.getState();
  const cur = tabs.find((t) => t.noteId === activeTabId);
  return cur && isUnsaved(cur) ? cur : null;
}

/**
 * Commit the navigation to `/note/:id`, writing `canPop` / `returnTo` so the
 * top-bar back button knows whether to pop or jump to the source page (§4.1.3).
 * On a detail→detail move we `replace` (no duplicate history entry) and inherit
 * the origin's canPop/returnTo; from a master page we push and record it.
 */
function commitNavigation(noteId: string, nav: NavContext): void {
  const isDetail = nav.path().startsWith('/note/');
  const cur = nav.state();
  nav.navigate(`/note/${noteId}`, {
    replace: isDetail,
    state: {
      appNavigation: true,
      canPop: isDetail ? (cur?.canPop ?? false) : true,
      returnTo: isDetail ? (cur?.returnTo ?? '/') : nav.path() + nav.search(),
    },
  });
}

async function runOpen(
  intent: OpenNoteIntent,
  nav: NavContext,
  mySeq: number,
  opts?: { closeAfterPrepareOk?: string },
): Promise<OpenOutcome> {
  if (intent.prepare) {
    const pr = await intent.prepare({ isCurrent: () => navSeq === mySeq });
    if (navSeq !== mySeq) return 'cancelled'; // superseded mid-prepare
    if (pr !== 'ok') return pr === 'failed' ? 'failed' : 'cancelled'; // not-found/stale → no nav
  }
  // Discard: only NOW that the target prepared OK do we drop the old dirty tab,
  // so a failed prepare never loses the user's current work.
  if (opts?.closeAfterPrepareOk) useEditorStore.getState().closeTab(opts.closeAfterPrepareOk);
  commitNavigation(intent.noteId, nav);
  return 'opened';
}

export const useNoteNavGuard = create<NoteNavGuardState>((set) => {
  const settlePending = (outcome: OpenOutcome): void => {
    const p = pendingOpen;
    pendingOpen = null;
    set({ prompt: null });
    p?.resolve(outcome);
  };

  return {
    prompt: null,

    open: (intent, nav) => {
      const mySeq = ++navSeq; // supersede any older in-flight open
      // Any prompt still waiting on the user is now stale — settle it cancelled.
      settlePending('cancelled');

      const current = activeUnsavedTab();
      if (!current) return runOpen(intent, nav, mySeq);

      // Dirty current → pause and prompt; the outcome resolves via `choose`.
      return new Promise<OpenOutcome>((resolve) => {
        pendingOpen = {
          intent,
          nav,
          mySeq,
          currentId: current.noteId,
          title: current.title,
          resolve,
        };
        set({ prompt: { title: current.title, phase: 'prompting' } });
      });
    },

    choose: async (choice) => {
      const p = pendingOpen;
      if (!p) return;
      const { intent, nav, mySeq, currentId, resolve } = p;

      if (choice === 'cancel') {
        settlePending('cancelled');
        return;
      }

      if (choice === 'discard') {
        pendingOpen = null;
        set({ prompt: null });
        resolve(await runOpen(intent, nav, mySeq, { closeAfterPrepareOk: currentId }));
        return;
      }

      // save
      set({ prompt: { title: p.title, phase: 'saving' } });
      const r = await useEditorStore.getState().requestSaveOrConflict(currentId);
      // Superseded (new open / session reset) while saving → drop out.
      if (navSeq !== mySeq) {
        settlePending('cancelled');
        return;
      }
      if (r.ok) {
        // saved | noop → the tab stays open (saved tabs are user-authoritative);
        // proceed to the target.
        pendingOpen = null;
        set({ prompt: null });
        resolve(await runOpen(intent, nav, mySeq));
        return;
      }
      if (r.status === 'conflict') {
        // A version / AI conflict dialog just took over. Stand down; the user
        // re-triggers the open after resolving.
        settlePending('cancelled');
        return;
      }
      // failed / cancelled → keep the prompt open so the user can retry / cancel.
      set({ prompt: { title: activeUnsavedTab()?.title ?? '', phase: 'save-failed' } });
    },

    reset: () => {
      navSeq++; // invalidate every in-flight open + preparing intent
      settlePending('cancelled');
    },
  };
});
