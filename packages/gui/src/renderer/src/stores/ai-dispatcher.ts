import type { ChatMessage, ChatToolCall, DraftReadyCard, PreviewReadyCard } from './ai-store-types';

/**
 * Pure-function SSE event dispatcher for the AI chat. Lives apart from
 * `ai-store.ts` (which holds the zustand setter) so it can be unit-tested
 * directly: feed in a state snapshot, get back the next snapshot.
 *
 * The dispatcher knows about *all 9* AgentEvent types emitted by the
 * daemon (see docs/plans/2026-04-17-p2-7-ai-implementation.md):
 *
 *   conversation_id | message | tool_call | tool_result | note_applied
 *   draft_ready     | preview_ready | error | done
 *
 * P3.4-f rewrote this for the flat per-conversation state: it now owns
 * mutations to a *messages[]* array directly plus the global
 * `noteAppliedNotices` queue. It does NOT know about the sidebar
 * conversations list — that's handled by the store wrapper (e.g., the
 * store refreshes the sidebar after send completes).
 *
 * Anything outside this scope (e.g. invoking the editor's auto-merge) is
 * intentionally NOT done here — those side effects fire from the store's
 * onEvent wrapper after dispatch returns. Keeps the dispatcher pure.
 */

// ─── Types ─────────────────────────────────────────────────────────────

export interface NoteAppliedNotice {
  /** Local id for React keys + toast queue dedup. */
  id: string;
  noteId: string;
  /** Text the AI just appended (e.g. memo body). */
  appendedText: string;
  /** Full DB content after the append, used by editor auto-merge in Step 6. */
  latestContent: string;
  receivedAt: number;
}

/**
 * Dispatch input/output shape. Split from the zustand state so the
 * dispatcher is framework-agnostic.
 */
export interface DispatcherState {
  messages: ChatMessage[];
  noteAppliedNotices: NoteAppliedNotice[];
}

export interface DispatchInput {
  state: DispatcherState;
  /** Id of the assistant message that's currently streaming. */
  assistantMessageId: string;
  event: string;
  data: unknown;
  /** Source of fresh local ids — injected so tests can be deterministic. */
  newLocalId: () => string;
}

// ─── Entry point ───────────────────────────────────────────────────────

export function dispatchAgentEvent(input: DispatchInput): DispatcherState {
  const { event } = input;
  switch (event) {
    case 'conversation_id':
      // Id is owned by the store (it generates the id up front and passes
      // it to /ai/chat). The SSE echo is discarded — no state change.
      return input.state;
    case 'message':
      return handleMessage(input);
    case 'thinking':
      return handleThinking(input);
    case 'tool_call':
      return handleToolCall(input);
    case 'tool_result':
      return handleToolResult(input);
    case 'note_applied':
      return handleNoteApplied(input);
    case 'draft_ready':
      return handleDraftReady(input);
    case 'preview_ready':
      return handlePreviewReady(input);
    case 'error':
      return handleError(input);
    case 'done':
      return handleDone(input);
    default:
      // Unknown event from a future daemon version — leave state alone.
      return input.state;
  }
}

// ─── Per-event handlers ────────────────────────────────────────────────

function handleMessage({ state, assistantMessageId, data }: DispatchInput): DispatcherState {
  const text = readString(data, 'content');
  if (!text) return state;
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      content: m.content + text,
    })),
  };
}

function handleThinking({ state, assistantMessageId, data }: DispatchInput): DispatcherState {
  const text = readString(data, 'content');
  if (!text) return state;
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      thinking: m.thinking + text,
    })),
  };
}

function handleToolCall({ state, assistantMessageId, data }: DispatchInput): DispatcherState {
  if (!isObject(data)) return state;
  const id = typeof data.tool_call_id === 'string' ? data.tool_call_id : null;
  const name = typeof data.tool === 'string' ? data.tool : null;
  if (!id || !name) return state;
  const args = isObject(data.args) ? (data.args as Record<string, unknown>) : {};
  const newCall: ChatToolCall = { id, name, args };
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      toolCalls: [...m.toolCalls, newCall],
    })),
  };
}

