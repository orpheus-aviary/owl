// Canonical owl config types — the single source of truth for `OwlConfig` and
// its sections, shared by @owl/core (runtime: TOML load/save + secret redaction)
// and every front-end (Electron renderer, web, mobile). Kept Node-free so the
// web/RN bundle can consume them (the core config module can't cross the
// shared-no-node-electron guard because it imports node:fs / smol-toml).
//
// snake_case fields mirror the daemon's `/config` HTTP payload verbatim.

export type LlmApiFormat = 'openai' | 'anthropic';

export interface LlmConfig {
  url: string;
  model: string;
  api_key: string;
  /** API wire format — determines auth header and request shape. */
  api_format: LlmApiFormat;
  /**
   * Whether to round-trip the model's reasoning / thinking content back in
   * subsequent requests. Required by DeepSeek V4 Pro/Flash and Anthropic
   * Extended Thinking; forbidden by DeepSeek V3 reasoner / R1; ignored by
   * OpenAI o-series chat completions (reasoning is hidden server-side).
   * Default `true` matches the V4 / Anthropic trend; flip to false for
   * DeepSeek V3 reasoner if you hit the legacy 400 error.
   */
  thinking_round_trip: boolean;
}

export interface WindowConfig {
  width: number;
  height: number;
}

export interface FontConfig {
  /** Offset (in px) applied to the root html element's base font size (16px). */
  global_offset: number;
  /** CodeMirror editor font size in px. */
  editor_font_size: number;
  /** CodeMirror editor line height (unitless multiplier). */
  editor_line_height: number;
}

export interface NavigationConfig {
  order: string[];
}

export interface DaemonConfig {
  poll_interval_min: number;
  port: number;
  /**
   * Phase A — deployment mode (drives endpoint auth). `local` = loopback only,
   * local token gate (A6); `cloud` = per-endpoint bearer auth + CORS allowlist
   * + Host check. Default `local`.
   */
  mode: 'local' | 'cloud';
  /** Phase A — listen host. Default `127.0.0.1`. Non-loopback requires `mode='cloud'`. */
  bind: string;
  // ── cloud-only deployment fields (ignored when mode='local') ──
  /** The fixed skybridge server URL — login can't pick an arbitrary URL (anti-SSRF). */
  server_url?: string;
  /**
   * Owner profileId (`computeProfileId(serverId, userId)`) or the literal
   * `'off'` (switchable single-tenant). Absent → daemon refuses to start
   * (fail-closed; see Phase A design §3.3 ①).
   */
  account_lock?: string;
  /** The daemon's own public origin (e.g. `https://owl.example.com`); drives Host allowlist + same-origin CORS. */
  public_url?: string;
  /** Extra CORS origins beyond the public_url-derived same-origin. */
  allowed_origins?: string[];
  /** Extra allowed Host header values (`host[:port]` / IP) beyond public_url + loopback. */
  allowed_hosts?: string[];
  /** Layer-2 browser session TTL in minutes (sliding). Default 720 (12h). */
  session_ttl_min?: number;
  /** Trust `X-Forwarded-For` (Fastify trustProxy) so login rate-limit can key per client IP behind a reverse proxy. Default false. */
  trust_proxy?: boolean;
  /**
   * Phase B4 — filesystem path to a built web bundle (`apps/web/dist`) to serve
   * same-origin via `@fastify/static`. Absolute path used as-is; a relative path
   * resolves against `paths.nestDir()`. Unset → no web hosting (desktop default,
   * unchanged). Owner-only in the cloud `/config` projection (it's a server FS
   * path — stripped for non-owner sessions by `redactConfig`).
   */
  web_root?: string;
}

