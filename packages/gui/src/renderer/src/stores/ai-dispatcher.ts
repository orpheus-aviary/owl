import type {
  ChatMessage,
  ChatTabState,
  ChatToolCall,
  DraftReadyCard,
  PreviewReadyCard,
} from './ai-store-types';

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
 * It owns mutations to:
 *   • the target ChatTabState (conversationId, isStreaming flags)
 *   • the assistant ChatMessage (text, toolCalls, drafts, previews)
 *   • the global noteAppliedNotices queue (toast lane consumed by Step 6)
 *
 * Anything outside this trio (e.g. invoking the editor's auto-merge) is
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

export interface DispatcherState {
  chats: ChatTabState[];
  noteAppliedNotices: NoteAppliedNotice[];
}

export interface DispatchInput {
  state: DispatcherState;
  chatId: string;
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
      return handleConversationId(input);
    case 'message':
      return handleMessage(input);
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

function handleConversationId({ state, chatId, data }: DispatchInput): DispatcherState {
  const conversationId = readString(data, 'conversation_id');
  if (!conversationId) return state;
  return { ...state, chats: patchChat(state.chats, chatId, (c) => ({ ...c, conversationId })) };
}

function handleMessage({
  state,
  chatId,
  assistantMessageId,
  data,
}: DispatchInput): DispatcherState {
  const text = readString(data, 'content');
  if (!text) return state;
  return {
    ...state,
    chats: patchAssistantMessage(state.chats, chatId, assistantMessageId, (m) => ({
      ...m,
      content: m.content + text,
    })),
  };
}

function handleToolCall({
  state,
  chatId,
  assistantMessageId,
  data,
}: DispatchInput): DispatcherState {
  if (!isObject(data)) return state;
  const id = typeof data.tool_call_id === 'string' ? data.tool_call_id : null;
  const name = typeof data.tool === 'string' ? data.tool : null;
  if (!id || !name) return state;
  const args = isObject(data.args) ? (data.args as Record<string, unknown>) : {};
  const newCall: ChatToolCall = { id, name, args };
  return {
    ...state,
    chats: patchAssistantMessage(state.chats, chatId, assistantMessageId, (m) => ({
      ...m,
      toolCalls: [...m.toolCalls, newCall],
    })),
  };
}

function handleToolResult({
  state,
  chatId,
  assistantMessageId,
  data,
}: DispatchInput): DispatcherState {
  if (!isObject(data)) return state;
  const id = typeof data.tool_call_id === 'string' ? data.tool_call_id : null;
  if (!id) return state;
  return {
    ...state,
    chats: patchAssistantMessage(state.chats, chatId, assistantMessageId, (m) => ({
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
  chatId,
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
  };
  return {
    ...state,
    chats: patchAssistantMessage(state.chats, chatId, assistantMessageId, (m) => ({
      ...m,
      drafts: [...m.drafts, card],
    })),
  };
}

function handlePreviewReady({
  state,
  chatId,
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
    chats: patchAssistantMessage(state.chats, chatId, assistantMessageId, (m) => ({
      ...m,
      previews: [...m.previews, card],
    })),
  };
}

function handleError({ state, chatId, assistantMessageId, data }: DispatchInput): DispatcherState {
  const message = readString(data, 'message') ?? 'unknown error';
  return {
    ...state,
    chats: patchAssistantMessage(state.chats, chatId, assistantMessageId, (m) => ({
      ...m,
      error: message,
      isStreaming: false,
    })),
  };
}

function handleDone({ state, chatId, assistantMessageId }: DispatchInput): DispatcherState {
  // Mark the assistant message stream as closed but leave content as-is.
  // The store's `finally` block also clears the tab-level isStreaming flag —
  // doing it here too means components reading just the message can react
  // without subscribing to the parent tab.
  return {
    ...state,
    chats: patchAssistantMessage(state.chats, chatId, assistantMessageId, (m) => ({
      ...m,
      isStreaming: false,
    })),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function patchChat(
  chats: ChatTabState[],
  chatId: string,
  patch: (tab: ChatTabState) => ChatTabState,
): ChatTabState[] {
  return chats.map((c) => (c.id === chatId ? patch(c) : c));
}

function patchAssistantMessage(
  chats: ChatTabState[],
  chatId: string,
  messageId: string,
  patch: (msg: ChatMessage) => ChatMessage,
): ChatTabState[] {
  return patchChat(chats, chatId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId ? patch(m) : m)),
  }));
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
