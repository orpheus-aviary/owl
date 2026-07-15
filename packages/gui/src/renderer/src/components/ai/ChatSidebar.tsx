import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useAiStore } from '@/stores/ai-store';
import type { ConversationMeta } from '@/stores/ai-store';
import { MessageSquare, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Claude-desktop-style sidebar for AI chat (P3.4-f).
 *
 * Top bar: "新建对话" button + client-side title filter.
 * Scrolling list: each row = ConversationMeta + active/streaming indicators.
 * Right-click a row → confirm dialog → delete.
 *
 * Keyboard: container `tabIndex={0}` + ArrowUp/Down walks the visible list
 * and `setActiveConversation` for each step. Search input keeps its native
 * arrow behaviour (tag-guarded).
 */

/** The conversation id one step (`direction` = ±1) from the active one in the filtered list. */
function nextConversationId(
  filtered: ConversationMeta[],
  activeId: string | null,
  direction: number,
): string | undefined {
  const anchorIdx = activeId ? filtered.findIndex((c) => c.id === activeId) : -1;
  const nextIdx =
    anchorIdx === -1 ? 0 : Math.min(Math.max(anchorIdx + direction, 0), filtered.length - 1);
  return filtered[nextIdx]?.id;
}

export function ChatSidebar() {
  const conversations = useAiStore((s) => s.conversations);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const streamingByConversation = useAiStore((s) => s.streamingByConversation);
  const setActiveConversation = useAiStore((s) => s.setActiveConversation);
  const newConversation = useAiStore((s) => s.newConversation);
  const deleteConversation = useAiStore((s) => s.deleteConversation);

  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ConversationMeta | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const handleNew = useCallback(() => {
    newConversation();
  }, [newConversation]);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    await deleteConversation(id);
  }, [pendingDelete, deleteConversation]);

  // ArrowUp / ArrowDown navigate the filtered list; tagName guard keeps
  // the search input's native cursor behaviour.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (filtered.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const nextId = nextConversationId(
        filtered,
        activeConversationId,
        e.key === 'ArrowDown' ? 1 : -1,
      );
      if (nextId) setActiveConversation(nextId);
    },
    [filtered, activeConversationId, setActiveConversation],
  );

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0 border-r border-border">
      {/* Header: new + search */}
      <div className="flex items-center gap-1 p-2 border-b border-border">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 size-8"
          onClick={handleNew}
          title="新建对话"
        >
          <Plus className="size-4" />
        </Button>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder="搜索对话..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* List container — single keyboard entry point */}
      <div
        ref={listContainerRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: container is the sole keyboard entry point (P3.4-f §6.1)
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex-1 min-h-0 outline-none"
      >
        <ScrollArea className="h-full">
          <div>
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {query ? '无匹配对话' : '暂无对话'}
              </div>
            ) : (
              filtered.map((c) => (
                <ConversationRow
                  key={c.id}
                  meta={c}
                  isActive={c.id === activeConversationId}
                  isStreaming={streamingByConversation[c.id]?.isStreaming ?? false}
                  onSelect={() => setActiveConversation(c.id)}
                  onRequestDelete={() => setPendingDelete(c)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除对话？</DialogTitle>
            <DialogDescription>
              「{pendingDelete?.title ?? ''}」将被永久删除，无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ConversationRowProps {
  meta: ConversationMeta;
  isActive: boolean;
  isStreaming: boolean;
  onSelect: () => void;
  onRequestDelete: () => void;
}

function ConversationRow({
  meta,
  isActive,
  isStreaming,
  onSelect,
  onRequestDelete,
}: ConversationRowProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-conversation-id={meta.id}
          // biome-ignore lint/a11y/useSemanticElements: nested <button> inside ContextMenuTrigger breaks hydration
          role="button"
          tabIndex={-1}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect();
            }
          }}
          className={cn(
            'w-full text-left px-3 py-2 border-b border-border transition-colors outline-none cursor-pointer select-none',
            'hover:bg-accent/50',
            isActive && 'bg-accent border-l-2 border-l-primary',
          )}
        >
          <div className="flex items-center gap-2">
            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{meta.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {formatRelativeTime(meta.updatedAt)}
              </div>
            </div>
            {isStreaming && (
              <span
                className="size-1.5 rounded-full bg-blue-400 shrink-0 animate-pulse"
                title="生成中"
              />
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={onRequestDelete}>
          <Trash2 className="size-3.5" />
          删除对话
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Small relative-time formatter — no locale switching, just enough for
// the common sidebar cases. Falls through to an absolute date for anything
// older than a week.
function formatRelativeTime(ms: number): string {
  const diffSec = Math.max(0, (Date.now() - ms) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} 天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
