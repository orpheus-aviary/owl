import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from './editor-store';
import type { SaveResult, TabState } from './editor-store';
import {
  type NavContext,
  type NavState,
  type PrepareResult,
  useNoteNavGuard,
} from './note-nav-guard';

// The guard reads platform.remoteClient transitively via editor-store; a minimal
// mock keeps that import from touching the real adapter.
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: false, daemonBaseUrl: () => '' }),
}));

function tab(noteId: string, opts?: Partial<TabState>): TabState {
  return {
    noteId,
    title: noteId,
    content: '',
    originalContent: '',
    tags: [],
    originalTags: [],
    folderId: null,
    originalFolderId: null,
    originalUpdatedAt: '',
    dirty: false,
    isDraft: false,
    pendingAiUpdate: null,
    preview: false,
    ...opts,
  };
}

function makeNav(over?: { path?: string; search?: string; state?: NavState }) {
  const navigate = vi.fn();
  const nav: NavContext = {
    navigate,
    path: () => over?.path ?? '/',
    search: () => over?.search ?? '',
    state: () => over?.state,
  };
  return { nav, navigate };
}

const guard = () => useNoteNavGuard.getState();

beforeEach(() => {
  useNoteNavGuard.getState().reset();
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

describe('note-nav-guard — clean current', () => {
  it('navigates immediately and returns opened', async () => {
    const { nav, navigate } = makeNav();
    const outcome = await guard().open({ noteId: 'n2' }, nav);
    expect(outcome).toBe('opened');
    expect(navigate).toHaveBeenCalledWith('/note/n2', expect.anything());
    expect(guard().prompt).toBeNull();
  });

  it('runs prepare, then navigates on ok', async () => {
    const { nav, navigate } = makeNav();
    const prepare = vi.fn((): PrepareResult => 'ok');
    const outcome = await guard().open({ noteId: 'n2', prepare }, nav);
    expect(prepare).toHaveBeenCalledOnce();
    expect(outcome).toBe('opened');
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('prepare not-found → cancelled, no navigation', async () => {
    const { nav, navigate } = makeNav();
    const outcome = await guard().open({ noteId: 'n2', prepare: () => 'not-found' }, nav);
    expect(outcome).toBe('cancelled');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('prepare failed → failed, no navigation', async () => {
    const { nav, navigate } = makeNav();
    const outcome = await guard().open({ noteId: 'n2', prepare: () => 'failed' }, nav);
    expect(outcome).toBe('failed');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('note-nav-guard — last-wins', () => {
  it('a superseded open resolves cancelled and never navigates', async () => {
    let releaseA: () => void = () => {};
    const prepareA = vi.fn(
      () =>
        new Promise<PrepareResult>((res) => {
          releaseA = () => res('ok');
        }),
    );
    const a = makeNav();
    const b = makeNav();

    const pA = guard().open({ noteId: 'A', prepare: prepareA }, a.nav); // awaits prepareA
    const pB = guard().open({ noteId: 'B' }, b.nav); // supersedes, navigates now

    expect(await pB).toBe('opened');
    expect(b.navigate).toHaveBeenCalledWith('/note/B', expect.anything());

    releaseA(); // A's prepare finally resolves, but A is stale
    expect(await pA).toBe('cancelled');
    expect(a.navigate).not.toHaveBeenCalled();
  });

  it('prepare sees isCurrent()=false once superseded', async () => {
    let seen: boolean | null = null;
    let releaseA: () => void = () => {};
    const prepareA = vi.fn(
      ({ isCurrent }: { isCurrent: () => boolean }) =>
        new Promise<PrepareResult>((res) => {
          releaseA = () => {
            seen = isCurrent();
            res('ok');
          };
        }),
    );
    const pA = guard().open({ noteId: 'A', prepare: prepareA }, makeNav().nav);
    await guard().open({ noteId: 'B' }, makeNav().nav);
    releaseA();
    await pA;
    expect(seen).toBe(false);
  });
});

describe('note-nav-guard — dirty current prompt', () => {
  const dirty = () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
  };

  it('opens the prompt instead of navigating', () => {
    dirty();
    const { nav, navigate } = makeNav();
    void guard().open({ noteId: 'n2' }, nav);
    expect(guard().prompt).toEqual({ title: 'n1', phase: 'prompting', kind: 'open' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cancel → cancelled, prompt cleared, no navigation', async () => {
    dirty();
    const { nav, navigate } = makeNav();
    const p = guard().open({ noteId: 'n2' }, nav);
    await guard().choose('cancel');
    expect(await p).toBe('cancelled');
    expect(guard().prompt).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('discard → closes the dirty tab (after prepare) and navigates', async () => {
    dirty();
    const { nav, navigate } = makeNav();
    const p = guard().open({ noteId: 'n2' }, nav);
    await guard().choose('discard');
    expect(await p).toBe('opened');
    expect(useEditorStore.getState().tabs.find((t) => t.noteId === 'n1')).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('/note/n2', expect.anything());
  });

  it('discard with a failing prepare → keeps the dirty tab, no navigation', async () => {
    dirty();
    const { nav, navigate } = makeNav();
    const p = guard().open({ noteId: 'n2', prepare: () => 'failed' }, nav);
    await guard().choose('discard');
    expect(await p).toBe('failed');
    // The current work is NOT lost when the target couldn't prepare.
    expect(useEditorStore.getState().tabs.find((t) => t.noteId === 'n1')).toBeDefined();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('save success → navigates, dirty tab stays open', async () => {
    dirty();
    const saved: SaveResult = { status: 'saved', ok: true, noteId: 'n1' };
    useEditorStore.setState({ requestSaveOrConflict: vi.fn(async () => saved) });
    const { nav, navigate } = makeNav();
    const p = guard().open({ noteId: 'n2' }, nav);
    await guard().choose('save');
    expect(await p).toBe('opened');
    expect(navigate).toHaveBeenCalledWith('/note/n2', expect.anything());
    // A saved tab is user-authoritative — not closed (§4.1.5).
    expect(useEditorStore.getState().tabs.find((t) => t.noteId === 'n1')).toBeDefined();
  });

  it('save raises a conflict → cancelled, no navigation', async () => {
    dirty();
    const conflict: SaveResult = { status: 'conflict', ok: false, noteId: 'n1' };
    useEditorStore.setState({ requestSaveOrConflict: vi.fn(async () => conflict) });
    const { nav, navigate } = makeNav();
    const p = guard().open({ noteId: 'n2' }, nav);
    await guard().choose('save');
    expect(await p).toBe('cancelled');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('save fails → prompt goes to save-failed and awaits retry/cancel', async () => {
    dirty();
    const failed: SaveResult = { status: 'failed', ok: false, noteId: 'n1' };
    useEditorStore.setState({ requestSaveOrConflict: vi.fn(async () => failed) });
    const { nav, navigate } = makeNav();
    const p = guard().open({ noteId: 'n2' }, nav);
    await guard().choose('save');
    expect(guard().prompt).toEqual({ title: 'n1', phase: 'save-failed', kind: 'open' });
    expect(navigate).not.toHaveBeenCalled();
    // The open promise is still pending; a follow-up cancel settles it.
    await guard().choose('cancel');
    expect(await p).toBe('cancelled');
  });
});

describe('note-nav-guard — open-current (打开笔记)', () => {
  it('open context → jumps to the dirty note, abandons opening B, cancelled', async () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    const { nav, navigate } = makeNav({ path: '/browser' });
    const p = guard().open({ noteId: 'n2' }, nav);
    await guard().choose('open-current');
    expect(await p).toBe('cancelled'); // B (n2) was NOT opened
    // Navigated to the unsaved note (n1), not the tapped one (n2).
    expect(navigate).toHaveBeenCalledWith('/note/n1', expect.anything());
    expect(navigate).not.toHaveBeenCalledWith('/note/n2', expect.anything());
    expect(guard().prompt).toBeNull();
  });
});

describe('note-nav-guard — requestLeave (返回)', () => {
  it('clean current → proceeds immediately, no prompt', async () => {
    useEditorStore.setState({ tabs: [tab('n1')], activeTabId: 'n1' });
    const back = vi.fn();
    const outcome = await guard().requestLeave(back);
    expect(outcome).toBe('opened');
    expect(back).toHaveBeenCalledOnce();
    expect(guard().prompt).toBeNull();
  });

  it('dirty current → prompt with kind:leave', () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    void guard().requestLeave(vi.fn());
    expect(guard().prompt).toEqual({ title: 'n1', phase: 'prompting', kind: 'leave' });
  });

  it('discard → closes the tab and runs the back-navigation', async () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    const back = vi.fn();
    const p = guard().requestLeave(back);
    await guard().choose('discard');
    expect(await p).toBe('opened');
    expect(useEditorStore.getState().tabs.find((t) => t.noteId === 'n1')).toBeUndefined();
    expect(back).toHaveBeenCalledOnce();
  });

  it('save success → runs the back-navigation, tab stays', async () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    const saved: SaveResult = { status: 'saved', ok: true, noteId: 'n1' };
    useEditorStore.setState({ requestSaveOrConflict: vi.fn(async () => saved) });
    const back = vi.fn();
    const p = guard().requestLeave(back);
    await guard().choose('save');
    expect(await p).toBe('opened');
    expect(back).toHaveBeenCalledOnce();
    expect(useEditorStore.getState().tabs.find((t) => t.noteId === 'n1')).toBeDefined();
  });

  it('open-current (继续编辑) → stays on the note, back NOT run', async () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    const back = vi.fn();
    const p = guard().requestLeave(back);
    await guard().choose('open-current');
    expect(await p).toBe('cancelled');
    expect(back).not.toHaveBeenCalled(); // stayed put; no navigation
    expect(guard().prompt).toBeNull();
  });
});

describe('note-nav-guard — navigation state (canPop / returnTo, §4.1.3)', () => {
  it('from a master page: pushes, canPop true, returnTo = origin', async () => {
    const { nav, navigate } = makeNav({ path: '/browser', search: '?q=x' });
    await guard().open({ noteId: 'n2' }, nav);
    expect(navigate).toHaveBeenCalledWith('/note/n2', {
      replace: false,
      state: { appNavigation: true, canPop: true, returnTo: '/browser?q=x' },
    });
  });

  it('from a detail page: replaces and inherits canPop/returnTo', async () => {
    const { nav, navigate } = makeNav({
      path: '/note/n1',
      state: { appNavigation: true, canPop: false, returnTo: '/browser' },
    });
    await guard().open({ noteId: 'n2' }, nav);
    expect(navigate).toHaveBeenCalledWith('/note/n2', {
      replace: true,
      state: { appNavigation: true, canPop: false, returnTo: '/browser' },
    });
  });
});

describe('note-nav-guard — reset', () => {
  it('settles a pending open cancelled and clears the prompt', async () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    const p = guard().open({ noteId: 'n2' }, makeNav().nav);
    expect(guard().prompt).not.toBeNull();
    guard().reset();
    expect(await p).toBe('cancelled');
    expect(guard().prompt).toBeNull();
  });
});
