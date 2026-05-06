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
  /** Flipped to true after a successful Tier-1 auto-merge ("同意"). */
  approved: boolean;
  /** True while an approve API call is in flight — disables the buttons. */
  approving: boolean;
  /**
   * Surface-level error from a failed approve. Used to render a red
   * indicator + retry button on the card; null when there's no error.
   * Conflict detection (note edited externally since the AI drafted) lands
   * here too so the user sees why the auto-merge was held back.
   */
  error: string | null;
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
  /**
   * Reasoning / chain-of-thought text from `thinking` events. Rendered as a
   * collapsible block above the bubble's main content. Empty when the model
   * doesn't emit thinking (e.g. plain `gpt-4o-mini` chat completions).
   * P3.4-f: also hydrated from daemon `reasoning_content` on history load.
   */
  thinking: string;
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

/**
 * Sidebar row — meta only, shipped by GET /ai/conversations. Messages are
 * fetched lazily via GET /ai/conversations/:id (see ai-store's
 * `messagesByConversation` cache).
 */
export interface ConversationMeta {
  id: string;
  title: string;
  /** Unix ms (P3.4-a convention). */
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Per-conversation streaming bookkeeping. Kept alive across
 * `setActiveConversation` so a user can switch away during a long
 * response and return to find it still filling in — see P3.4-f §5.4.
 */
export interface StreamingState {
  isStreaming: boolean;
  abortController: AbortController | null;
  /** Id of the assistant ChatMessage being streamed (for dispatcher patches). */
  assistantMessageId: string | null;
}
