import { readLocalToken } from '@owl/core';

/**
 * Headers every CLI → daemon HTTP request must carry (Phase A A6).
 *
 * Reads the local token the daemon published (0600 file) and returns it as an
 * `Authorization: Bearer` header — the single seam so no CLI daemon call is left
 * unauthenticated. Empty when the token is absent (daemon down, or a cloud
 * daemon which never writes it); the daemon then answers 401 in local mode.
 * Read fresh per call so a daemon restart (token rotation) is picked up on the
 * next command.
 */
export function daemonAuthHeaders(): Record<string, string> {
  const token = readLocalToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}
