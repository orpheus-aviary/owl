import type { LlmConfig, Logger, OwlConfig, OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { ConversationStore } from './ai/conversations.js';
import type { LlmClient } from './ai/llm-client.js';
import type { PreviewStore } from './ai/preview-store.js';
import type { ToolRegistry } from './ai/tool-registry.js';
import type { EventsBus } from './events/bus.js';
import type { ReminderScheduler } from './scheduler.js';
import type { BridgeHandle } from './sync/bridge-lifecycle.js';
import type { SyncSchedulerHandle } from './sync/scheduler.js';
import type { SkybridgeSession } from './sync/session.js';

/** Shared application context passed to all route handlers. */
export interface AppContext {
  db: OwlDatabase;
  sqlite: Database.Database;
  config: OwlConfig;
  /** Optional override for where to persist config writes (used by tests). */
  configPath?: string;
  logger: Logger;
  deviceId: string;
  scheduler: ReminderScheduler;
  /** Built-in AI tool registry, injected at startup. */
  toolRegistry: ToolRegistry;
  /** In-memory chat conversation store; cleared on daemon restart. */
  conversationStore: ConversationStore;
  /** In-memory preview stash for external-agent Tier-2 writes. */
  previewStore: PreviewStore;
  /** Reverse-channel event bus (daemon → GUI); see routes/events.ts. */
  eventsBus: EventsBus;
  /**
   * Override the per-request LLM client factory. Production uses the
   * default `createLlmClient`; tests inject mocks here to drive the agent
   * loop with canned chunk streams.
   */
  llmClientFactory?: (config: LlmConfig) => LlmClient;
  /**
   * P5-b §6.1: cached skybridge session — populated by
   * `ensureSkybridgeSession(ctx)` on first sync, dropped to `null` by
   * `invalidateSkybridgeSession(ctx)` on 401. Scoped to AppContext (not
   * module-level) so the dual-profile e2e suite stays isolated.
   */
  skybridgeSession: SkybridgeSession | null;
  /**
   * P5-c §2.2-bis: live SSE bridge handle. Populated by
   * `ensureBackgroundHandles(ctx, logger)` once toml is fully bootstrapped;
   * stays null when daemon booted with an incomplete toml and the user
   * hasn't run `owl sync login` + `owl sync run` yet. cli.ts shutdown
   * reads this lazily so the bridge stops if it started, but a clean
   * shutdown still works when the bridge never started.
   */
  sseBridge?: BridgeHandle | null;
  /**
   * P5-c §2.2: background sync timer handle. Always created at daemon
   * boot — the scheduler itself decides to no-op when interval_min <= 0.
   * Stored on ctx so mid-session restart (P5-c §2.2-bis) can read+stop
   * before re-creating.
   */
  syncScheduler?: SyncSchedulerHandle | null;
}
