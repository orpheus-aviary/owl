/**
 * Phase A (slice A3) — in-RAM cloud credential store (Layer-1).
 *
 * A cloud daemon has no Electron main + no OS keychain, so it must hold the
 * skybridge token itself. To keep the P5-d "daemon never writes toml/credential"
 * invariant intact (`check-daemon-no-toml-write.sh` + the A3 `cloud-creds-no-disk`
 * guard), credentials live ONLY here, in RAM — never on disk. Cost: a restart
 * drops them and the owner re-logs-in (§7.7). A future encrypted-file impl can
 * satisfy the same shape as a pure increment without breaking the guard.
 *
 * Holds the resolved identity (profileId / device / workspace) alongside the
 * rotating token set; the refresh timer calls `rotate` to swap in a fresh
 * access token (+ rotated refresh) without disturbing the identity.
 *
 * MUST NOT import `node:fs` or write to disk — see `scripts/check-cloud-creds-no-disk.sh`.
 */

export interface CloudCredentials {
  readonly serverUrl: string;
  readonly serverId: string;
  readonly userId: string;
  readonly email: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  token: string;
  refreshToken?: string;
  /** Access-token expiry (Unix ms), if the server reported one. */
  expiresAt?: number;
}

export class CredentialStore {
  private creds: CloudCredentials | null = null;

  set(creds: CloudCredentials): void {
    this.creds = creds;
  }

  get(): CloudCredentials | null {
    return this.creds;
  }

  /** True once a Layer-1 binding exists (owner logged in). */
  get bound(): boolean {
    return this.creds !== null;
  }

  /**
   * Swap in a fresh access token (+ rotated refresh / new expiry) after a
   * refresh round. Keeps the identity (profileId/device/workspace) intact. The
   * refresh token is only replaced when the server returns a new one.
   */
  rotate(next: { token: string; refreshToken?: string; expiresAt?: number }): void {
    if (!this.creds) {
      throw new Error('CredentialStore.rotate called with no credentials set');
    }
    this.creds.token = next.token;
    if (next.refreshToken !== undefined) this.creds.refreshToken = next.refreshToken;
    this.creds.expiresAt = next.expiresAt;
  }

  clear(): void {
    this.creds = null;
  }
}
