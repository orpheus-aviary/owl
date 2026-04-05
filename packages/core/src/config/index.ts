import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { aviaryConfigPath, configPath } from './paths.js';

// ─── Config Types ──────────────────────────────────────

export interface LlmConfig {
  url: string;
  model: string;
  api_key: string;
}

export interface WindowConfig {
  width: number;
  height: number;
}

export interface FontConfig {
  global_offset: number;
}

export interface NavigationConfig {
  order: string[];
}

export interface DaemonConfig {
  poll_interval_min: number;
  port: number;
}

export interface AiConfig {
  context_rounds: number;
  max_fts_notes: number;
  max_recent_notes: number;
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

export interface ShortcutsConfig {
  save: string;
  close_tab: string;
  toggle_wrap: string;
  toggle_edit_mode: string;
}

export interface OwlConfig {
  llm: LlmConfig;
  window: WindowConfig;
  font: FontConfig;
  navigation: NavigationConfig;
  daemon: DaemonConfig;
  ai: AiConfig;
  trash: TrashConfig;
  log: LogConfig;
  shortcuts: ShortcutsConfig;
}

// ─── Defaults ──────────────────────────────────────────

export const DEFAULT_CONFIG: OwlConfig = {
  llm: { url: '', model: '', api_key: '' },
  window: { width: 1000, height: 700 },
  font: { global_offset: 0 },
  navigation: { order: ['editor', 'browser', 'trash', 'reminders', 'ai', 'todo', 'settings'] },
  daemon: { poll_interval_min: 1, port: 47010 },
  ai: { context_rounds: 3, max_fts_notes: 10, max_recent_notes: 5 },
  trash: { auto_delete_days: 30 },
  log: { max_size_mb: 10, max_backups: 5, max_age_days: 30, level: 'info' },
  shortcuts: {
    save: 'Mod-s',
    close_tab: 'Mod-w',
    toggle_wrap: 'Alt-z',
    toggle_edit_mode: 'Mod-Alt-v',
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
      };
    }
  } catch {
    // Fallback to owl config if aviary config is invalid
  }

  return config.llm;
}

// ─── Helpers ───────────────────────────────────────────

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
