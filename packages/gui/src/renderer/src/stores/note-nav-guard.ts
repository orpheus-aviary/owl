import { create } from 'zustand';
import { useEditorStore } from './editor-store';
import { type TabState, isUnsaved } from './editor-tabs';

/**
 * ⑤ note-navigation guard (mobile, §4.1.5a + revised nav model).
 *
 * The single owner of "the current note may be unsaved, but the user wants to
 * move on" on the mobile shell — covering BOTH:
 *   - `open(intent)`  — opening ANOTHER note (from 浏览 / 文件 / AI / a pill).
 *   - `requestLeave(proceed)` — leaving the editor detail (the top-bar 返回).
 * NOT reused for the profile-level `switch-guard` (whole-session teardown) nor
 * the quit-time `UnsavedTabsDialog` (UI only). Desktop never engages this —
 * `useOpenNote` branches to a plain open + navigate there, and the desktop
 * editor has its own tab-close prompt.
 *
 * Two hard problems it solves:
 *   - last-wins: a `navSeq` (bumped on every open/leave + on reset) invalidates
 *     any in-flight request. After every await, callers check `navSeq === mySeq`;
 *     a superseded request resolves `cancelled` and never stages / navigates.
 *   - dirty current: when the active tab is unsaved, pause and prompt
 *     save / discard / open-current before abandoning its edits.
 *
 * The dirty prompt offers THREE choices (§ revised): 保存 / 放弃 / 打开笔记.
 * The prompt ALWAYS concerns exactly one note — the active dirty tab
 * (`currentId`). So 打开笔记 (`open-current`) is unambiguous: it navigates to
 * THAT note, even in the rare case (AI-staged background edits) where more than
 * one tab is dirty. And because opening/leaving another note must first resolve
 * the current dirty one, manual editing structurally never accumulates more
 * than one dirty tab.
 *
 * Navigation is injected (`NavContext`) because a store can't call
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

export type NavChoice = 'save' | 'discard' | 'cancel' | 'open-current';

type PromptPhase = 'prompting' | 'saving' | 'save-failed';
/** `open` = opening another note; `leave` = leaving the editor via 返回. Only the
 *  label of the third button (`打开笔记` vs `继续编辑`) differs. */
type PromptKind = 'open' | 'leave';

interface PendingBase {
  mySeq: number;
  currentId: string;
  title: string;
  resolve: (outcome: OpenOutcome) => void;
}
/** Opening another note while the current one is dirty. */
interface PendingOpen extends PendingBase {
  kind: 'open';
  intent: OpenNoteIntent;
  nav: NavContext;
}
/** Leaving the editor (top-bar 返回) while the current note is dirty. */
interface PendingLeave extends PendingBase {
  kind: 'leave';
  /** The actual back-navigation, run after save/discard resolves. */
  proceed: () => void;
}
type Pending = PendingOpen | PendingLeave;

// Module-scoped so `isCurrent()` closures and the pending resolver survive
// re-renders (mirrors switch-guard's `pendingResolve`).
let navSeq = 0;
let pending: Pending | null = null;

interface NoteNavGuardState {
  /** Non-null while the dirty-tab prompt is showing (drives the mobile dialog). */
  prompt: { title: string; phase: PromptPhase; kind: PromptKind } | null;
  /** Open a note under the last-wins + dirty guard. Resolves the outcome. */
  open: (intent: OpenNoteIntent, nav: NavContext) => Promise<OpenOutcome>;
  /**
   * Leave the current note (top-bar 返回). If the active tab is clean, `proceed`
   * runs immediately; if dirty, prompt 保存 / 放弃 / 继续编辑 first. Resolves
   * `opened` once the leave commits, `cancelled` if the user stays.
   */
  requestLeave: (proceed: () => void) => Promise<OpenOutcome>;
  /** Dialog button → settle the current prompt with the user's choice. */
  choose: (choice: NavChoice) => Promise<void>;
  /**
   * ③/§4.1.7 reset: bump navSeq so every in-flight request is invalidated,
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
    const p = pending;
    pending = null;
    set({ prompt: null });
    p?.resolve(outcome);
  };

  /** Run the pending's forward action (open B, or the back-navigation). */
  const proceedPending = async (p: Pending): Promise<OpenOutcome> => {
    if (p.kind === 'open') return runOpen(p.intent, p.nav, p.mySeq);
    p.proceed();
    return 'opened';
  };

