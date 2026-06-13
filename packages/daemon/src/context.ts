import type { LlmConfig, Logger, OwlConfig, OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { ConversationStore } from './ai/conversations.js';
import type { LlmClient } from './ai/llm-client.js';
import type { PreviewStore } from './ai/preview-store.js';
import type { ToolRegistry } from './ai/tool-registry.js';
import type { SessionStore } from './auth.js';
import type { CredentialStore } from './credential-store.js';
import type { EventsBus } from './events/bus.js';
import type { ReminderScheduler } from './scheduler.js';
import type { BridgeHandle } from './sync/bridge-lifecycle.js';
import type { SyncSchedulerHandle } from './sync/scheduler.js';
import type { SkybridgeClientModule } from './sync/session.js';
import type { SkybridgeSession } from './sync/session.js';
import type { SwitchGate } from './sync/switch-gate.js';

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
  /**
   * P5-d Phase 14: serialises profile switches + quiesces the daemon during
   * the db-replace window. Populated at daemon boot (cli.ts) and lazily by
   * `buildServer`. Optional so the inline test contexts that don't switch
   * profiles compile unchanged.
   */
  switchGate?: SwitchGate;
  /**
   * Phase A (A2) — Layer-2 browser-session registry (in-RAM, cloud only).
   * Lazily created by `ensureSessionStore` in buildServer. Optional so inline
   * test contexts compile unchanged. Never consulted in local mode (the auth
   * preHandler no-ops there).
   */
  sessionStore?: SessionStore;
  /**
   * Phase A (A3) — Layer-1 cloud credentials (in-RAM, never disk). Holds the
   * skybridge token/refresh + resolved identity after the cloud self-login
   * chain binds an account. Null/absent on local daemons and a fresh cloud
   * daemon (owner re-logs-in after restart, §7.7).
   */
  credentialStore?: CredentialStore;
  /**
   * Phase A (A3) — proactive token-refresh timer handle (cloud only). Set by
   * the cloud login chain, cleared on logout / shutdown. Re-arms itself for
   * long delays (>2^31ms) to avoid the 32-bit setTimeout overflow.
   */
  refreshTimer?: ReturnType<typeof setTimeout> | null;
  /**
   * Phase A (A4) — test override for the skybridge SDK loader used by the cloud
   * login chain (`POST /auth/login`). Production leaves this undefined so
   * `cloudLogin` falls back to the real dynamic import; tests inject a mock
   * module (mirrors `llmClientFactory`).
   */
  skybridgeLoader?: () => Promise<SkybridgeClientModule>;
}
