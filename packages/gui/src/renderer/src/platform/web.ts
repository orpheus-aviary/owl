// Web host adapter — used when there is no preload (`window.owlAPI` absent).
//
// Step 0 has no web pages yet (those land in Phase B); this stub exists so the
// renderer type-graph and runtime are honestly web-safe today:
//   - startupMode is always `normal` (no local DB migration in a browser)
//   - Electron-local capabilities (migration/cli/shortcut/quit + profile mgmt
//     + IPC-push subscriptions) are absent → `undefined`, components guard
//   - session/status ops are present but return a typed failure (never throw),
//     so reachable UI degrades cleanly. Phase A swaps these for real HTTP
//     calls without changing the signatures.

import type { PlatformAdapter } from './types';

const WEB_UNAVAILABLE_MESSAGE = '网页版暂不可用（请用桌面端）';

/** Typed failure shared by every web session op until Phase A wires HTTP. */
const unavailable = (): Promise<{ ok: false; message: string }> =>
  Promise.resolve({ ok: false, message: WEB_UNAVAILABLE_MESSAGE });

export const webAdapter: PlatformAdapter = {
  startupMode: { mode: 'normal' },
  daemonBaseUrl: () => '',
  sync: {
    login: unavailable,
    logout: unavailable,
    status: unavailable,
    run: unavailable,
    devices: unavailable,
    revokeDevice: unavailable,
    // profiles / switchProfile / deleteProfile / onProfileSwitched /
    // onClaimPrompt / respondClaim — Electron-local, intentionally absent.
  },
  // migration / cli / shortcut / quit — Electron-only, intentionally absent.
};
