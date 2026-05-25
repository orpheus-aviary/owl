import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { aviaryConfigPath, configPath } from './paths.js';

// ─── Config Types ──────────────────────────────────────

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
}

/**
 * P5-c §3.5 — background sync trigger (skybridge). Independent from
 * `[daemon].poll_interval_min` (which drives the reminder scheduler).
 *
 *   `interval_min`  default 5
 *                  `<= 0`  → disabled (daemon does NOT start a timer)
 *                  `< 1`   → clamped up to 1 (avoid 100ms hammering the server)
 *                  invalid (NaN / non-number) → silently falls back to default 5
 *                  (loadConfig is a pure read; no logger here. daemon
 *                  scheduler info-logs the effective value at startup.)
 *
 * Read via `effectiveSyncIntervalMin(config.sync)` rather than the raw
 * field — the rules live in one place that way.
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

// ─── Defaults ──────────────────────────────────────────

export const DEFAULT_CONFIG: OwlConfig = {
  llm: { url: '', model: '', api_key: '', api_format: 'openai', thinking_round_trip: true },
  window: { width: 1000, height: 700 },
  font: { global_offset: 0, editor_font_size: 14, editor_line_height: 1.6 },
  navigation: { order: ['editor', 'browser', 'trash', 'reminders', 'ai', 'todo', 'settings'] },
  daemon: { poll_interval_min: 1, port: 47010 },
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
