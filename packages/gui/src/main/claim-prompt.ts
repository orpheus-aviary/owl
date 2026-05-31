/**
 * P5-d Phase 16 (D10b) — GUI main side of the claim-empty-account prompt.
 *
 * Standalone module (NOT in sync-ipc.ts) so the login flow in `sync-auth.ts`
 * can import it without a sync-ipc ↔ sync-auth import cycle (sync-ipc already
 * imports sync-auth).
 *
 * Sends `sync:claim-prompt` to the renderer and resolves on the renderer's
 * `sync:claim-response`. Safe default `independent` (never touch local) when
 * there's no window or the renderer doesn't answer.
 */

import { BrowserWindow, ipcMain } from 'electron';
import type { ClaimChoice, ClaimPromptInput } from '../shared/sync-claim-types.js';

// Backstop only — the dialog always replies (button or Esc-as-independent).
// Guards a crashed/unresponsive renderer from wedging login forever.
const CLAIM_RESPONSE_TIMEOUT_MS = 5 * 60_000;

export function promptClaim(input: ClaimPromptInput): Promise<ClaimChoice> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return Promise.resolve('independent');

  return new Promise<ClaimChoice>((resolve) => {
    let settled = false;
    const finish = (choice: ClaimChoice): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener('sync:claim-response', onResponse);
      resolve(choice);
    };
    const onResponse = (_e: unknown, choice: ClaimChoice): void => {
      finish(choice === 'merge' ? 'merge' : 'independent');
    };
    const timer = setTimeout(() => finish('independent'), CLAIM_RESPONSE_TIMEOUT_MS);
    timer.unref?.();
    ipcMain.on('sync:claim-response', onResponse);
    win.webContents.send('sync:claim-prompt', input);
  });
}
