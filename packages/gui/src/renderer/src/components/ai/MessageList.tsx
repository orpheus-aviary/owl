import { type ChatMessage, useAiStore } from '@/stores/ai-store';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: ChatMessage[];
  conversationId: string;
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
 *     per-conversation so switching back drops the user where they left off.
 */
const STICKY_THRESHOLD_PX = 40;

export function MessageList({ messages, conversationId }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const didMountRef = useRef(false);

  const setConversationScroll = useAiStore((s) => s.setConversationScroll);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const saved = useAiStore.getState().scrollByConversation[conversationId];
    if (saved !== undefined) {
      el.scrollTop = saved;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      atBottomRef.current = distance < STICKY_THRESHOLD_PX;
    } else {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
    }
    didMountRef.current = false;
  }, [conversationId]);

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
    setConversationScroll(conversationId, el.scrollTop);
  }, [conversationId, setConversationScroll]);

  useEffect(() => {
    return () => {
      const el = containerRef.current;
      if (el) setConversationScroll(conversationId, el.scrollTop);
    };
  }, [conversationId, setConversationScroll]);

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
        <MessageBubble key={m.id} message={m} conversationId={conversationId} />
      ))}
    </div>
  );
}

function messageSignature(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.id}:${m.content.length}:${m.toolCalls.length}:${m.drafts.length}`)
    .join('|');
}
