import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LlmConfig, OwlConfig, PublicOwlConfig, SyncConfig } from '@orpheus-aviary/owl-shared';
import { parse, stringify } from 'smol-toml';
import { aviaryConfigPath, configPath } from './paths.js';

// ─── Config Types ──────────────────────────────────────
//
// Canonical config types live in @orpheus-aviary/owl-shared (Node-free, so the
// web / renderer / mobile front-ends can consume them too). Core owns only the
// runtime below (defaults, TOML load/save, LLM fallback, secret redaction) and
// re-exports the full type surface so `@owl/core` consumers import unchanged.
export type {
  LlmApiFormat,
  LlmConfig,
  WindowConfig,
  FontConfig,
  NavigationConfig,
  DaemonConfig,
  SyncConfig,
  AiConfig,
  TrashConfig,
  LogConfig,
  EditorConfig,
  BrowserConfig,
  ShortcutsConfig,
  OwlConfig,
  PublicLlmConfig,
  PublicDaemonConfig,
  PublicOwlConfig,
} from '@orpheus-aviary/owl-shared';

// ─── Defaults ──────────────────────────────────────────

export const DEFAULT_CONFIG: OwlConfig = {
  llm: { url: '', model: '', api_key: '', api_format: 'openai', thinking_round_trip: true },
  window: { width: 1000, height: 700 },
  font: { global_offset: 0, editor_font_size: 14, editor_line_height: 1.6 },
  navigation: { order: ['editor', 'browser', 'trash', 'reminders', 'ai', 'todo', 'settings'] },
  daemon: { poll_interval_min: 1, port: 47010, mode: 'local', bind: '127.0.0.1' },
  sync: { interval_min: 5 },
  ai: { context_rounds: 3, max_recent_notes: 5, max_context_chars: 30000 },
  trash: { auto_delete_days: 30 },
  log: { max_size_mb: 10, max_backups: 5, max_age_days: 30, level: 'info' },
  editor: { default_mode: 'edit' },
  browser: { default_sort_field: 'updated', default_sort_direction: 'desc' },
  shortcuts: {
    save: 'Mod-KeyS',
    close_tab: 'Mod-KeyW',
    toggle_wrap: 'Alt-KeyZ',
    toggle_edit_mode: 'Mod-Alt-KeyV',
    new_note: 'Mod-KeyN',
    nav_editor: 'Mod-Digit1',
    nav_browser: 'Mod-Digit2',
    nav_trash: 'Mod-Digit3',
    nav_reminders: 'Mod-Digit4',
    nav_todo: 'Mod-Digit5',
    nav_ai: 'Mod-Digit6',
    nav_settings: 'Mod-Digit7',
    toggle_folder_panel: 'Mod-KeyB',
    global_invoke: 'Mod-Alt-KeyO',
  },
};

// ─── Read / Write ──────────────────────────────────────

/** Load config from disk, creating default file if missing. */
export function loadConfig(path?: string): OwlConfig {
  const filePath = path ?? configPath();

  if (!existsSync(filePath)) {
    saveConfig(DEFAULT_CONFIG, filePath);
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw) as Partial<OwlConfig>;

  // Deep merge with defaults to fill missing fields
  return deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    parsed as unknown as Record<string, unknown>,
  ) as unknown as OwlConfig;
}

/** Save config to disk. */
export function saveConfig(config: OwlConfig, path?: string): void {
  const filePath = path ?? configPath();
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, stringify(config as unknown as Record<string, unknown>), 'utf-8');
}

/**
 * Resolve LLM config: use owl config if set, fallback to aviary shared config.
 */
export function resolveLlmConfig(config: OwlConfig): LlmConfig {
  if (config.llm.url && config.llm.model && config.llm.api_key) {
    return config.llm;
  }

  const aviaryPath = aviaryConfigPath();
  if (!existsSync(aviaryPath)) {
    return config.llm;
  }

  try {
    const raw = readFileSync(aviaryPath, 'utf-8');
    const parsed = parse(raw) as { llm?: Partial<LlmConfig> };
    if (parsed.llm) {
      return {
        url: config.llm.url || parsed.llm.url || '',
        model: config.llm.model || parsed.llm.model || '',
        api_key: config.llm.api_key || parsed.llm.api_key || '',
        api_format: config.llm.api_format || parsed.llm.api_format || 'openai',
        // Owl-side toggle wins; aviary fallback only kicks in when owl is
        // entirely unset. Either side could legitimately be `false`, so
        // ?? (undefined fallback) is right — || would coerce false to true.
        thinking_round_trip:
          config.llm.thinking_round_trip ?? parsed.llm.thinking_round_trip ?? true,
      };
    }
  } catch {
    // Fallback to owl config if aviary config is invalid
  }

  return config.llm;
}

// ─── Secret redaction (Phase A — cloud GET /config projection) ──────────
//
// The `PublicLlmConfig` / `PublicDaemonConfig` / `PublicOwlConfig` projection
// types are defined in @orpheus-aviary/owl-shared (re-exported at the top of
// this file); `redactConfig` below is the runtime that produces them.

/**
 * Project `config` for a viewer. The owner (and any local-mode caller) sees the
 * full config including `llm.api_key`; a non-owner cloud session gets the
 * `PublicOwlConfig` projection with the secret stripped and `has_api_key`
 * flagged. No `'***'` sentinel — the field is simply absent, so there's no
 * round-trip risk of a PATCH writing the placeholder back over a real key.
 *
 * Nested sections are shared by reference (the result is read-only / serialized
 * immediately); only the top level and `llm` are fresh objects.
 */
export function redactConfig(
  config: OwlConfig,
  opts: { owner: boolean },
): OwlConfig | PublicOwlConfig {
  if (opts.owner) return config;
  const { api_key, ...llmRest } = config.llm;
  // web_root is owner-only (a server FS path) — drop it via rest-omit.
  const { web_root: _web_root, ...daemonRest } = config.daemon;
  return {
    ...config,
    llm: { ...llmRest, has_api_key: api_key.length > 0 },
    daemon: daemonRest,
  };
}

// ─── Helpers ───────────────────────────────────────────

/**
 * Resolve the effective sync interval per P5-c §3.5 rules:
 *   - <= 0       → 0 (disabled; daemon scheduler skips setInterval)
 *   - 0 < x < 1  → 1 (clamp up to one minute)
 *   - NaN / non-number → 5 (silent fallback to default; no log from core)
 *   - otherwise → raw value in minutes
 *
 * Returned units are minutes; daemon multiplies by 60_000 for setInterval.
 */
export function effectiveSyncIntervalMin(syncConfig: SyncConfig): number {
  const raw = syncConfig.interval_min;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5;
  if (raw <= 0) return 0;
  if (raw < 1) return 1;
  return raw;
}

function deepMerge(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };

  for (const key of Object.keys(overrides)) {
    const defaultVal = defaults[key];
    const overrideVal = overrides[key];

    if (
      defaultVal &&
      overrideVal &&
      typeof defaultVal === 'object' &&
      typeof overrideVal === 'object' &&
      !Array.isArray(defaultVal) &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        defaultVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }

  return result;
}
