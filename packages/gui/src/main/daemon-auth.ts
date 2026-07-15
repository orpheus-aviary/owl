import { paths, readLocalToken } from '@owl/core';

/**
 * Headers GUI main attaches to its direct daemon HTTP calls (Phase A A6) —
 * the sync-ipc handlers (run/status/devices/revoke) and the sync-auth session
 * plumbing (session/switch). Reads the daemon's 0600 local-token file fresh per
 * call → `Authorization: Bearer`; empty when absent (daemon not up yet). The
 * renderer receives the token separately via preload — it has no fs access.
 */
export function daemonAuthHeaders(): Record<string, string> {
  const token = readLocalToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Absolute path to the daemon's local-token file, for preload to read. */
export function getLocalTokenPath(): string {
  return paths.localTokenPath();
}