/**
 * P5-c §3.5 — background sync trigger (skybridge). Independent from
 * `[daemon].poll_interval_min` (which drives the reminder scheduler).
 *
 *   `interval_min`  default 5
 *                  `<= 0`  → disabled (daemon does NOT start a timer)
 *                  `< 1`   → clamped up to 1 (avoid 100ms hammering the server)
 *                  invalid (NaN / non-number) → silently falls back to default 5
 *
 * Read via `effectiveSyncIntervalMin(config.sync)` (in @owl/core) rather than
 * the raw field — the rules live in one place that way.
 */
export interface SyncConfig {
  interval_min: number;
}

export interface AiConfig {
  context_rounds: number;
  max_recent_notes: number;
  /**
   * Cumulative character budget for the Layer-1 "recent fill" injected
   * into the system prompt. Once recent notes' content exceeds this, the
   * remaining notes are dropped (the LLM can call `search_notes` to fetch
   * more on demand).
   */
  max_context_chars: number;
}

export interface TrashConfig {
  auto_delete_days: number;
}

export interface LogConfig {
  max_size_mb: number;
  max_backups: number;
  max_age_days: number;
  level: 'debug' | 'info' | 'warn' | 'error';
}

export interface EditorConfig {
  /** Default mode for newly opened editor tabs. */
  default_mode: 'edit' | 'split' | 'preview';
}

export interface BrowserConfig {
  default_sort_field: 'updated' | 'created';
  default_sort_direction: 'asc' | 'desc';
}

export interface ShortcutsConfig {
  save: string;
  close_tab: string;
  toggle_wrap: string;
  toggle_edit_mode: string;
  new_note: string;
  nav_editor: string;
  nav_browser: string;
  nav_trash: string;
  nav_reminders: string;
  nav_todo: string;
  nav_ai: string;
  nav_settings: string;
  toggle_folder_panel: string;
  /**
   * OS-level shortcut handled by Electron `globalShortcut` in the main
   * process. Brings the window forward + focuses it even when owl is
   * hidden / unfocused. Empty string disables registration. Canonical
   * form (`Mod-Alt-KeyO`) is converted to Electron accelerator at
   * registration time via `@owl/core/shortcuts/accelerator`.
   */
  global_invoke: string;
}

/**
 * Contract (Phase A): on a local daemon `GET/PATCH /config` returns the full
 * `OwlConfig` including `llm.api_key`. On a cloud daemon, GET returns the full
 * config to the owner session but a `PublicOwlConfig` projection (secret
 * stripped, `has_api_key` flagged) to a non-owner; PATCH of `llm.*` is
 * owner-only. Web consumers should type the GET response as
 * `OwlConfig | PublicOwlConfig` and never assume `llm.api_key` is present.
 * See the ecosystem arch §9 + Phase A design §6.
 */
export interface OwlConfig {
  llm: LlmConfig;
  window: WindowConfig;
  font: FontConfig;
  navigation: NavigationConfig;
  daemon: DaemonConfig;
  sync: SyncConfig;
  ai: AiConfig;
  trash: TrashConfig;
  log: LogConfig;
  editor: EditorConfig;
  browser: BrowserConfig;
  shortcuts: ShortcutsConfig;
}

/** `LlmConfig` with the secret stripped: cloud non-owner projection. */
export interface PublicLlmConfig {
  url: string;
  model: string;
  api_format: LlmApiFormat;
  thinking_round_trip: boolean;
  /** Whether a non-empty api_key is configured (the key itself is never sent). */
  has_api_key: boolean;
}

/** `DaemonConfig` minus the owner-only server FS path. */
export type PublicDaemonConfig = Omit<DaemonConfig, 'web_root'>;

/**
 * Non-owner projection of `OwlConfig`: `llm` carries no `api_key` (just a
 * `has_api_key` flag), and `daemon` drops `web_root` (a server filesystem path,
 * not metadata a borrowing account should see). Everything else (incl. the
 * other `daemon` cloud fields) is operator metadata, not a credential.
 */
export type PublicOwlConfig = Omit<OwlConfig, 'llm' | 'daemon'> & {
  llm: PublicLlmConfig;
  daemon: PublicDaemonConfig;
};
