import type { LlmConfig, Logger, OwlConfig, OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { ConversationStore } from './ai/conversations.js';
import type { LlmClient } from './ai/llm-client.js';
import type { ToolRegistry } from './ai/tool-registry.js';
import type { ReminderScheduler } from './scheduler.js';

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
  /**
   * Override the per-request LLM client factory. Production uses the
   * default `createLlmClient`; tests inject mocks here to drive the agent
   * loop with canned chunk streams.
   */
  llmClientFactory?: (config: LlmConfig) => LlmClient;
}
