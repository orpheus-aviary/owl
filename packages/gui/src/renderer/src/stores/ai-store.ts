import * as api from '@/lib/api';
import type { AiHistoryMessage } from '@/lib/api';
import { type SseHttpError, streamSse } from '@/lib/sse-client';
import { create } from 'zustand';
import { type NoteAppliedNotice, dispatchAgentEvent } from './ai-dispatcher';
import type { ChatMessage, ChatToolCall, ConversationMeta, StreamingState } from './ai-store-types';
import { useDataBus } from './data-bus';
import { useEditorStore } from './editor-store';

export type {
  ChatRole,
  ChatToolCall,
  DraftReadyCard,
  PreviewReadyCard,
  ChatMessage,
  ConversationMeta,
  StreamingState,
} from './ai-store-types';
export type { NoteAppliedNotice } from './ai-dispatcher';

/**
 * AI chat state (P3.4-f).
 *
 * State is split into three keyed-by-id maps rather than a monolithic
 * `chats[]` so the concerns stay separable:
 *   • `conversations`             — sidebar meta list, sourced from DB
 *   • `messagesByConversation`    — lazy-hydrated on click; also filled
 *                                    live by the SSE dispatcher for the
 *                                    active send
 *   • `streamingByConversation`   — per-conversation stream state; kept
 *                                    alive across setActiveConversation
 *                                    so users can switch away from a
 *                                    running chat without aborting it
 *
 * Ephemeral conversations (user clicked "新建" but hasn't sent yet) live
 * in `messagesByConversation` only; they don't appear in `conversations`
 * until the first send persists them on the daemon.
 */

interface AiState {
  conversations: ConversationMeta[];
  conversationsLoaded: boolean;
  messagesByConversation: Record<string, ChatMessage[]>;
  streamingByConversation: Record<string, StreamingState>;
  activeConversationId: string | null;
  noteAppliedNotices: NoteAppliedNotice[];
  scrollByConversation: Record<string, number>;

  newConversation: () => string;
  setActiveConversation: (id: string) => void;
  /** Load sidebar list from the daemon; idempotent. */
  loadConversations: () => Promise<void>;
  /** Load a conversation's full message history, if not already cached. */
  loadConversation: (id: string) => Promise<void>;
  sendMessage: (id: string, text: string) => Promise<void>;
  abortStreaming: (id: string) => void;
  /**
   * Delete a conversation. Ephemeral (never persisted) ids only clear
   * local state; persisted ids also DELETE the daemon row (CASCADE clears
   * ai_messages). Refreshes `conversations` from the daemon afterwards.
   */
  deleteConversation: (id: string) => Promise<void>;
  /** Drop a notice from the queue once its toast has been dismissed. */
  dismissNoteAppliedNotice: (noticeId: string) => void;
  /**
   * Flip a DraftReadyCard's `opened` flag so the card's "打开" button
   * becomes "已打开". Called after the editor accepts the draft.
   */
  markDraftOpened: (conversationId: string, messageId: string, draftLocalId: string) => void;
  /**
   * Apply a single draft via the daemon REST API, bypassing the editor
   * staging flow. Reuses P2-8's Tier-1 path (toast + bus refresh, no tab
   * opens). Failures surface on draft.error so the user can retry.
   */
  approveDraft: (conversationId: string, messageId: string, draftLocalId: string) => Promise<void>;
  /** Approve every unprocessed draft on a message in parallel. */
  approveAllDrafts: (conversationId: string, messageId: string) => Promise<void>;
  /** Record the message list's scrollTop for a given conversation. */
  setConversationScroll: (conversationId: string, scrollTop: number) => void;
}

const TITLE_MAX = 32;

