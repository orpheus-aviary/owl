// Mobile-shell breakpoint (Stage 1 #5). `useIsMobile()` is the single switch
// that flips the app between the desktop multi-pane shell and the mobile
// bottom-nav shell.
//
// Two conditions, both required:
//   1. `remoteClient` — only the web host can ever be a phone. Electron is
//      pinned to the desktop shell (main sets `minWidth = 600`), so this hook
//      is a hard `false` there and never attaches a media-query listener.
//   2. `matchMedia('(max-width: 767.98px)')` — the viewport is phone-width.
//      767.98 (not 768) avoids a fractional-pixel gap at the Tailwind `md`
//      boundary where neither `max-width:767px` nor `min-width:768px` matches.
//
// Subscribed via `useSyncExternalStore` so a device rotation / window resize
// that crosses the breakpoint re-renders every consumer.

import { getPlatform } from '@/platform';
import { useSyncExternalStore } from 'react';

const MOBILE_QUERY = '(max-width: 767.98px)';

function mediaAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    getPlatform().remoteClient
  );
}

function subscribe(onChange: () => void): () => void {
  if (!mediaAvailable()) return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (!mediaAvailable()) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

/** True only when running as a web client AND the viewport is phone-width. */
export function useIsMobile(): boolean {
  // Server snapshot is `false`: SSR / non-DOM renders default to desktop.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