function handleToolResult({ state, assistantMessageId, data }: DispatchInput): DispatcherState {
  if (!isObject(data)) return state;
  const id = typeof data.tool_call_id === 'string' ? data.tool_call_id : null;
  if (!id) return state;
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      toolCalls: m.toolCalls.map((tc) =>
        tc.id === id ? { ...tc, result: data.result, isError: data.is_error === true } : tc,
      ),
    })),
  };
}

function handleNoteApplied({ state, data, newLocalId }: DispatchInput): DispatcherState {
  if (!isObject(data)) return state;
  const noteId = typeof data.note_id === 'string' ? data.note_id : null;
  const appendedText = typeof data.appended_text === 'string' ? data.appended_text : '';
  const latestContent = typeof data.content === 'string' ? data.content : '';
  if (!noteId) return state;
  const notice: NoteAppliedNotice = {
    id: newLocalId(),
    noteId,
    appendedText,
    latestContent,
    receivedAt: Date.now(),
  };
  // Tier-1 events DON'T touch chat messages — they're rendered as toasts
  // and forwarded to the editor via the store wrapper (Step 6).
  return { ...state, noteAppliedNotices: [...state.noteAppliedNotices, notice] };
}

function handleDraftReady({
  state,
  assistantMessageId,
  data,
  newLocalId,
}: DispatchInput): DispatcherState {
  if (!isObject(data)) return state;
  const action = data.action;
  if (action !== 'create' && action !== 'update' && action !== 'create_reminder') return state;
  const noteId = typeof data.note_id === 'string' ? data.note_id : null;
  if (!noteId) return state;
  const card: DraftReadyCard = {
    localId: newLocalId(),
    action,
    note_id: noteId,
    content: typeof data.content === 'string' ? data.content : '',
    tags: readStringArray(data.tags),
    folder_id: typeof data.folder_id === 'string' ? data.folder_id : null,
    original_content: typeof data.original_content === 'string' ? data.original_content : undefined,
    original_tags: data.original_tags ? readStringArray(data.original_tags) : undefined,
    original_folder_id:
      data.original_folder_id === null || typeof data.original_folder_id === 'string'
        ? (data.original_folder_id as string | null)
        : undefined,
    opened: false,
    approved: false,
    approving: false,
    error: null,
  };
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      drafts: [...m.drafts, card],
    })),
  };
}

function handlePreviewReady({
  state,
  assistantMessageId,
  data,
  newLocalId,
}: DispatchInput): DispatcherState {
  if (!isObject(data)) return state;
  const previewId = typeof data.preview_id === 'string' ? data.preview_id : null;
  if (!previewId) return state;
  const card: PreviewReadyCard = {
    localId: newLocalId(),
    preview_id: previewId,
    action: typeof data.action === 'string' ? data.action : '',
    diff: typeof data.diff === 'string' ? data.diff : '',
    content: typeof data.content === 'string' ? data.content : '',
    tags: readStringArray(data.tags),
    folder_id: typeof data.folder_id === 'string' ? data.folder_id : null,
  };
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      previews: [...m.previews, card],
    })),
  };
}

function handleError({ state, assistantMessageId, data }: DispatchInput): DispatcherState {
  const message = readString(data, 'message') ?? 'unknown error';
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      error: message,
      isStreaming: false,
    })),
  };
}

function handleDone({ state, assistantMessageId }: DispatchInput): DispatcherState {
  // Mark the assistant message stream as closed. The store's finally block
  // also clears `streamingByConversation[id].isStreaming`.
  return {
    ...state,
    messages: patchMessage(state.messages, assistantMessageId, (m) => ({
      ...m,
      isStreaming: false,
    })),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function patchMessage(
  messages: ChatMessage[],
  messageId: string,
  patch: (msg: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((m) => (m.id === messageId ? patch(m) : m));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(data: unknown, key: string): string | null {
  if (!isObject(data)) return null;
  const v = data[key];
  return typeof v === 'string' ? v : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
