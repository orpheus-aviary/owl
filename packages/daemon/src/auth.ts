/**
 * Phase A (slice A2) — Layer-2 client session store + endpoint-auth helpers.
 *
 * `SessionStore` is the in-RAM Layer-2 (browser↔daemon) session registry: a
 * cloud daemon mints an opaque bearer token per logged-in client, and every
 * cloud request must carry it (the auth preHandler in server.ts). Tokens are
 * never persisted (§7.7 — restart ⇒ re-login). TTL is sliding: each successful
 * `verify` pushes expiry out, so an actively-used session stays alive and only
 * idle ones lapse. A teardown registry lets a revoke / expiry actively close
 * resources tied to the session (e.g. an open `/events` SSE stream, §5.3).
 *
 * Minting happens in A4 (`POST /auth/login`); A2 builds the store + the gate.
 * local mode never mints — the auth preHandler no-ops there (A6-前零变更).
 *
 * Design: `docs/plans/2026-06-12-phase-a-cloud-daemon-design.md` §4.2 / §5.3.
 */

import { randomBytes } from 'node:crypto';
import type { AppContext } from './context.js';

export interface Session {
  readonly token: string;
  readonly profileId: string;
  readonly createdAt: number;
  /** Mutable — slid forward on each `verify` (idle TTL). */
  expiresAt: number;
}

const DEFAULT_TTL_MIN = 720; // 12h
const SWEEP_INTERVAL_MS = 60_000;

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  /** token → teardown callbacks run on revoke/expiry (e.g. close an SSE stream). */
  private readonly teardowns = new Map<string, Set<() => void>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param ttlMs  sliding session lifetime
   * @param now    injectable clock (tests); defaults to `Date.now`
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mint a fresh session for `profileId`. Token is a 256-bit url-safe random. */
  mint(profileId: string): Session {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    const session: Session = { token, profileId, createdAt: t, expiresAt: t + this.ttlMs };
    this.sessions.set(token, session);
    return session;
  }

  /** Return the live session and slide its expiry, or null if missing/expired. */
  verify(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.revoke(token);
      return null;
    }
    session.expiresAt = this.now() + this.ttlMs; // sliding renewal
    return session;
  }

  /**
   * Register a callback to run when this session is revoked or expires. Returns
   * an unregister fn (call it when the resource closes on its own, so a later
   * revoke doesn't double-fire).
   */
  onTeardown(token: string, cb: () => void): () => void {
    let set = this.teardowns.get(token);
    if (!set) {
      set = new Set();
      this.teardowns.set(token, set);
    }
    set.add(cb);
    return () => {
      this.teardowns.get(token)?.delete(cb);
    };
  }

  /** Drop one session and run its teardown callbacks. */
  revoke(token: string): void {
    this.sessions.delete(token);
    const set = this.teardowns.get(token);
    if (!set) return;
    this.teardowns.delete(token);
    for (const cb of [...set]) runSafely(cb); // copy: a cb may unregister mid-iteration
  }

  /** Drop every session (e.g. "log out all" / full Layer-1 teardown). */
  revokeAll(): void {
    for (const token of [...this.sessions.keys()]) this.revoke(token);
  }

  /** Session count including any expired-but-not-yet-swept entries. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Count of currently non-expired sessions (without sliding their TTL). The
   * `account_lock='off'` release rule (§5.3) keys off this: a different account
   * may only preempt the current binding once it has zero live clients.
   */
  liveCount(): number {
    const t = this.now();
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.expiresAt > t) n++;
    }
    return n;
  }

  /** Start the periodic expiry sweep (idempotent). Unref'd so it never blocks exit. */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Revoke every expired session now. */
  sweep(): void {
    const t = this.now();
    for (const [token, session] of [...this.sessions]) {
      if (session.expiresAt <= t) this.revoke(token);
    }
  }
}

function runSafely(cb: () => void): void {
  try {
    cb();
  } catch {
    // best-effort teardown — one failing callback must not block the rest
  }
}

/** Extract the bearer token from an `Authorization` header, or null. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const prefix = 'bearer ';
  if (authorization.toLowerCase().startsWith(prefix)) {
    return authorization.slice(prefix.length).trim() || null;
  }
  return null;
}

/**
 * Routes reachable without a Layer-2 session (cloud mode). Kept minimal:
 * `GET /status` (health) and `POST /auth/login` (the pre-session door, A4).
 * Static web assets join this in Phase B.
 */
export function isPublicPath(method: string, url: string): boolean {
  const path = url.split('?')[0];
  if (method === 'GET' && path === '/status') return true;
  if (method === 'POST' && path === '/auth/login') return true;
  return false;
}

/**
 * Whether the request's session may see secrets (`llm.api_key`) and patch
 * `llm.*` (A5 owner-gate). Three cases:
 *   - local mode → always (no Layer-2 concept; desktop is single-user).
 *   - cloud locked (`account_lock=<profileId>`) → the session's profileId must
 *     equal the lock. In practice only the owner can ever bind (login rejects
 *     others), so a valid session is normally already the owner — this is
 *     defence-in-depth at the config surface.
 *   - cloud `off` → never. There's no fixed owner, and off-mode forbids a
 *     server-side AI key at startup, so the projection only elides an (empty)
 *     key. Refusing `llm.*` patches also stops a tenant persisting a key that
 *     would fail the next startup guard.
 */
export function isConfigOwner(ctx: AppContext, session: Session | undefined): boolean {
  if (ctx.config.daemon.mode === 'local') return true;
  const lock = ctx.config.daemon.account_lock;
  if (!lock || lock === 'off') return false;
  return session?.profileId === lock;
}

/** Lazily create + cache the session store on ctx. Sweeps only in cloud mode. */
export function ensureSessionStore(ctx: AppContext): SessionStore {
  if (ctx.sessionStore) return ctx.sessionStore;
  const ttlMin = ctx.config.daemon.session_ttl_min ?? DEFAULT_TTL_MIN;
  const store = new SessionStore(ttlMin * 60_000);
  ctx.sessionStore = store;
  if (ctx.config.daemon.mode === 'cloud') store.startSweep();
  return store;
}