  /** 打开笔记: jump to (open) or stay on the single dirty note this prompt is
   *  about, abandoning the pending forward action (open B / back-navigation). */
  const chooseOpenCurrent = (p: Pending): void => {
    pending = null;
    set({ prompt: null });
    if (p.kind === 'open') commitNavigation(p.currentId, p.nav);
    p.resolve('cancelled'); // the pending action didn't happen
  };

  const chooseDiscard = async (p: Pending): Promise<void> => {
    pending = null;
    set({ prompt: null });
    if (p.kind === 'open') {
      // runOpen drops the current dirty tab only after B's prepare succeeds.
      p.resolve(await runOpen(p.intent, p.nav, p.mySeq, { closeAfterPrepareOk: p.currentId }));
      return;
    }
    // No target prepare on a leave — drop the tab and go.
    useEditorStore.getState().closeTab(p.currentId);
    p.proceed();
    p.resolve('opened');
  };

  const chooseSave = async (p: Pending): Promise<void> => {
    set({ prompt: { title: p.title, phase: 'saving', kind: p.kind } });
    const r = await useEditorStore.getState().requestSaveOrConflict(p.currentId);
    // Superseded (new request / session reset) while saving → drop out.
    if (navSeq !== p.mySeq) return settlePending('cancelled');
    if (r.ok) {
      // saved | noop → the tab stays open (saved tabs are user-authoritative);
      // proceed to the forward action.
      pending = null;
      set({ prompt: null });
      p.resolve(await proceedPending(p));
      return;
    }
    if (r.status === 'conflict') {
      // A version / AI conflict dialog just took over. Stand down; the user
      // re-triggers after resolving.
      return settlePending('cancelled');
    }
    // failed / cancelled → keep the prompt open so the user can retry / cancel.
    set({ prompt: { title: activeUnsavedTab()?.title ?? '', phase: 'save-failed', kind: p.kind } });
  };

  return {
    prompt: null,

    open: (intent, nav) => {
      const mySeq = ++navSeq; // supersede any older in-flight request
      settlePending('cancelled');

      const current = activeUnsavedTab();
      if (!current) return runOpen(intent, nav, mySeq);

      return new Promise<OpenOutcome>((resolve) => {
        pending = {
          kind: 'open',
          intent,
          nav,
          mySeq,
          currentId: current.noteId,
          title: current.title,
          resolve,
        };
        set({ prompt: { title: current.title, phase: 'prompting', kind: 'open' } });
      });
    },

    requestLeave: (proceed) => {
      const mySeq = ++navSeq;
      settlePending('cancelled');

      const current = activeUnsavedTab();
      if (!current) {
        proceed();
        return Promise.resolve('opened');
      }

      return new Promise<OpenOutcome>((resolve) => {
        pending = {
          kind: 'leave',
          proceed,
          mySeq,
          currentId: current.noteId,
          title: current.title,
          resolve,
        };
        set({ prompt: { title: current.title, phase: 'prompting', kind: 'leave' } });
      });
    },

    choose: async (choice) => {
      const p = pending;
      if (!p) return;
      if (choice === 'cancel') return settlePending('cancelled');
      if (choice === 'open-current') return chooseOpenCurrent(p);
      if (choice === 'discard') return chooseDiscard(p);
      return chooseSave(p);
    },

    reset: () => {
      navSeq++; // invalidate every in-flight request + preparing intent
      settlePending('cancelled');
    },
  };
});
