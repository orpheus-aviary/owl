import { useAiStore } from '@/stores/ai-store';
import { Plus, X } from 'lucide-react';
import { useCallback } from 'react';

/**
 * Chat tab strip — mirrors `components/TabBar.tsx` for the editor so the
 * two pages feel like the same app. Differences:
 *  - "+" button at the right end opens a brand-new chat tab.
 *  - Streaming indicator (pulsing dot) replaces the editor's "dirty dot".
 *  - Closing a tab funnels through `closeChat` so the abort → DELETE
 *    sequence in the store runs (see ai-store.ts:closeChat).
 */
export function ChatTabBar() {
  const chats = useAiStore((s) => s.chats);
  const activeChatId = useAiStore((s) => s.activeChatId);
  const setActiveChat = useAiStore((s) => s.setActiveChat);
  const closeChat = useAiStore((s) => s.closeChat);
  const newChat = useAiStore((s) => s.newChat);

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, chatId: string) => {
      if (e.button === 1) {
        e.preventDefault();
        void closeChat(chatId);
      }
    },
    [closeChat],
  );

  return (
    <div className="flex items-center border-b border-border bg-background overflow-x-auto shrink-0">
      {chats.map((tab) => {
        const isActive = tab.id === activeChatId;
        // Wrapper is a div so the close button can nest inside without
        // triggering React's "button in button" hydration error.
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            onClick={() => setActiveChat(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveChat(tab.id);
              }
            }}
            onMouseDown={(e) => handleMiddleClick(e, tab.id)}
            className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border shrink-0 max-w-48 transition-colors cursor-pointer select-none ${
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            <span className="truncate">{tab.title}</span>
            {tab.isStreaming && (
              <span
                className="size-1.5 rounded-full bg-blue-400 shrink-0 animate-pulse"
                title="生成中"
              />
            )}
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                void closeChat(tab.id);
              }}
              className="ml-auto opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5 shrink-0"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => newChat()}
        className="px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 shrink-0"
        title="新对话"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
