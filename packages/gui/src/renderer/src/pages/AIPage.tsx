import { ChatInput } from '@/components/ai/ChatInput';
import { ChatTabBar } from '@/components/ai/ChatTabBar';
import { MessageList } from '@/components/ai/MessageList';
import { useActiveChat, useAiStore } from '@/stores/ai-store';
import { Bot } from 'lucide-react';
import { useEffect } from 'react';

/**
 * AI chat page. Layout: ChatTabBar (top) / MessageList (middle) /
 * ChatInput (bottom). Auto-creates an initial chat the first time the
 * page mounts so the user lands on a usable surface; subsequent visits
 * preserve whatever tabs are already open.
 *
 * Step 4 lays down the shell and streaming text path. ToolCallBlock /
 * DraftReadyCard / NoteAppliedToast / ConflictDialog hang off the
 * existing data shape in steps 5-9 without touching this file.
 */
export function AIPage() {
  const chats = useAiStore((s) => s.chats);
  const newChat = useAiStore((s) => s.newChat);
  const activeChat = useActiveChat();

  useEffect(() => {
    if (chats.length === 0) newChat();
  }, [chats.length, newChat]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ChatTabBar />
      {activeChat ? (
        <>
          <MessageList messages={activeChat.messages} />
          <ChatInput chatId={activeChat.id} isStreaming={activeChat.isStreaming} />
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}

function EmptyState() {
  const newChat = useAiStore((s) => s.newChat);
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <Bot className="size-10" />
      <p className="text-sm">还没有对话。</p>
      <button
        type="button"
        onClick={() => newChat()}
        className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
      >
        新建对话
      </button>
    </div>
  );
}
