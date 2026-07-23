import { ChatInput } from '@/components/ai/ChatInput';
import { ChatSidebar } from '@/components/ai/ChatSidebar';
import { MessageList } from '@/components/ai/MessageList';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useOwlLayout } from '@/hooks/useOwlLayout';
import { LAYOUT_KEYS } from '@/lib/layout-keys';
import {
  useActiveConversationMessages,
  useAiStore,
  useIsActiveConversationStreaming,
} from '@/stores/ai-store';
import { Bot, PanelLeft, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Group, Panel } from 'react-resizable-panels';

/**
 * AI chat page (P3.4-f): left ChatSidebar + right (MessageList + ChatInput)
 * driven by react-resizable-panels. Sidebar hydrates from daemon on mount.
 * Empty state prompts the user to create a new conversation — we do NOT
 * auto-create on mount so the sidebar stays clean until the user actually
 * wants to chat.
 *
 * Mobile web (§4.4) drops the resizable split: the chat goes full-screen and
 * the conversation list moves into a left Sheet reached from an in-page header.
 */
export function AIPage() {
  const isMobile = useIsMobile();
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

  const chatPane = activeConversationId ? (
    <>
      <MessageList messages={messages} conversationId={activeConversationId} />
      <ChatInput conversationId={activeConversationId} isStreaming={isStreaming} />
    </>
  ) : (
    <EmptyState onNew={() => newConversation()} />
  );

  if (isMobile) return <MobileAIPage onNew={() => newConversation()}>{chatPane}</MobileAIPage>;

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
        {chatPane}
      </Panel>
    </Group>
  );
}

/**
 * Mobile chat shell: a full-height column with an in-page header (list toggle +
 * active title + 新建对话) over the chat pane; the conversation list lives in a
 * left Sheet that closes as soon as a row is tapped (`onAfterSelect`).
 */
function MobileAIPage({ onNew, children }: { onNew: () => void; children: React.ReactNode }) {
  const [listOpen, setListOpen] = useState(false);
  const title = useAiStore(
    (s) => s.conversations.find((c) => c.id === s.activeConversationId)?.title,
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 flex items-center gap-1 h-11 px-2 border-b border-border">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setListOpen(true)}
          aria-label="对话列表"
        >
          <PanelLeft className="size-5" />
        </Button>
        <span className="flex-1 truncate text-sm font-medium">{title ?? 'AI 对话'}</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onNew}
          aria-label="新建对话"
        >
          <Plus className="size-5" />
        </Button>
      </header>
      <div className="flex flex-1 min-h-0 flex-col">{children}</div>

      <Sheet open={listOpen} onOpenChange={setListOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-3/4 max-w-sm gap-0 p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>对话列表</SheetTitle>
          </SheetHeader>
          <ChatSidebar onAfterSelect={() => setListOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
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
