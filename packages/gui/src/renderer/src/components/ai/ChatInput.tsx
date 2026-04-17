import { useAiStore } from '@/stores/ai-store';
import { Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface ChatInputProps {
  chatId: string;
  isStreaming: boolean;
}

const PLACEHOLDER = '输入消息… (↩ 发送，⇧↩ 换行)';
const ROW_HEIGHT_PX = 24;
const MAX_ROWS = 6;

/**
 * Bottom input bar — a textarea that grows with content (capped at MAX_ROWS),
 * a Send button while idle, and an Abort button while streaming. Plain
 * Enter sends; Shift+Enter inserts a newline.
 */
export function ChatInput({ chatId, isStreaming }: ChatInputProps) {
  const sendMessage = useAiStore((s) => s.sendMessage);
  const abortStreaming = useAiStore((s) => s.abortStreaming);

  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setText('');
    void sendMessage(chatId, trimmed);
  }, [text, isStreaming, sendMessage, chatId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Chat-style: bare Enter sends, Shift+Enter falls through to the
      // textarea's default newline behaviour for multi-line drafts. The
      // meta-key combos (⌘↩ / Ctrl↩) also send so muscle memory holds.
      // Suppress during IME composition so Chinese/Japanese input
      // candidate confirmations don't trigger a premature send.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  // Keep focus on the textarea at the points where the user is about
  // to type: first mount, tab switch (chatId change), and right after
  // a stream ends (`disabled={isStreaming}` blurs the textarea, so we
  // have to explicitly put focus back when it re-enables).
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the tab-switch trigger
  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [chatId, isStreaming]);

  // Auto-resize: clear inline height first so scrollHeight reflects content.
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    const cap = ROW_HEIGHT_PX * MAX_ROWS;
    ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
  }, []);

  return (
    <div className="border-t border-border bg-background p-3 shrink-0">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDER}
          rows={1}
          className="flex-1 resize-none bg-muted/40 text-sm rounded-md px-3 py-2 border border-border focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={() => abortStreaming(chatId)}
            className="inline-flex items-center justify-center size-9 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20"
            title="停止生成"
          >
            <Square className="size-4" fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!text.trim()}
            className="inline-flex items-center justify-center size-9 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
            title="发送 (↩)"
          >
            <Send className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
