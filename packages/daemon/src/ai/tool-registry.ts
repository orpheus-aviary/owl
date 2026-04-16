import type { Logger, OwlConfig, OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { ReminderScheduler } from '../scheduler.js';
import type { LlmToolDef } from './llm-client.js';

// ─── Context passed to every tool ──────────────────────────────────────

/**
 * Distinguishes tool calls originating from the local GUI's chat panel
 * (`gui`) from those proxied in by external agents over the daemon API
 * (`external`). Tier-2 write tools (P2-7e) branch on this — gui produces a
 * `draft_ready` event while external produces `preview_ready`.
 */
export type ToolSource = 'gui' | 'external';

export interface ToolContext {
  db: OwlDatabase;
  sqlite: Database.Database;
  config: OwlConfig;
  deviceId: string;
  scheduler: ReminderScheduler;
  source: ToolSource;
  logger: Logger;
  /** Filled in lazily by the agent loop / route handler so `get_capabilities` can introspect siblings. */
  registry?: ToolRegistry;
}

// ─── Write contract (defined here, used by P2-7b Tier-1 + P2-7e Tier-2) ─

/**
 * Side-effect descriptors emitted by DB-modifying tools. The agent loop
 * (P2-7c) inspects this and yields a matching `AgentEvent` to SSE clients
 * BEFORE the corresponding `tool_result` so the GUI can stage the change.
 */
export type WriteSideEffect =
  | {
      type: 'note_applied';
      payload: { note_id: string; content: string; appended_text: string };
    }
  | {
      type: 'draft_ready';
      payload: {
        action: 'create' | 'update' | 'create_reminder';
        note_id: string;
        content: string;
        tags: string[];
        folder_id: string | null;
        original_content?: string;
        original_tags?: string[];
        original_folder_id?: string | null;
      };
    }
  | {
      type: 'preview_ready';
      payload: {
        preview_id: string;
        action: string;
        diff: string;
        content: string;
        tags: string[];
        folder_id?: string | null;
      };
    };

export interface WriteToolResult {
  /** Text shown back to the LLM as the tool result. */
  message: string;
  sideEffect?: WriteSideEffect;
}

export function isWriteToolResult(value: unknown): value is WriteToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    'sideEffect' in (value as object)
  );
}

// ─── Tool definition + registry ────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07) for the tool's input. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** Convert the registry into the LLM-facing schema list. */
  toLlmToolDefs(): LlmToolDef[] {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}
