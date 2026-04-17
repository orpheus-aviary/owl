/**
 * Pure type definitions for the AI chat. Extracted into its own file so
 * the dispatcher (`ai-dispatcher.ts`) and the zustand store
 * (`ai-store.ts`) can both import without producing a circular runtime
 * dependency.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatToolCall {
  /** Server-issued tool_call_id; matches the corresponding tool_result. */
  id: string;
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
  /** DB baselines from the daemon (update action only). */
  original_content?: string;
  original_tags?: string[];
  original_folder_id?: string | null;
  /** Flipped to true once the user clicks "open". */
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
  /** Populated by an `error` SSE event. */
  error?: string;
  /** Set to true when the user clicked Stop to cut off generation. */
  aborted?: boolean;
}

export interface ChatTabState {
  /** Local id used in React keys + active-tab tracking. Stable across renames. */
  id: string;
  /** Server-issued conversation id; null until the first `conversation_id` SSE event. */
  conversationId: string | null;
  /** Display title — first user message truncated; '新对话' until then. */
  title: string;
  messages: ChatMessage[];
  /** AbortController for the in-flight request; null when idle. */
  abortController: AbortController | null;
  isStreaming: boolean;
}
