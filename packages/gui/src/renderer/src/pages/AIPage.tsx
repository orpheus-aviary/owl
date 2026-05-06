import { ChatInput } from '@/components/ai/ChatInput';
import { ChatSidebar } from '@/components/ai/ChatSidebar';
import { MessageList } from '@/components/ai/MessageList';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { useOwlLayout } from '@/hooks/useOwlLayout';
import { LAYOUT_KEYS } from '@/lib/layout-keys';
import {
  useActiveConversationMessages,
  useAiStore,
  useIsActiveConversationStreaming,
} from '@/stores/ai-store';
import { Bot } from 'lucide-react';
import { useEffect } from 'react';
import { Group, Panel } from 'react-resizable-panels';

/**
 * AI chat page (P3.4-f): left ChatSidebar + right (MessageList + ChatInput)
 * driven by react-resizable-panels. Sidebar hydrates from daemon on mount.
 * Empty state prompts the user to create a new conversation — we do NOT
 * auto-create on mount so the sidebar stays clean until the user actually
 * wants to chat.
 */
export function AIPage() {
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const conversationsLoaded = useAiStore((s) => s.conversationsLoaded);
  const loadConversations = useAiStore((s) => s.loadConversations);
  const loadConversation = useAiStore((s) => s.loadConversation);
  const newConversation = useAiStore((s) => s.newConversation);
  const messages = useActiveConversationMessages();
  const isStreaming = useIsActiveConversationStreaming();

  const layout = useOwlLayout(LAYOUT_KEYS.aiLayout);

  useEffect(() => {
    if (!conversationsLoaded) void loadConversations();
  }, [conversationsLoaded, loadConversations]);

  // Hydrate messages for whatever conversation becomes active. `loadConversation`
  // is a no-op when messages are already cached (live send, previous fetch).
  useEffect(() => {
    if (activeConversationId) void loadConversation(activeConversationId);
  }, [activeConversationId, loadConversation]);

  return (
    <Group
      orientation="horizontal"
      id={LAYOUT_KEYS.aiLayout}
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      className="flex h-full min-h-0"
    >
      <Panel
        id="chat-sidebar"
        defaultSize="22%"
        minSize="160px"
        className="h-full w-full min-h-0 min-w-0"
      >
        <ChatSidebar />
      </Panel>
      <ResizeHandle />
      <Panel
        id="chat-main"
        defaultSize="78%"
        minSize="400px"
        className="flex h-full w-full min-h-0 min-w-0 flex-col"
      >
        {activeConversationId ? (
          <>
            <MessageList messages={messages} conversationId={activeConversationId} />
            <ChatInput conversationId={activeConversationId} isStreaming={isStreaming} />
          </>
        ) : (
          <EmptyState onNew={() => newConversation()} />
        )}
      </Panel>
    </Group>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <Bot className="size-10" />
      <p className="text-sm">还没有选中对话。</p>
      <button
        type="button"
        onClick={onNew}
        className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
      >
        新建对话
      </button>
    </div>
  );
}
