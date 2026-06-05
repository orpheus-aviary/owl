import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── electron mock ────────────────────────────────────────────────────

const appState = {
  gotLock: true,
  quitCalls: 0,
  handlers: {} as Record<string, () => void>,
};
const windows: Array<{
  isMinimized: () => boolean;
  isVisible: () => boolean;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => appState.gotLock,
    quit: () => {
      appState.quitCalls++;
    },
    on: (event: string, handler: () => void) => {
      appState.handlers[event] = handler;
    },
  },
  BrowserWindow: {
    getAllWindows: () => windows,
  },
}));

import { acquireSingleInstanceLock } from './single-instance.js';

beforeEach(() => {
  appState.gotLock = true;
  appState.quitCalls = 0;
  appState.handlers = {};
  windows.length = 0;
});

describe('acquireSingleInstanceLock', () => {
  it('returns true and registers a second-instance handler when the lock is held', () => {
    expect(acquireSingleInstanceLock()).toBe(true);
    expect(appState.quitCalls).toBe(0);
    expect(typeof appState.handlers['second-instance']).toBe('function');
  });

  it('quits and returns false when another instance already holds the lock', () => {
    appState.gotLock = false;
    expect(acquireSingleInstanceLock()).toBe(false);
    expect(appState.quitCalls).toBe(1);
    expect(appState.handlers['second-instance']).toBeUndefined();
  });

  it('second-instance restores + shows + focuses the existing window', () => {
    const win = {
      isMinimized: () => true,
      isVisible: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    windows.push(win);
    acquireSingleInstanceLock();
    appState.handlers['second-instance']();
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it('second-instance only focuses (no restore/show) a visible, non-minimized window', () => {
    const win = {
      isMinimized: () => false,
      isVisible: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    windows.push(win);
    acquireSingleInstanceLock();
    appState.handlers['second-instance']();
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it('second-instance is a no-op when there is no window', () => {
    acquireSingleInstanceLock();
    expect(() => appState.handlers['second-instance']()).not.toThrow();
  });
});
