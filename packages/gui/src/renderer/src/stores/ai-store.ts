import * as api from '@/lib/api';
import { baseUrl } from '@/lib/api';
import { type SseHttpError, streamSse } from '@/lib/sse-client';
import { create } from 'zustand';
import { type NoteAppliedNotice, dispatchAgentEvent } from './ai-dispatcher';
import type { ChatMessage, ChatTabState } from './ai-store-types';
import { useEditorStore } from './editor-store';
import { useFolderStore } from './folder-store';
import { useNoteStore } from './note-store';

export type {
  ChatRole,
  ChatToolCall,
  DraftReadyCard,
  PreviewReadyCard,
  ChatMessage,
  ChatTabState,
} from './ai-store-types';
export type { NoteAppliedNotice } from './ai-dispatcher';

/**
 * Chat state for the AI page. One `ChatTabState` per tab in the chat
 * tab bar; each maps to a single backend conversation_id (filled in by
 * the first SSE event from /ai/chat).
 *
 * Step 3 fully wires the SSE event dispatcher (`ai-dispatcher.ts`).
 * Side-effects beyond the chat state itself (Tier-1 editor merge,
 * draft handoff to the editor) layer on in Steps 6-7 by reading the
 * dispatched state — no more changes to this file are needed for them.
 */

interface AiState {
  chats: ChatTabState[];
  activeChatId: string | null;
  /** Toast queue consumed by `<NoteAppliedToast>` (Step 6). */
  noteAppliedNotices: NoteAppliedNotice[];
  /**
   * Per-chat MessageList scroll position, preserved across page
   * navigations so switching away from /ai and back doesn't reset the
   * user to the top of the history.
   */
  scrollByChatId: Record<string, number>;

  newChat: () => string;
  closeChat: (id: string) => Promise<void>;
  setActiveChat: (id: string) => void;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  abortStreaming: (chatId: string) => void;
  /** Drop a notice from the queue once its toast has been dismissed. */
  dismissNoteAppliedNotice: (noticeId: string) => void;
  /**
   * Flip a DraftReadyCard's `opened` flag so the card's "打开" button
   * becomes "已打开". Called after the editor accepts the draft.
   */
  markDraftOpened: (chatId: string, messageId: string, draftLocalId: string) => void;
  /** Record the message list's current scrollTop for a given chat. */
  setChatScroll: (chatId: string, scrollTop: number) => void;
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

export const useAiStore = create<AiState>((set, get) => ({
  chats: [],
  activeChatId: null,
  noteAppliedNotices: [],
  scrollByChatId: {},

  setChatScroll: (chatId, scrollTop) => {
    set((state) => ({
      scrollByChatId: { ...state.scrollByChatId, [chatId]: scrollTop },
    }));
  },

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
    if (!tab) return;
    // Tag the in-flight assistant message so the bubble can render a
    // subtle "已停止生成" hint and distinguish user-abort from an
    // actual `error` event.
    set((state) => ({
      chats: state.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.role === 'assistant' && m.isStreaming ? { ...m, aborted: true } : m,
              ),
            }
          : c,
      ),
    }));
    tab.abortController?.abort();
  },

  dismissNoteAppliedNotice: (noticeId) => {
    set((state) => ({
      noteAppliedNotices: state.noteAppliedNotices.filter((n) => n.id !== noticeId),
    }));
  },

  markDraftOpened: (chatId, messageId, draftLocalId) => {
    set((state) => ({
      chats: state.chats.map((c) =>
        c.id === chatId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      drafts: m.drafts.map((d) =>
                        d.localId === draftLocalId ? { ...d, opened: true } : d,
                      ),
                    }
                  : m,
              ),
            }
          : c,
      ),
    }));
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
          set((state) =>
            dispatchAgentEvent({
              state: { chats: state.chats, noteAppliedNotices: state.noteAppliedNotices },
              chatId,
              assistantMessageId: assistantMsg.id,
              event,
              data,
              newLocalId: localId,
            }),
          );
          // Tier-1 side-effect: push the DB-reconciled content into any
          // open editor tab. The dispatcher itself stays pure, so this
          // forwarding lives out here. No-op when no tab is open.
          if (event === 'note_applied') forwardNoteAppliedToEditor(data);
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
  // Fire-and-forget refreshes so the browser list / folder panel reflect
  // the append without the user having to navigate away and back.
  void useNoteStore.getState().fetchNotes();
  void useFolderStore.getState().fetchPanelNotes();
}
