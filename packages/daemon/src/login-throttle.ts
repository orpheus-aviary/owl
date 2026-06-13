/**
 * Phase A (A4) — in-RAM sliding-window login throttle for POST /auth/login.
 *
 * Brute-force defence (arch §7.3). Counts FAILED attempts in a sliding window
 * and locks a key out once it exceeds the limit; a successful login clears the
 * email (+ ip) bucket so a legitimate user / multi-device login is never
 * penalised. State is RAM-only — a restart resets it.
 *
 * Keying (design §4.3 / §9 #5): account email + a coarse global bucket. The
 * global bucket caps an attacker spraying many distinct emails; its limit is
 * deliberately high so honest traffic almost never trips it (the tradeoff: a
 * determined sprayer can still cause a brief global lockout — a public deploy
 * should set `trust_proxy` so the per-IP bucket carries the real defence,
 * since behind a reverse proxy `req.ip` is otherwise always the loopback proxy
 * and per-IP keying is meaningless).
 */

export interface ThrottleKeys {
  /** Normalised (lower-cased) account email. */
  email: string;
  /** Client IP — only set when `[daemon].trust_proxy` makes it trustworthy. */
  ip?: string;
}

export interface ThrottleLimits {
  windowMs: number;
  maxPerEmail: number;
  maxGlobal: number;
  maxPerIp: number;
}

export const DEFAULT_THROTTLE_LIMITS: ThrottleLimits = {
  windowMs: 5 * 60_000, // 5-minute sliding window
  maxPerEmail: 5, // per-account failures before lockout
  maxGlobal: 100, // coarse cap across all emails (DoS-vs-defence tradeoff above)
  maxPerIp: 20, // per-IP failures (only consulted when an ip key is supplied)
};

const GLOBAL_KEY = 'global';

export class LoginThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limits: ThrottleLimits = DEFAULT_THROTTLE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns the retry-after delay in ms (>0 ⇒ throttled, caller should 429) or
   * 0 (allowed). Checks the email + global (+ ip when present) buckets and
   * reports the longest wait. Does NOT record — call this before attempting the
   * login, then record the outcome.
   */
  retryAfterMs(keys: ThrottleKeys): number {
    const t = this.now();
    let retry = 0;
    retry = Math.max(retry, this.retryFor(`email:${keys.email}`, this.limits.maxPerEmail, t));
    retry = Math.max(retry, this.retryFor(GLOBAL_KEY, this.limits.maxGlobal, t));
    if (keys.ip) retry = Math.max(retry, this.retryFor(`ip:${keys.ip}`, this.limits.maxPerIp, t));
    return retry;
  }

  /** Record one failed login attempt against every applicable bucket. */
  recordFailure(keys: ThrottleKeys): void {
    const t = this.now();
    this.push(`email:${keys.email}`, t);
    this.push(GLOBAL_KEY, t);
    if (keys.ip) this.push(`ip:${keys.ip}`, t);
  }

  /** Clear the per-email (+ per-ip) buckets after a successful login. */
  recordSuccess(keys: ThrottleKeys): void {
    this.hits.delete(`email:${keys.email}`);
    if (keys.ip) this.hits.delete(`ip:${keys.ip}`);
  }

  /** ms until the bucket frees a slot, or 0 if it's currently under the limit. */
  private retryFor(key: string, max: number, t: number): number {
    const arr = this.prune(key, t);
    if (arr.length < max) return 0;
    // The oldest hit leaves the window at `arr[0] + windowMs`.
    return arr[0] + this.limits.windowMs - t;
  }

  private push(key: string, t: number): void {
    const arr = this.prune(key, t);
    arr.push(t);
    this.hits.set(key, arr);
  }

  /** Drop hits older than the window; write the trimmed array back (bounded). */
  private prune(key: string, t: number): number[] {
    const cutoff = t - this.limits.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (arr.length > 0) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }
}
