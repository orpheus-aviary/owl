import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebUnloadGuard } from './useWebUnloadGuard';

// remoteClient gates the whole guard; hasUnsavedTabs gates whether a given
// unload is blocked. Mock both so each test drives them independently.
const platformMock = vi.hoisted(() => ({ remoteClient: true }));
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: platformMock.remoteClient }),
}));

const storeMock = vi.hoisted(() => ({ unsaved: false }));
vi.mock('@/stores/editor-store', () => ({
  useEditorStore: { getState: () => ({ hasUnsavedTabs: () => storeMock.unsaved }) },
}));

/** Fire a cancelable `beforeunload` and report whether a handler blocked it. */
function dispatchBeforeUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('useWebUnloadGuard', () => {
  beforeEach(() => {
    platformMock.remoteClient = true;
    storeMock.unsaved = false;
  });

  it('blocks unload on web when a tab is unsaved', () => {
    storeMock.unsaved = true;
    renderHook(() => useWebUnloadGuard());
    expect(dispatchBeforeUnload()).toBe(true);
  });

  it('allows unload on web when nothing is unsaved', () => {
    storeMock.unsaved = false;
    renderHook(() => useWebUnloadGuard());
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it('never registers a listener on the desktop host', () => {
    platformMock.remoteClient = false;
    storeMock.unsaved = true; // would block if the guard were active
    renderHook(() => useWebUnloadGuard());
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it('removes the listener on unmount', () => {
    storeMock.unsaved = true;
    const { unmount } = renderHook(() => useWebUnloadGuard());
    expect(dispatchBeforeUnload()).toBe(true);
    unmount();
    expect(dispatchBeforeUnload()).toBe(false);
  });
});