function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '新对话';
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX)}…` : collapsed;
}

function localId(): string {
  return crypto.randomUUID();
}

const emptyStreaming: StreamingState = {
  isStreaming: false,
  abortController: null,
  assistantMessageId: null,
};

export const useAiStore = create<AiState>((set, get) => ({
  conversations: [],
  conversationsLoaded: false,
  messagesByConversation: {},
  streamingByConversation: {},
  activeConversationId: null,
  noteAppliedNotices: [],
  scrollByConversation: {},

  setConversationScroll: (conversationId, scrollTop) => {
    set((state) => ({
      scrollByConversation: { ...state.scrollByConversation, [conversationId]: scrollTop },
    }));
  },

  newConversation: () => {
    // Generate the id up front; the same UUID flows GUI → /ai/chat →
    // daemon.getOrCreate → ai_conversations.id. Three-way agreement.
    // Ephemeral until the first send persists it.
    const id = localId();
    set((state) => ({
      messagesByConversation: { ...state.messagesByConversation, [id]: [] },
      activeConversationId: id,
    }));
    return id;
  },

  setActiveConversation: (id) => {
    // Deliberately does NOT abort other conversations' streams —
    // switching away from a running chat should leave it cooking
    // in the background. See P3.4-f load-bearing contract §10.
    set({ activeConversationId: id });
  },

  loadConversations: async () => {
    try {
      const res = await api.listAiConversations();
      const conversations: ConversationMeta[] = (res.data?.conversations ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: Date.parse(c.created_at),
        updatedAt: Date.parse(c.updated_at),
        messageCount: c.message_count,
      }));
      set({ conversations, conversationsLoaded: true });
    } catch (err) {
      console.error('loadConversations failed', err);
    }
  },

  loadConversation: async (id) => {
    // Already hydrated (either from a previous load or a live send)?
    // Skip the refetch — the live messages are the authoritative copy.
    if (get().messagesByConversation[id]?.length) return;
    try {
      const res = await api.getAiConversation(id);
      const historyMessages: AiHistoryMessage[] = res.data?.messages ?? [];
      const messages = hydrateDaemonMessages(historyMessages);
      set((state) => ({
        messagesByConversation: { ...state.messagesByConversation, [id]: messages },
      }));
    } catch (err) {
      console.error('loadConversation failed', err);
    }
  },

  abortStreaming: (conversationId) => {
    const stream = get().streamingByConversation[conversationId];
    if (!stream?.isStreaming) return;
    // Tag the in-flight assistant message so the bubble can render a
    // subtle "已停止生成" hint and distinguish user-abort from an
    // actual `error` event.
    const msgId = stream.assistantMessageId;
    if (msgId) {
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((m) =>
            m.id === msgId && m.role === 'assistant' && m.isStreaming ? { ...m, aborted: true } : m,
          ),
        },
      }));
    }
    stream.abortController?.abort();
  },

  dismissNoteAppliedNotice: (noticeId) => {
    set((state) => ({
      noteAppliedNotices: state.noteAppliedNotices.filter((n) => n.id !== noticeId),
    }));
  },

  markDraftOpened: (conversationId, messageId, draftLocalId) => {
    patchDraft(set, conversationId, messageId, draftLocalId, () => ({ opened: true }));
  },

  approveDraft: async (conversationId, messageId, draftLocalId) => {
    const draft = findDraft(get(), conversationId, messageId, draftLocalId);
    if (!draft || draft.approved || draft.approving) return;
    patchDraft(set, conversationId, messageId, draftLocalId, () => ({
      approving: true,
      error: null,
    }));
    try {
      await applyDraftViaApi(draft);
      patchDraft(set, conversationId, messageId, draftLocalId, () => ({
        approved: true,
        approving: false,
        error: null,
      }));
      addNoteAppliedToast(set, draft);
      useDataBus.getState().bumpNotes();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchDraft(set, conversationId, messageId, draftLocalId, () => ({
        approving: false,
        error: message,
      }));
    }
  },

  approveAllDrafts: async (conversationId, messageId) => {
    const message = findMessage(get(), conversationId, messageId);
    if (!message) return;
    const targets = message.drafts.filter((d) => !d.approved && !d.opened && !d.approving);
    await Promise.all(targets.map((d) => get().approveDraft(conversationId, messageId, d.localId)));
  },

  deleteConversation: async (id) => {
    const state = get();
    const stream = state.streamingByConversation[id];
    stream?.abortController?.abort();

    const isPersisted = state.conversations.some((c) => c.id === id);
    if (isPersisted) {
      try {
        await api.deleteAiConversation(id);
      } catch {
        // Best-effort: if daemon just restarted, we still want to clear local state.
      }
    }

    set((s) => {
      const { [id]: _msgs, ...restMessages } = s.messagesByConversation;
      const { [id]: _stream, ...restStreaming } = s.streamingByConversation;
      const { [id]: _scroll, ...restScroll } = s.scrollByConversation;
      const nextActive = s.activeConversationId === id ? null : s.activeConversationId;
      return {
        conversations: s.conversations.filter((c) => c.id !== id),
        messagesByConversation: restMessages,
        streamingByConversation: restStreaming,
        scrollByConversation: restScroll,
        activeConversationId: nextActive,
      };
    });
  },

  sendMessage: async (conversationId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const stream = get().streamingByConversation[conversationId];
    if (stream?.isStreaming) return;

    const userMsg: ChatMessage = {
      id: localId(),
      role: 'user',
      content: trimmed,
      thinking: '',
      toolCalls: [],
      drafts: [],
      previews: [],
      isStreaming: false,
    };
    const assistantMsg: ChatMessage = {
      id: localId(),
      role: 'assistant',
      content: '',
      thinking: '',
      toolCalls: [],
      drafts: [],
      previews: [],
      isStreaming: true,
    };
    const controller = new AbortController();

    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: [
          ...(state.messagesByConversation[conversationId] ?? []),
          userMsg,
          assistantMsg,
        ],
      },
      streamingByConversation: {
        ...state.streamingByConversation,
        [conversationId]: {
          isStreaming: true,
          abortController: controller,
          assistantMessageId: assistantMsg.id,
        },
      },
    }));

    try {
      await streamSse({
        path: '/ai/chat',
        // Always pass conversation_id — our UUID becomes the DB primary key.
        body: { message: trimmed, conversation_id: conversationId },
        signal: controller.signal,
        onEvent: (event, data) => {
          set((state) => {
            const prevMessages = state.messagesByConversation[conversationId] ?? [];
            const next = dispatchAgentEvent({
              state: { messages: prevMessages, noteAppliedNotices: state.noteAppliedNotices },
              assistantMessageId: assistantMsg.id,
              event,
              data,
              newLocalId: localId,
            });
            return {
              messagesByConversation: {
                ...state.messagesByConversation,
                [conversationId]: next.messages,
              },
              noteAppliedNotices: next.noteAppliedNotices,
            };
          });
          // Tier-1 side-effect: push the DB-reconciled content into any
          // open editor tab. The dispatcher itself stays pure, so this
          // forwarding lives out here. No-op when no tab is open.
          if (event === 'note_applied') forwardNoteAppliedToEditor(data);
        },
      });
    } catch (err) {
      const message = formatStreamError(err);
      patchAssistantMessage(set, conversationId, assistantMsg.id, (m) => ({
        ...m,
        error: message,
      }));
    } finally {
      set((state) => ({
        streamingByConversation: {
          ...state.streamingByConversation,
          [conversationId]: emptyStreaming,
        },
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((m) =>
            m.id === assistantMsg.id ? { ...m, isStreaming: false } : m,
          ),
        },
      }));
      // Refresh the sidebar — the daemon created a new row on first send
      // (ephemeral → persisted) or bumped updated_at on a subsequent send,
      // either way the sidebar order may have changed.
      void get().loadConversations();
    }
  },
}));

// ─── Selectors ─────────────────────────────────────────────────────────

/**
 * Stable reference for the "no active conversation / no messages yet" case.
 * Returning a fresh `[]` inline would give zustand a new snapshot every
 * render — React 19 aborts with "getSnapshot should be cached" + an
 * infinite update loop.
 */
const EMPTY_MESSAGES: ChatMessage[] = [];

export function useActiveConversationMessages(): ChatMessage[] {
  return useAiStore((s) => {
    const id = s.activeConversationId;
    if (!id) return EMPTY_MESSAGES;
    return s.messagesByConversation[id] ?? EMPTY_MESSAGES;
  });
}

export function useIsActiveConversationStreaming(): boolean {
  return useAiStore((s) => {
    const id = s.activeConversationId;
    return id ? (s.streamingByConversation[id]?.isStreaming ?? false) : false;
  });
}

// ─── Internals ─────────────────────────────────────────────────────────

type SetState = (updater: (state: AiState) => Partial<AiState>) => void;

function patchAssistantMessage(
  set: SetState,
  conversationId: string,
  messageId: string,
  patch: (msg: ChatMessage) => ChatMessage,
): void {
  set((state) => ({
    messagesByConversation: {
      ...state.messagesByConversation,
      [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((m) =>
        m.id === messageId ? patch(m) : m,
      ),
    },
  }));
}

function formatStreamError(err: unknown): string {
  if (isSseHttpError(err)) {
    return `daemon ${err.status}: ${err.body || err.statusText}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function isSseHttpError(err: unknown): err is SseHttpError {
  return err instanceof Error && err.name === 'SseHttpError';
}

