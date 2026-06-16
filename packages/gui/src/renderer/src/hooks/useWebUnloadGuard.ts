import { getPlatform } from '@/platform';
import { useEditorStore } from '@/stores/editor-store';
import { useEffect } from 'react';

/**
 * Web-only unsaved-work guard. On the web host the session token is in-memory,
 * so a refresh / tab-close loses any unsaved editor state — warn before unload
 * while any tab is unsaved (dirty / draft). This is the browser analog of the
 * desktop's quit-time `UnsavedTabsDialog`; no background save, so there is no
 * in-flight save race.
 *
 * Mounted at the `App` root (NOT `MainApp`) so it survives the
 * WebAuthGate ↔ MainApp swap on token expiry / 401: dirty tabs can still live
 * in the store while the login screen is showing. No-op on Electron, whose own
 * quit flow already prompts.
 */
export function useWebUnloadGuard(): void {
  useEffect(() => {
    if (!getPlatform().remoteClient) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (!useEditorStore.getState().hasUnsavedTabs()) return;
      // preventDefault + returnValue together cover the spec'd and the
      // legacy paths browsers use to decide whether to show the prompt.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
}
