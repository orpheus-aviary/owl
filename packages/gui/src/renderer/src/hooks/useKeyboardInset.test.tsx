import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useKeyboardInset } from './useKeyboardInset';

// jsdom ships no visualViewport — install a controllable stub. One shared
// object backs both the getter reads and the listener set so a `fire()` reaches
// the hook's subscription.
type Listener = () => void;
const vv = { height: 800, offsetTop: 0, scale: 1, listeners: new Set<Listener>() };

function installVV(): void {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      get height() {
        return vv.height;
      },
      get offsetTop() {
        return vv.offsetTop;
      },
      get offsetLeft() {
        return 0;
      },
      get scale() {
        return vv.scale;
      },
      addEventListener: (_: string, cb: Listener) => vv.listeners.add(cb),
      removeEventListener: (_: string, cb: Listener) => vv.listeners.delete(cb),
    },
  });
}

function fire(): void {
  for (const cb of vv.listeners) cb();
}

function removeVV(): void {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
}

let input: HTMLInputElement;

beforeEach(() => {
  vv.height = 800;
  vv.offsetTop = 0;
  vv.scale = 1;
  vv.listeners.clear();
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  installVV();
  input = document.createElement('input');
  document.body.appendChild(input);
});

afterEach(() => {
  input.remove();
  removeVV();
});

describe('useKeyboardInset', () => {
  it('is 0 when there is no visualViewport', () => {
    removeVV(); // simulate an unsupported environment
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });

  it('is 0 when no editable element is focused', () => {
    vv.height = 500; // keyboard-sized, but nothing focused
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });

  it('reports the covered height when a field is focused and the keyboard is up', () => {
    input.focus();
    vv.height = 500; // 800 layout − 500 visual = 300 keyboard
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(300);
  });

  it('is 0 while pinch-zoomed (scale ≠ 1) even with a field focused', () => {
    input.focus();
    vv.height = 500;
    vv.scale = 1.5;
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });

  it('updates when the visual viewport resizes', () => {
    input.focus();
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0); // keyboard closed
    act(() => {
      vv.height = 460; // keyboard opens → 340
      fire();
    });
    expect(result.current).toBe(340);
  });
});
