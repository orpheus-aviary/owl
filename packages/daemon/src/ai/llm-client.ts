import Anthropic from '@anthropic-ai/sdk';
import type {
  Tool as AnthropicTool,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { LlmConfig } from '@owl/core';
import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions.js';

type OpenAiToolCallDelta = ChatCompletionChunk.Choice.Delta.ToolCall;

// ─── Public Types ──────────────────────────────────────────────────────

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft-07) describing the tool input. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments — agent loop is responsible for parsing. */
  arguments: string;
}

export interface LlmContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  /** tool_use: provider-assigned id; tool_result: target tool_use id. */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  /** Stringified tool result body (or human-readable error). */
  content?: string;
  is_error?: boolean;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LlmContentBlock[];
  /** Required when role === 'tool' (matches OpenAI tool_call_id semantics). */
  tool_call_id?: string;
  /** Assistant tool call requests (OpenAI-style; translated for Anthropic). */
  tool_calls?: LlmToolCall[];
}

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done'; stop_reason: string };

export interface ChatOptions {
  max_tokens?: number;
  temperature?: number;
  /** Forwarded to fetch as AbortSignal so the route can cancel mid-stream. */
  signal?: AbortSignal;
}

export interface LlmClient {
  chatCompletion(
    messages: LlmMessage[],
    tools: LlmToolDef[],
    options?: ChatOptions,
  ): AsyncIterable<StreamChunk>;
}

/**
 * Build an LlmClient backed by the OpenAI or Anthropic SDK based on
 * `config.api_format`. Created per-request so config edits take effect
 * immediately without a daemon restart.
 */
export function createLlmClient(config: LlmConfig): LlmClient {
  if (!config.url || !config.model || !config.api_key) {
    throw new Error('LLM not configured: url, model, and api_key are all required');
  }
  if (config.api_format === 'anthropic') {
    return new AnthropicAdapter(config);
  }
  return new OpenAiAdapter(config);
}

// ─── OpenAI Adapter ────────────────────────────────────────────────────

class OpenAiAdapter implements LlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: LlmConfig) {
    // OpenAI SDK expects baseURL ending at /v1 (it appends /chat/completions).
    // Just strip any trailing slash; users are expected to include /v1 themselves
    // (consistent with how the existing pingLlm constructs `${url}/chat/completions`).
    this.client = new OpenAI({
      baseURL: config.url.replace(/\/+$/, ''),
      apiKey: config.api_key,
    });
    this.model = config.model;
  }

  async *chatCompletion(
    messages: LlmMessage[],
    tools: LlmToolDef[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamChunk> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages.map(toOpenAiMessage),
        tools: tools.length > 0 ? tools.map(toOpenAiTool) : undefined,
        stream: true,
        max_tokens: options.max_tokens,
        temperature: options.temperature,
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    // Track tool calls keyed by index, mapping to provider id once seen.
    const toolCallIdsByIndex = new Map<number, string>();

    for await (const chunk of stream) {
      yield* translateOpenAiChunk(chunk, toolCallIdsByIndex);
    }
  }
}

function* translateOpenAiChunk(
  chunk: ChatCompletionChunk,
  toolCallIdsByIndex: Map<number, string>,
): Generator<StreamChunk> {
  const choice = chunk.choices[0];
  if (!choice) return;
  const { delta, finish_reason } = choice;

  if (delta.content) {
    yield { type: 'text_delta', text: delta.content };
  }
  if (delta.tool_calls) {
    yield* translateOpenAiToolDeltas(delta.tool_calls, toolCallIdsByIndex);
  }
  if (finish_reason) {
    // Close out any open tool calls before signaling done.
    for (const id of toolCallIdsByIndex.values()) {
      yield { type: 'tool_call_end', id };
    }
    toolCallIdsByIndex.clear();
    yield { type: 'done', stop_reason: finish_reason };
  }
}

function* translateOpenAiToolDeltas(
  deltas: OpenAiToolCallDelta[],
  toolCallIdsByIndex: Map<number, string>,
): Generator<StreamChunk> {
  for (const tc of deltas) {
    const fn = tc.function;
    let id = toolCallIdsByIndex.get(tc.index);
    if (!id && tc.id) {
      id = tc.id;
      toolCallIdsByIndex.set(tc.index, id);
      yield { type: 'tool_call_start', id, name: fn?.name ?? '' };
    }
    if (id && fn?.arguments) {
      yield { type: 'tool_call_delta', id, arguments: fn.arguments };
    }
  }
}

function toOpenAiTool(tool: LlmToolDef): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAiMessage(msg: LlmMessage): ChatCompletionMessageParam {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: contentToText(msg.content) };
    case 'user':
      return { role: 'user', content: contentToText(msg.content) };
    case 'assistant': {
      const out: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: contentToText(msg.content) || null,
      };
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        out.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return out;
    }
    case 'tool': {
      if (!msg.tool_call_id) {
        throw new Error('LlmMessage with role=tool must have tool_call_id');
      }
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: contentToText(msg.content),
      };
    }
  }
}

