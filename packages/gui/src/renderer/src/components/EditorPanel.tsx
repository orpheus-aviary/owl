import { MarkdownEditor } from '@/components/MarkdownEditor';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { TagBar } from '@/components/TagBar';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { type EditorMode, useActiveTab, useEditorStore } from '@/stores/editor-store';
import { Columns2, Eye, Pencil } from 'lucide-react';
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels';

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
  const updateTags = useEditorStore((s) => s.updateTags);

  const splitLayout = useDefaultLayout({
    id: 'owl-editor-split',
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  });

  if (!tab) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">选择或新建笔记</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-end px-2 py-1 border-b border-border shrink-0">
        <ModeToggle />
      </div>

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
          <Group
            orientation="horizontal"
            id="owl-editor-split"
            defaultLayout={splitLayout.defaultLayout}
            onLayoutChanged={splitLayout.onLayoutChanged}
            className="flex flex-1 min-h-0 min-w-0"
          >
            <Panel
              id="editor"
              defaultSize={50}
              minSize={25}
              className="h-full w-full min-h-0 min-w-0"
            >
              <MarkdownEditor value={tab.content} onChange={(v) => updateContent(tab.noteId, v)} />
            </Panel>
            <ResizeHandle />
            <Panel
              id="preview"
              defaultSize={50}
              minSize={25}
              className="h-full w-full min-h-0 min-w-0"
            >
              <MarkdownPreview content={tab.content} />
            </Panel>
          </Group>
        )}
      </div>

      <TagBar tags={tab.tags} onTagsChange={(tags) => updateTags(tab.noteId, tags)} />
    </div>
  );
}
