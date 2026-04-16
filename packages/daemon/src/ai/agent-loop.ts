import type { OwlConfig, OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { ConversationStore } from './conversations.js';
import type { LlmClient, LlmContentBlock, LlmToolCall, StreamChunk } from './llm-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
  type ToolContext,
  type ToolDef,
  type ToolRegistry,
  type WriteSideEffect,
  isWriteToolResult,
} from './tool-registry.js';

const MAX_ITERATIONS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Public types ──────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'conversation_id'; conversation_id: string }
  | { type: 'message'; content: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown>; tool_call_id: string }
  | { type: 'tool_result'; tool: string; tool_call_id: string; result: unknown; is_error: boolean }
  | {
      type: 'note_applied';
      note_id: string;
      content: string;
      appended_text: string;
    }
  | {
      type: 'draft_ready';
      action: 'create' | 'update' | 'create_reminder';
      note_id: string;
      content: string;
      tags: string[];
      folder_id: string | null;
      original_content?: string;
      original_tags?: string[];
      original_folder_id?: string | null;
    }
  | {
      type: 'preview_ready';
      preview_id: string;
      action: string;
      diff: string;
      content: string;
      tags: string[];
      folder_id?: string | null;
    }
  | { type: 'error'; message: string }
  | { type: 'done'; conversation_id: string; stop_reason: string };

export interface RunAgentLoopOptions {
  /** User-supplied message text. Required. */
  message: string;
  /** Existing conversation id; omit to create a new conversation. */
  conversationId?: string;
  /** Caller-provided abort signal (e.g. SSE client disconnect). */
  signal?: AbortSignal;
  /** Override the per-iteration LLM call timeout. */
  timeoutMs?: number;
  /** Override the iteration cap. */
  maxIterations?: number;
}

export interface RunAgentLoopDeps {
  llmClient: LlmClient;
  registry: ToolRegistry;
  conversations: ConversationStore;
  db: OwlDatabase;
  sqlite: Database.Database;
  config: OwlConfig;
  toolCtx: Omit<ToolContext, 'registry'>;
}

/**
 * The core agent loop. Yields `AgentEvent`s as it streams from the LLM
 * and executes tool calls. Caller (typically the SSE route or a test)
 * pipes events to its consumer; the loop never writes to the wire itself.
 *
 * Each iteration:
 *   1. Stream chunks from `llmClient.chatCompletion(...)`
 *   2. Reassemble text deltas + tool call deltas into a single
 *      assistant message + tool call list
 *   3. Yield `message` for any text, then for each tool call:
 *      yield `tool_call`, execute it, surface any `WriteToolResult`
 *      sideEffect via a typed event, then yield `tool_result`
 *   4. Append assistant + tool result messages to the conversation
 *   5. If no tool calls were made, break — the LLM is done responding
 */
export async function* runAgentLoop(
  options: RunAgentLoopOptions,
  deps: RunAgentLoopDeps,
): AsyncGenerator<AgentEvent> {
  const { conversation, created } = deps.conversations.getOrCreate(options.conversationId);
  yield { type: 'conversation_id', conversation_id: conversation.id };

  // System prompt is rebuilt every turn so date/time + recent-notes stay fresh.
  // Replace any previous system message rather than stacking them.
  const systemContent = buildSystemPrompt(deps.db, deps.sqlite, deps.config.ai);
  if (created || conversation.messages[0]?.role !== 'system') {
    conversation.messages.unshift({ role: 'system', content: systemContent });
  } else {
    conversation.messages[0] = { role: 'system', content: systemContent };
  }

  conversation.messages.push({ role: 'user', content: options.message });
  deps.conversations.trimToRounds(conversation.id, deps.config.ai.context_rounds);

  const tools = deps.registry.toLlmToolDefs();
  const toolCtx: ToolContext = { ...deps.toolCtx, registry: deps.registry };
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stopReason = 'end_turn';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (options.signal?.aborted) {
      yield { type: 'error', message: 'aborted' };
      stopReason = 'aborted';
      break;
    }

    const turnSignal = mergeSignals(options.signal, timeoutMs);
    let assembled: AssembledTurn;
    try {
      assembled = await assembleTurn(
        deps.llmClient.chatCompletion(conversation.messages, tools, {
          signal: turnSignal.signal,
        }),
        turnSignal.cleanup,
      );
    } catch (err) {
      yield { type: 'error', message: errorMessage(err) };
      stopReason = 'error';
      break;
    }

    if (assembled.text) {
      yield { type: 'message', content: assembled.text };
    }

    // Push assistant turn into the conversation BEFORE running tools so
    // the OpenAI/Anthropic adapters see a well-formed request next round
    // (assistant tool_calls must precede the matching tool messages).
    conversation.messages.push({
      role: 'assistant',
      content: assembled.text,
      tool_calls: assembled.toolCalls.length > 0 ? assembled.toolCalls : undefined,
    });

    if (assembled.toolCalls.length === 0) {
      stopReason = assembled.stopReason ?? 'end_turn';
      break;
    }

    for (const call of assembled.toolCalls) {
      const args = parseToolArgs(call.arguments);
      yield { type: 'tool_call', tool: call.name, args, tool_call_id: call.id };

      const tool = deps.registry.get(call.name);
      const { result, isError, sideEffect } = await runTool(tool, call.name, args, toolCtx);

      if (sideEffect) {
        yield sideEffectToEvent(sideEffect);
      }

      yield {
        type: 'tool_result',
        tool: call.name,
        tool_call_id: call.id,
        result,
        is_error: isError,
      };

      conversation.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: stringifyToolResult(result),
      });
    }

    if (iteration === maxIterations - 1) {
      stopReason = 'max_iterations';
    }
  }

  conversation.updatedAt = new Date();
  yield { type: 'done', conversation_id: conversation.id, stop_reason: stopReason };
}

