import { MarkdownEditor } from '@/components/MarkdownEditor';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { type EditorMode, useActiveTab, useEditorStore } from '@/stores/editor-store';
import { Columns2, Eye, Pencil } from 'lucide-react';

const MODE_ICONS: Record<EditorMode, typeof Pencil> = {
  edit: Pencil,
  split: Columns2,
  preview: Eye,
};

const MODE_LABELS: Record<EditorMode, string> = {
  edit: '编辑',
  split: '分屏',
  preview: '预览',
};

function ModeToggle() {
  const mode = useEditorStore((s) => s.mode);
  const cycleMode = useEditorStore((s) => s.cycleMode);
  const Icon = MODE_ICONS[mode];

  return (
    <button
      type="button"
      onClick={cycleMode}
      className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-accent"
      title={`当前：${MODE_LABELS[mode]}（点击切换）`}
    >
      <Icon className="size-3.5" />
      <span>{MODE_LABELS[mode]}</span>
    </button>
  );
}

export function EditorPanel() {
  const tab = useActiveTab();
  const mode = useEditorStore((s) => s.mode);
  const updateContent = useEditorStore((s) => s.updateContent);

  if (!tab) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">选择或新建笔记</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-end px-2 py-1 border-b border-border shrink-0">
        <ModeToggle />
      </div>

      {/* Content area */}
      <div className="flex-1 flex min-h-0">
        {mode === 'edit' && (
          <div className="flex-1 min-h-0">
            <MarkdownEditor value={tab.content} onChange={(v) => updateContent(tab.noteId, v)} />
          </div>
        )}

        {mode === 'preview' && (
          <div className="flex-1 min-h-0">
            <MarkdownPreview content={tab.content} />
          </div>
        )}

        {mode === 'split' && (
          <>
            <div className="flex-1 min-h-0 min-w-0 border-r border-border">
              <MarkdownEditor value={tab.content} onChange={(v) => updateContent(tab.noteId, v)} />
            </div>
            <div className="flex-1 min-h-0 min-w-0">
              <MarkdownPreview content={tab.content} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
