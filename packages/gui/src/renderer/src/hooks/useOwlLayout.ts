import { useDefaultLayout } from 'react-resizable-panels';

/**
 * Thin wrapper around `useDefaultLayout` that pins the storage to
 * `window.localStorage`. Electron renderer always has window, so the
 * SSR-safe branch the library documents is unnecessary here.
 */
export function useOwlLayout(id: string) {
  return useDefaultLayout({ id, storage: window.localStorage });
}
