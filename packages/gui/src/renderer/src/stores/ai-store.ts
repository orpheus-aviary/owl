import * as api from '@/lib/api';
import { baseUrl } from '@/lib/api';
import { type SseHttpError, streamSse } from '@/lib/sse-client';
import { create } from 'zustand';

/**
 * Chat state for the AI page. One `ChatTabState` per tab in the chat
 * tab bar; each maps to a single backend conversation_id (filled in by
 * the first SSE event from /ai/chat).
 *
 * The store is intentionally split into types + skeleton actions in
 * Step 2; the SSE event dispatcher (Step 3) and Tier-1 / draft handoff
 * (Steps 4-7) layer on top of `sendMessage` without changing the shape.
 */

// ─── Public types ──────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant';

export interface ChatToolCall {
  id: string; // server tool_call_id
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

export interface DraftReadyCard {
  /** Local random id — used as React key only. */
  localId: string;
  action: 'create' | 'update' | 'create_reminder';
  note_id: string;
  content: string;
  tags: string[];
  folder_id: string | null;
  original_content?: string;
  original_tags?: string[];
  original_folder_id?: string | null;
  /** Cleared once the user clicks "open" so the card UI can show "已打开". */
  opened: boolean;
}

export interface PreviewReadyCard {
  localId: string;
  preview_id: string;
  action: string;
  diff: string;
  content: string;
  tags: string[];
  folder_id: string | null;
}

export interface ChatMessage {
  /** Local id — used as React key only. */
  id: string;
  role: ChatRole;
  /** Streaming text accumulated from `message` events. */
  content: string;
  toolCalls: ChatToolCall[];
  drafts: DraftReadyCard[];
  previews: PreviewReadyCard[];
  /** True while the assistant message is still receiving deltas. */
  isStreaming: boolean;
  /** Populated by an `error` SSE event. Mutually exclusive with content/toolCalls. */
  error?: string;
}

export interface ChatTabState {
  /** Local id used in React keys + active-tab tracking. Stable across renames. */
  id: string;
  /** Server-issued conversation id; null until the first `conversation_id` SSE event. */
  conversationId: string | null;
  /** Display title — first user message truncated; '新对话' until then. */
  title: string;
  messages: ChatMessage[];
  /** AbortController for the in-flight request, null when idle. */
  abortController: AbortController | null;
  isStreaming: boolean;
}

interface AiState {
  chats: ChatTabState[];
  activeChatId: string | null;