// ─── Anthropic Adapter ─────────────────────────────────────────────────

class AnthropicAdapter implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: LlmConfig) {
    // Anthropic SDK appends `/v1/messages` itself, so strip a trailing /v1
    // (and any trailing slashes) from user-supplied url.
    const baseURL = config.url.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.client = new Anthropic({ baseURL, apiKey: config.api_key });
    this.model = config.model;
  }

  async *chatCompletion(
    messages: LlmMessage[],
    tools: LlmToolDef[],
    options: ChatOptions = {},
  ): AsyncIterable<StreamChunk> {
    const { system, messages: anthMessages } = toAnthropicMessages(messages);

    const params: MessageCreateParamsStreaming = {
      model: this.model,
      // Anthropic requires an explicit max_tokens; pick a generous default so
      // the agent loop can override per call without hitting truncation.
      max_tokens: options.max_tokens ?? 4096,
      messages: anthMessages,
      stream: true,
    };
    if (system) params.system = system;
    if (tools.length > 0) params.tools = tools.map(toAnthropicTool);
    if (options.temperature !== undefined) params.temperature = options.temperature;

    const stream = (await this.client.messages.create(
      params,
      options.signal ? { signal: options.signal } : undefined,
    )) as AsyncIterable<RawMessageStreamEvent>;

    // index → tool_use id, so input_json_delta events can be routed back.
    const toolCallByIndex = new Map<number, string>();

    for await (const event of stream) {
      yield* translateAnthropicEvent(event, toolCallByIndex);
    }
  }
}

function* translateAnthropicEvent(
  event: RawMessageStreamEvent,
  toolCallByIndex: Map<number, string>,
): Generator<StreamChunk> {
  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block.type === 'tool_use') {
      toolCallByIndex.set(event.index, block.id);
      yield { type: 'tool_call_start', id: block.id, name: block.name };
    }
    return;
  }
  if (event.type === 'content_block_delta') {
    yield* translateAnthropicBlockDelta(event, toolCallByIndex);
    return;
  }
  if (event.type === 'content_block_stop') {
    const id = toolCallByIndex.get(event.index);
    if (id) {
      toolCallByIndex.delete(event.index);
      yield { type: 'tool_call_end', id };
    }
    return;
  }
  if (event.type === 'message_delta' && event.delta.stop_reason) {
    yield { type: 'done', stop_reason: event.delta.stop_reason };
  }
  // message_start, message_stop, content_block_start (text) — no-op.
}

function* translateAnthropicBlockDelta(
  event: Extract<RawMessageStreamEvent, { type: 'content_block_delta' }>,
  toolCallByIndex: Map<number, string>,
): Generator<StreamChunk> {
  const delta = event.delta;
  if (delta.type === 'text_delta') {
    yield { type: 'text_delta', text: delta.text };
    return;
  }
  if (delta.type === 'input_json_delta') {
    const id = toolCallByIndex.get(event.index);
    if (id) yield { type: 'tool_call_delta', id, arguments: delta.partial_json };
  }
}

function toAnthropicTool(tool: LlmToolDef): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool['input_schema'],
  };
}

/**
 * Translate the OpenAI-flavored LlmMessage list into Anthropic's shape:
 * - system messages collapse into a single `system` string
 * - assistant `tool_calls` become tool_use content blocks
 * - role=tool messages become tool_result blocks inside a user message
 *   (consecutive tool results merge into one user message — Anthropic
 *   requires parallel tool results to share a single user turn)
 */
function toAnthropicMessages(messages: LlmMessage[]): {
  system: string | undefined;
  messages: MessageParam[];
} {
  const systemParts: string[] = [];
  const out: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = contentToText(msg.content);
      if (text) systemParts.push(text);
    } else if (msg.role === 'tool') {
      appendToolResult(out, msg);
    } else if (msg.role === 'user') {
      out.push({ role: 'user', content: contentToText(msg.content) });
    } else {
      out.push(buildAssistantMessage(msg));
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

function appendToolResult(out: MessageParam[], msg: LlmMessage): void {
  if (!msg.tool_call_id) {
    throw new Error('LlmMessage with role=tool must have tool_call_id');
  }
  const block = {
    type: 'tool_result' as const,
    tool_use_id: msg.tool_call_id,
    content: contentToText(msg.content),
  };
  const last = out[out.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    last.content.push(block);
  } else {
    out.push({ role: 'user', content: [block] });
  }
}

function buildAssistantMessage(msg: LlmMessage): MessageParam {
  const blocks: Array<{ type: 'text'; text: string } | ToolUseBlockParam> = [];
  const text = contentToText(msg.content);
  if (text) blocks.push({ type: 'text', text });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: parseJsonObject(tc.arguments),
      });
    }
  }
  return { role: 'assistant', content: blocks };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function contentToText(content: string | LlmContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'tool_result') return block.content ?? '';
      return '';
    })
    .join('');
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
