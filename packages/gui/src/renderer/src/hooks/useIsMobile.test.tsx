import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsMobile } from './useIsMobile';

// remoteClient is the hard gate: desktop (Electron) is always non-mobile and
// must never even attach a media-query listener. Mock the platform so each
// test drives the host branch independently.
const platformMock = vi.hoisted(() => ({ remoteClient: true }));
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: platformMock.remoteClient }),
}));

// jsdom ships no matchMedia — install a controllable stub. All MediaQueryList
// instances share one listener set + one `matches` value so a change fired via
// `setMatches` reaches the listener the hook registered (which lives on a
// different object instance than the one getSnapshot reads).
type Listener = () => void;
const media = { matches: false, listeners: new Set<Listener>() };

function installMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return media.matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: Listener) => media.listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => media.listeners.delete(cb),
    addListener: (cb: Listener) => media.listeners.add(cb),
    removeListener: (cb: Listener) => media.listeners.delete(cb),
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
}

function setMatches(value: boolean): void {
  media.matches = value;
  for (const cb of media.listeners) cb();
}

describe('useIsMobile', () => {
  beforeEach(() => {
    platformMock.remoteClient = true;
    media.matches = false;
    media.listeners.clear();
    installMatchMedia();
  });

  afterEach(() => {
    // @ts-expect-error — jsdom has no matchMedia to restore to.
    window.matchMedia = undefined;
  });

  it('is false on the desktop host even when the viewport is narrow', () => {
    platformMock.remoteClient = false;
    media.matches = true;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('never attaches a listener on the desktop host', () => {
    platformMock.remoteClient = false;
    renderHook(() => useIsMobile());
    expect(media.listeners.size).toBe(0);
  });

  it('is true on web when the viewport is phone-width', () => {
    media.matches = true;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('is false on web when the viewport is wide', () => {
    media.matches = false;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('re-renders when the viewport crosses the breakpoint', () => {
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    act(() => setMatches(true));
    expect(result.current).toBe(true);
    act(() => setMatches(false));
    expect(result.current).toBe(false);
  });

  it('falls back to false when matchMedia is unavailable', () => {
    // @ts-expect-error — simulate an environment without matchMedia.
    window.matchMedia = undefined;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });
});
