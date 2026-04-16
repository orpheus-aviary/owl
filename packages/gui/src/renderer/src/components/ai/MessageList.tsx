import type { ChatMessage } from '@/stores/ai-store';
import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: ChatMessage[];
}

/**
 * Scrollable list of messages with sticky-bottom behaviour: auto-scroll
 * follows new content as long as the user is already near the bottom.
 * If they've scrolled up to read history we leave them alone — the chat
 * input still works without yanking them back to the latest message.
 */
const STICKY_THRESHOLD_PX = 120;

export function MessageList({ messages }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < STICKY_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  });

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        发条消息开始对话。
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
    </div>
  );
}
