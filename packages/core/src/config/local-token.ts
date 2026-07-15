import { readFileSync } from 'node:fs';
import { localTokenPath } from './paths.js';

/**
 * Read the daemon's local-mode auth token (Phase A A6), or null if absent.
 *
 * The daemon publishes it (0600) once it is listening in local mode; CLI and
 * GUI main read it to attach `Authorization: Bearer <token>` to their daemon
 * requests. Returns null when the file is missing / empty (daemon down, or a
 * cloud daemon which never writes it) — callers then send no bearer and let the
 * daemon respond (401 in local mode, or a real session gate in cloud).
 */
export function readLocalToken(): string | null {
  try {
    const token = readFileSync(localTokenPath(), 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch {
    // Missing file (ENOENT) or unreadable — treat as "no token available".
    return null;
  }
}