  newChat: () => string;
  closeChat: (id: string) => Promise<void>;
  setActiveChat: (id: string) => void;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  abortStreaming: (chatId: string) => void;
}

// ─── Implementation ────────────────────────────────────────────────────

const TITLE_MAX = 32;

function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '新对话';
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX)}…` : collapsed;
}

function localId(): string {
  return crypto.randomUUID();
}

export const useAiStore = create<AiState>((set, get) => ({
  chats: [],
  activeChatId: null,

  newChat: () => {
    const id = localId();
    const tab: ChatTabState = {
      id,
      conversationId: null,
      title: '新对话',
      messages: [],
      abortController: null,
      isStreaming: false,
    };
    set((state) => ({ chats: [...state.chats, tab], activeChatId: id }));
    return id;
  },

  setActiveChat: (id) => {
    set({ activeChatId: id });
  },

  abortStreaming: (chatId) => {
    const tab = get().chats.find((c) => c.id === chatId);
    tab?.abortController?.abort();
  },

  closeChat: async (id) => {
    const tab = get().chats.find((c) => c.id === id);
    if (!tab) return;

    // 1. Abort any in-flight stream so the daemon stops writing and our
    //    local state machine settles before we delete the conversation.
    tab.abortController?.abort();

    // 2. Wait for the abort to propagate. streamSse returns cleanly on
    //    abort, so isStreaming should flip to false within a tick.
    await waitForIdle(get, id);

    // 3. Delete the server-side conversation if we ever got an id back.
    if (tab.conversationId) {
      try {
        await api.deleteAiConversation(tab.conversationId);
      } catch {
        // Best-effort — daemon may have restarted. Either way we still
        // remove the local tab so the UI doesn't hang on this entry.
      }
    }

    // 4. Drop the tab; if it was active, hand focus to the previous one.
    set((state) => {
      const index = state.chats.findIndex((c) => c.id === id);
      const remaining = state.chats.filter((c) => c.id !== id);
      let nextActive = state.activeChatId;
      if (state.activeChatId === id) {
        if (remaining.length === 0) {
          nextActive = null;
        } else if (index >= remaining.length) {
          nextActive = remaining[remaining.length - 1].id;
        } else {
          nextActive = remaining[index].id;
        }
      }
      return { chats: remaining, activeChatId: nextActive };
    });
  },

  /**
   * Fire a user message at the daemon. Step 2 implements the request
   * shape, optimistic message insertion, and streaming flag bookkeeping.
   * The SSE *event dispatcher* (Step 3) replaces the inline `onEvent`
   * stub — full draft/tool/note_applied handling lands then.
   */
  sendMessage: async (chatId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const tab = get().chats.find((c) => c.id === chatId);
    if (!tab || tab.isStreaming) return;

    const userMsg: ChatMessage = {
      id: localId(),
      role: 'user',
      content: trimmed,
      toolCalls: [],
      drafts: [],
      previews: [],
      isStreaming: false,
    };
    const assistantMsg: ChatMessage = {
      id: localId(),
      role: 'assistant',
      content: '',
      toolCalls: [],
      drafts: [],
      previews: [],
      isStreaming: true,
    };
    const controller = new AbortController();

    set((state) => ({
      chats: state.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              messages: [...c.messages, userMsg, assistantMsg],
              title: c.title === '新对话' ? titleFrom(trimmed) : c.title,
              abortController: controller,
              isStreaming: true,
            }
          : c,
      ),
    }));

    try {
      await streamSse({
        url: `${baseUrl()}/ai/chat`,
        body: { message: trimmed, conversation_id: tab.conversationId ?? undefined },
        signal: controller.signal,
        onEvent: (event, data) => {
          // STEP 3 will replace this stub with the full dispatcher. For
          // now we only handle the two events the rest of the system
          // already needs: conversation_id (so closeChat can delete the
          // server conversation) and message (so the user sees text).
          if (
            event === 'conversation_id' &&
            isObject(data) &&
            typeof data.conversation_id === 'string'
          ) {
            patchTab(set, chatId, (c) => ({
              ...c,
              conversationId: data.conversation_id as string,
            }));
          } else if (event === 'message' && isObject(data) && typeof data.content === 'string') {
            appendAssistantText(set, chatId, assistantMsg.id, data.content);
          }
        },
      });
    } catch (err) {
      const message = formatStreamError(err);
      patchAssistantMessage(set, chatId, assistantMsg.id, (m) => ({ ...m, error: message }));
    } finally {
      patchTab(set, chatId, (c) => ({
        ...c,
        abortController: null,
        isStreaming: false,
        messages: c.messages.map((m) =>
          m.id === assistantMsg.id ? { ...m, isStreaming: false } : m,
        ),
      }));
    }
  },
}));

// ─── Selectors ─────────────────────────────────────────────────────────

export function useActiveChat(): ChatTabState | null {
  return useAiStore((s) => s.chats.find((c) => c.id === s.activeChatId) ?? null);
}

// ─── Internals ─────────────────────────────────────────────────────────

type SetState = (updater: (state: AiState) => Partial<AiState>) => void;

function patchTab(set: SetState, chatId: string, patch: (tab: ChatTabState) => ChatTabState): void {
  set((state) => ({
    chats: state.chats.map((c) => (c.id === chatId ? patch(c) : c)),
  }));
}

function patchAssistantMessage(
  set: SetState,
  chatId: string,
  messageId: string,
  patch: (msg: ChatMessage) => ChatMessage,
): void {
  set((state) => ({
    chats: state.chats.map((c) =>
      c.id === chatId
        ? {
            ...c,
            messages: c.messages.map((m) => (m.id === messageId ? patch(m) : m)),
          }
        : c,
    ),
  }));
}

function appendAssistantText(
  set: SetState,
  chatId: string,
  messageId: string,
  delta: string,
): void {
  patchAssistantMessage(set, chatId, messageId, (m) => ({ ...m, content: m.content + delta }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Spin-wait for the tab's `isStreaming` flag to drop. We check inline
 * (no setTimeout(0) tricks) because streamSse exits synchronously after
 * the abort signal is observed during a `read()` await, and the finally
 * block runs in the next microtask. A handful of microtask yields is
 * enough; cap at ~50ms so a wedged stream doesn't hang `closeChat`.
 */
async function waitForIdle(get: () => AiState, chatId: string): Promise<void> {
  const deadline = Date.now() + 50;
  while (Date.now() < deadline) {
    const tab = get().chats.find((c) => c.id === chatId);
    if (!tab || !tab.isStreaming) return;
    await Promise.resolve(); // yield microtask
  }
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