// ─── Stream assembly ───────────────────────────────────────────────────

interface AssembledTurn {
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: string | undefined;
}

/**
 * Drain an LlmClient stream into a single assistant turn. Tool call
 * arguments arrive as `tool_call_delta` chunks that must be concatenated
 * by id; text deltas concatenate into one string.
 */
async function assembleTurn(
  stream: AsyncIterable<StreamChunk>,
  cleanup: () => void,
): Promise<AssembledTurn> {
  const textParts: string[] = [];
  const toolCallById = new Map<string, { name: string; arguments: string; index: number }>();
  const orderById = new Map<string, number>();
  let nextIndex = 0;
  let stopReason: string | undefined;

  try {
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text_delta':
          textParts.push(chunk.text);
          break;
        case 'tool_call_start':
          if (!toolCallById.has(chunk.id)) {
            toolCallById.set(chunk.id, { name: chunk.name, arguments: '', index: nextIndex });
            orderById.set(chunk.id, nextIndex);
            nextIndex++;
          }
          break;
        case 'tool_call_delta': {
          const entry = toolCallById.get(chunk.id);
          if (entry) entry.arguments += chunk.arguments;
          break;
        }
        case 'tool_call_end':
          // Nothing to do — the entry already exists; we close out below.
          break;
        case 'done':
          stopReason = chunk.stop_reason;
          break;
      }
    }
  } finally {
    cleanup();
  }

  const toolCalls: LlmToolCall[] = [...toolCallById.entries()]
    .sort(([, a], [, b]) => a.index - b.index)
    .map(([id, entry]) => ({ id, name: entry.name, arguments: entry.arguments }));

  return { text: textParts.join(''), toolCalls, stopReason };
}

// ─── Tool execution ────────────────────────────────────────────────────

interface ToolRunResult {
  result: unknown;
  isError: boolean;
  sideEffect: WriteSideEffect | undefined;
}

async function runTool(
  tool: ToolDef | undefined,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolRunResult> {
  if (!tool) {
    return { result: { error: `Unknown tool: ${name}` }, isError: true, sideEffect: undefined };
  }
  try {
    const raw = await tool.execute(args, ctx);
    if (isWriteToolResult(raw)) {
      return { result: { message: raw.message }, isError: false, sideEffect: raw.sideEffect };
    }
    return { result: raw, isError: false, sideEffect: undefined };
  } catch (err) {
    ctx.logger.warn({ tool: name, err }, 'tool execution failed');
    return { result: { error: errorMessage(err) }, isError: true, sideEffect: undefined };
  }
}

function sideEffectToEvent(side: WriteSideEffect): AgentEvent {
  switch (side.type) {
    case 'note_applied':
      return { type: 'note_applied', ...side.payload };
    case 'draft_ready':
      return { type: 'draft_ready', ...side.payload };
    case 'preview_ready':
      return { type: 'preview_ready', ...side.payload };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function stringifyToolResult(result: unknown): string | LlmContentBlock[] {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface SignalBundle {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Combine the caller's optional AbortSignal with a per-iteration timeout
 * and return both the merged signal and a cleanup function that cancels
 * the timer + detaches the abort listener once the stream is drained.
 *
 * `AbortSignal.any` exists in modern Node but is gated on >=20.3, so we
 * stitch the signals together manually for portability.
 */
function mergeSignals(parent: AbortSignal | undefined, timeoutMs: number): SignalBundle {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('LLM call timed out')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

// Re-export tool side-effect types for tests / route consumers.
export type { ToolContext } from './tool-registry.js';
