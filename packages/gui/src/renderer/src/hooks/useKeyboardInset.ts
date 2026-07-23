// Step 9 (§4.2) — soft-keyboard inset for the floating mobile TagBar. Returns
// the height (px) the on-screen keyboard covers at the bottom of the layout
// viewport, so a `position: fixed; bottom: <inset>` bar rides just above it.
//
// The inset is gated so it's only non-zero when it genuinely means "keyboard up":
//   - `visualViewport` must exist (desktop / Electron / old browsers → 0, and the
//     TagBar stays a normal in-flow bar).
//   - an editable field must be focused (CodeMirror's content area or the tag
//     input) — otherwise a viewport resize is address-bar chrome, not a keyboard.
//   - the page must not be pinch-zoomed (`scale ≈ 1`); a zoomed visual viewport
//     makes the height math meaningless, so we bail to 0.
//
// ⚠️ REAL-DEVICE: the desktop dev rig can't raise a soft keyboard (DevTools emits
// no keyboard `visualViewport` resize), so the floating path is verified on a
// real phone at Stage 2. The graceful path (no keyboard → 0 → normal in-flow
// bar) is what the rig exercises, and desktop stays a hard 0.

import { useSyncExternalStore } from 'react';

const SCALE_TOLERANCE = 0.05;

function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

function computeInset(): number {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return 0;
  if (Math.abs(vv.scale - 1) > SCALE_TOLERANCE) return 0;
  if (!isEditableFocused()) return 0;
  const inset = window.innerHeight - vv.height - vv.offsetTop;
  return inset > 0 ? Math.round(inset) : 0;
}

function subscribe(onChange: () => void): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  // Focus changes flip the gate even when the viewport size is unchanged.
  document.addEventListener('focusin', onChange);
  document.addEventListener('focusout', onChange);
  return () => {
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
    document.removeEventListener('focusin', onChange);
    document.removeEventListener('focusout', onChange);
  };
}

/** Soft-keyboard inset in px (0 when no keyboard / no visualViewport / desktop). */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, computeInset, () => 0);
}
