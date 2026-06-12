// Host resolution. `getPlatform()` is the only entry the renderer uses; it
// picks the Electron or web adapter by honestly probing for the preload.
//
// `'owlAPI' in window` is a runtime presence check that stays correct when the
// same bundle is loaded in a plain browser (no preload → web adapter). The
// `typeof window` guard keeps tooling / non-DOM imports from throwing.

import { createElectronAdapter } from './electron';
import type { PlatformAdapter } from './types';
import { webAdapter } from './web';

export type { PlatformAdapter, SyncCapability } from './types';

let cached: PlatformAdapter | undefined;

export function getPlatform(): PlatformAdapter {
  if (cached) return cached;
  cached =
    typeof window !== 'undefined' && 'owlAPI' in window ? createElectronAdapter() : webAdapter;
  return cached;
}
