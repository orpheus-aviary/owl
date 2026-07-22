import { openNoteById } from '@/stores/editor-store';
import {
  type NavContext,
  type NavState,
  type OpenNoteIntent,
  type OpenOutcome,
  useNoteNavGuard,
} from '@/stores/note-nav-guard';
import { currentGen, isStale } from '@/stores/session-epoch';
import { useCallback, useRef } from 'react';
import { type NavigateFunction, useLocation, useNavigate } from 'react-router-dom';
import { useIsMobile } from './useIsMobile';

/**
 * The single note-opening entry (§4.1). Callers pass an `OpenNoteIntent`
 * (`{ noteId, prepare? }`) and await an `OpenOutcome`; only `'opened'` (=
 * navigation committed) should trigger side effects like marking an AI draft
 * consumed or dismissing a toast.
 *
 * Desktop (`!isMobile`) keeps the pre-contract behavior byte-for-byte: run
 * `prepare` if present, else `openNoteById`, then `navigate('/')` — the tabbed
 * editor, no route param. Mobile hands off to the `note-nav-guard` (last-wins +
 * dirty prompt + `/note/:id` master-detail navigation).
 */

async function openDesktop(
  intent: OpenNoteIntent,
  navigate: NavigateFunction,
): Promise<OpenOutcome> {
  const gen = currentGen();
  try {
    if (intent.prepare) {
      const pr = await intent.prepare({ isCurrent: () => !isStale(gen) });
      if (isStale(gen)) return 'cancelled';
      if (pr === 'failed') return 'failed';
      // not-found / stale fall through: desktop always navigates to the editor,
      // which then renders whatever the store holds — byte-identical to the
      // pre-contract path that navigated after writing the store.
    } else {
      await openNoteById(intent.noteId);
      if (isStale(gen)) return 'cancelled';
    }
    navigate('/');
    return 'opened';
  } catch {
    return 'failed';
  }
}

export function useOpenNote(): (intent: OpenNoteIntent) => Promise<OpenOutcome> {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  // Live ref so the guard's async continuations read the CURRENT route after
  // each await (canPop / returnTo), not the closure captured at call time.
  const locationRef = useRef(location);
  locationRef.current = location;

  return useCallback(
    (intent: OpenNoteIntent) => {
      if (!isMobile) return openDesktop(intent, navigate);
      const nav: NavContext = {
        navigate: (to, opts) => navigate(to, opts),
        path: () => locationRef.current.pathname,
        search: () => locationRef.current.search,
        state: () => locationRef.current.state as NavState | undefined,
      };
      return useNoteNavGuard.getState().open(intent, nav);
    },
    [isMobile, navigate],
  );
}
