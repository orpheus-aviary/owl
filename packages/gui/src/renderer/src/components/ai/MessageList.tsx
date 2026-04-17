import { type ChatMessage, useAiStore } from '@/stores/ai-store';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: ChatMessage[];
  chatId: string;
}

/**
 * Message list with two scroll behaviours:
 *
 *  1. **Sticky bottom** — if the user's already near the bottom when new
 *     content arrives (streaming deltas, tool calls, drafts), follow it.
 *     If they scrolled up to read history we leave their position alone.
 *
 *  2. **Restore on tab-return** — AIPage unmounts when the user navigates
 *     to another page. We persist the container's scrollTop in `ai-store`
 *     per-chat so switching back drops the user where they left off.
 */
const STICKY_THRESHOLD_PX = 40;

export function MessageList({ messages, chatId }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** True while the viewport is pinned to (or very close to) the bottom. */
  const atBottomRef = useRef(true);
  /** Guards the sticky effect against the initial mount — restore wins. */
  const didMountRef = useRef(false);

  const setChatScroll = useAiStore((s) => s.setChatScroll);

  // Restore saved scrollTop (or default to bottom) once per chatId.
  // useLayoutEffect to avoid a visible flash of scroll=0 before paint.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const saved = useAiStore.getState().scrollByChatId[chatId];
    if (saved !== undefined) {
      el.scrollTop = saved;
      // Re-derive sticky state from the restored position so the next
      // delta either follows or leaves them alone based on where they
      // actually are, not what they were doing before navigating.
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      atBottomRef.current = distance < STICKY_THRESHOLD_PX;
    } else {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
    }
    // Mount-restore always takes precedence over the sticky effect on
    // the very first render for this chat.
    didMountRef.current = false;
  }, [chatId]);

  // Sticky auto-scroll: fire whenever message contents change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stringify only for change detection
  useLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, messageSignature(messages)]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < STICKY_THRESHOLD_PX;
    setChatScroll(chatId, el.scrollTop);
  }, [chatId, setChatScroll]);

  // Persist scrollTop one more time on unmount so a fast page-switch
  // while the user is actively scrolling doesn't lose the final position.
  useEffect(() => {
    return () => {
      const el = containerRef.current;
      if (el) setChatScroll(chatId, el.scrollTop);
    };
  }, [chatId, setChatScroll]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        发条消息开始对话。
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0"
    >
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} chatId={chatId} />
      ))}
    </div>
  );
}

/**
 * Coarse change-signature for messages. Length alone misses streaming
 * deltas (same message id, growing content); a hash of per-message
 * content lengths + toolCall/draft counts catches every render-visible
 * mutation without deep-equal costs.
 */
function messageSignature(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.id}:${m.content.length}:${m.toolCalls.length}:${m.drafts.length}`)
    .join('|');
}