/**
 * Forward a `note_applied` SSE payload to the editor store for Tier-1
 * auto-merge, then refresh the sibling stores whose cached views just
 * went stale (browser list, folder panel note preview). Silently ignores
 * malformed payloads — the dispatcher has already logged what it could.
 */
function forwardNoteAppliedToEditor(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const payload = data as Record<string, unknown>;
  const noteId = typeof payload.note_id === 'string' ? payload.note_id : null;
  if (!noteId) return;
  const content = typeof payload.content === 'string' ? payload.content : '';
  const appended = typeof payload.appended_text === 'string' ? payload.appended_text : '';
  useEditorStore.getState().applyNoteAppliedFromAi(noteId, content, appended);
  useDataBus.getState().bumpNotes();
}

// ─── Draft approve helpers (P3.0.5 #2) ─────────────────────────────────

type DraftCard = ChatMessage['drafts'][number];
type DraftPatch = Partial<DraftCard>;

function findMessage(
  state: AiState,
  conversationId: string,
  messageId: string,
): ChatMessage | undefined {
  return state.messagesByConversation[conversationId]?.find((m) => m.id === messageId);
}

function findDraft(
  state: AiState,
  conversationId: string,
  messageId: string,
  draftLocalId: string,
): DraftCard | undefined {
  return findMessage(state, conversationId, messageId)?.drafts.find(
    (d) => d.localId === draftLocalId,
  );
}

