import { useEditorStore } from '@/stores/editor-store';
import { X } from 'lucide-react';
import { useCallback } from 'react';

interface TabBarProps {
  onCloseTab: (noteId: string) => void;
}

export function TabBar({ onCloseTab }: TabBarProps) {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, noteId: string) => {
      if (e.button === 1) {
        e.preventDefault();
        onCloseTab(noteId);
      }
    },
    [onCloseTab],
  );

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center border-b border-border bg-background overflow-x-auto shrink-0">
      {tabs.map((tab) => {
        const isActive = tab.noteId === activeTabId;
        // Outer wrapper is a div — not a button — because it hosts the
        // inner close-button, and nested <button>s break hydration. We
        // still expose it as a tab role with keyboard activation so the
        // click target stays accessible.
        return (
          <div
            key={tab.noteId}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            onClick={() => setActiveTab(tab.noteId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveTab(tab.noteId);
              }
            }}
            onMouseDown={(e) => handleMiddleClick(e, tab.noteId)}
            className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border shrink-0 max-w-48 transition-colors cursor-pointer select-none ${
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
            }`}
          >
            <span className="truncate">{tab.title}</span>
            {tab.dirty && (
              <span className="size-1.5 rounded-full bg-blue-400 shrink-0" title="未保存" />
            )}
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.noteId);
              }}
              className="ml-auto opacity-0 group-hover:opacity-100 hover:bg-muted rounded p-0.5 shrink-0"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
