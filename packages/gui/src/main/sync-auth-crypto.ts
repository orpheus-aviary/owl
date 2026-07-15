// Leaf helpers for the sync-auth family: the public error types + the
// safeStorage / config primitives. Split out of sync-auth.ts so every sibling
// (orchestrator / transport / renewal) can share them without an import cycle.
// Depends only on electron safeStorage, node:os, and @owl/core config reads.

import { hostname } from 'node:os';
import { type SkybridgeConfig, readSkybridgeConfig } from '@owl/core';
import { safeStorage } from 'electron';

export interface SyncSessionSummary {
  server_url: string;
  user_id: string;
  email: string;
  device_id: string;
  workspace_id: string;
}

export class SafeStorageUnavailableError extends Error {
  readonly code = 'SAFE_STORAGE_UNAVAILABLE';
  constructor() {
    super('electron safeStorage is unavailable on this system; cannot encrypt skybridge token');
    this.name = 'SafeStorageUnavailableError';
  }
}

/** The server didn't return a `server_id` → it's older than 0.1.4 (R5). */
export class SkybridgeServerTooOldError extends Error {
  readonly code = 'SKYBRIDGE_SERVER_TOO_OLD';
  constructor() {
    super('this server is too old — owl needs a skybridge 0.1.4+ server (no server_id returned)');
    this.name = 'SkybridgeServerTooOldError';
  }
}

/**
 * P5-d Phase 17 (W4) — a saved profile can't be quick-switched without a
 * password (no usable refresh token / incomplete stored section). The renderer
 * maps this to "请在设置中重新登录".
 */
export class QuickSwitchNeedsLoginError extends Error {
  readonly code = 'QUICK_SWITCH_NEEDS_LOGIN';
  constructor() {
    super('this account needs a password re-login (no usable refresh token)');
    this.name = 'QuickSwitchNeedsLoginError';
  }
}

/** Decrypt a base64 safeStorage ciphertext, or null on any failure. */
export function decryptB64(ciphertext?: string): string | null {
  if (!ciphertext || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
  } catch {
    return null;
  }
}

export function defaultDeviceName(): string {
  const host = hostname();
  return host ? `${host} (owl)` : 'owl device';
}

export function safeReadConfig(): SkybridgeConfig | null {
  try {
    return readSkybridgeConfig();
  } catch {
    return null;
  }
}