function patchDraft(
  set: SetState,
  conversationId: string,
  messageId: string,
  draftLocalId: string,
  patch: (d: DraftCard) => DraftPatch,
): void {
  set((state) => ({
    messagesByConversation: {
      ...state.messagesByConversation,
      [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((m) =>
        m.id === messageId
          ? {
              ...m,
              drafts: m.drafts.map((d) => (d.localId === draftLocalId ? { ...d, ...patch(d) } : d)),
            }
          : m,
      ),
    },
  }));
}

/**
 * Apply a draft directly via the daemon REST API. For updates, we run a
 * conflict check first: refetch the note and compare against the draft's
 * `original_*` baselines. If anything's drifted (note edited externally,
 * tags changed elsewhere, etc.) we throw rather than overwrite — that
 * surfaces in the card UI so the user can fall back to the manual
 * "打开" → ConflictDialog flow for explicit resolution.
 */
async function applyDraftViaApi(draft: DraftCard): Promise<void> {
  if (draft.action === 'create' || draft.action === 'create_reminder') {
    await api.createNote({
      content: draft.content,
      folder_id: draft.folder_id ?? undefined,
      tags: draft.tags,
    });
    return;
  }
  if (draft.original_content !== undefined) {
    const current = await api.getNote(draft.note_id);
    const dbContent = current.data?.content ?? '';
    if (dbContent !== draft.original_content) {
      throw new Error('笔记已被外部修改，请改用「打开」手动合并');
    }
  }
  await api.patchNote(draft.note_id, {
    content: draft.content,
    folder_id: draft.folder_id,
    tags: draft.tags,
  });
}

function addNoteAppliedToast(set: SetState, draft: DraftCard): void {
  const notice: NoteAppliedNotice = {
    id: localId(),
    noteId: draft.note_id,
    appendedText: draft.content,
    latestContent: draft.content,
    receivedAt: Date.now(),
  };
  set((state) => ({ noteAppliedNotices: [...state.noteAppliedNotices, notice] }));
}

// ─── History hydration (P3.4-f §5.5) ───────────────────────────────────

/**
 * Fold the daemon's flat LlmMessage[] into GUI ChatMessage[]. Each
 * assistant+tool_calls row starts a new ChatMessage; subsequent tool
 * rows slot into that assistant's `toolCalls[]` via tool_call_id match.
 * Drafts / previews are NOT recoverable (transient UI artifacts) and
 * hydrate as empty arrays. `thinking` is filled from `reasoning_content`.
 */
export function hydrateDaemonMessages(historyMessages: AiHistoryMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of historyMessages) {
    if (m.role === 'user') {
      out.push({
        id: localId(),
        role: 'user',
        content: m.content,
        thinking: '',
        toolCalls: [],
        drafts: [],
        previews: [],
        isStreaming: false,
      });
    } else if (m.role === 'assistant') {
      const toolCalls: ChatToolCall[] = (m.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: safeParseArgs(tc.arguments),
      }));
      out.push({
        id: localId(),
        role: 'assistant',
        content: m.content,
        thinking: m.reasoning_content ?? '',
        toolCalls,
        drafts: [],
        previews: [],
        isStreaming: false,
      });
    } else if (m.role === 'tool') {
      // Slot into the most recent assistant's toolCalls by tool_call_id.
      const assistant = findLastAssistant(out);
      if (!assistant || !m.tool_call_id) continue;
      const call = assistant.toolCalls.find((tc) => tc.id === m.tool_call_id);
      if (!call) continue;
      call.result = safeParseResult(m.content);
      if (m.is_error !== undefined) call.isError = m.is_error;
    }
  }
  return out;
}

function findLastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
  return undefined;
}

function safeParseArgs(raw: string): Record<string, unknown> {
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

function safeParseResult(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
