import { Button } from '@/components/ui/button';
import { useActiveTab, useEditorStore } from '@/stores/editor-store';
import { isUnsaved } from '@/stores/editor-tabs';
import type { NavState } from '@/stores/note-nav-guard';
import { ChevronLeft, Eye, Menu, Pencil } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PAGE_TITLES } from './mobile-nav';

/**
 * Two-state top bar (§3.3).
 *   - normal: ☰ (open folder drawer) + page title.
 *   - detail (`/note/:id`): ← back + note title + edit⇄preview toggle + 保存.
 * Browser's own search / filter stay in-page, so the bar carries no context
 * actions on list pages.
 */
export function MobileTopBar({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  const location = useLocation();
  if (location.pathname.startsWith('/note/')) return <DetailTopBar />;

  const title = PAGE_TITLES[location.pathname] ?? 'Owl';
  return (
    <header className="shrink-0 flex items-center gap-2 h-12 px-2 border-b border-border bg-background">
      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        onClick={onOpenDrawer}
        aria-label="打开文件夹"
      >
        <Menu className="size-5" />
      </Button>
      <span className="flex-1 truncate text-sm font-medium">{title}</span>
    </header>
  );
}

function DetailTopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = useActiveTab();
  const mobileMode = useEditorStore((s) => s.mobileMode);
  const setMobileMode = useEditorStore((s) => s.setMobileMode);

  const state = location.state as NavState | undefined;
  const back = () => {
    // §4.1.3: pop when we pushed onto this detail, else jump back to the source
    // page (replacing so the popped detail can't be re-reached with forward).
    if (state?.canPop) navigate(-1);
    else navigate(state?.returnTo ?? '/', { replace: true });
  };

  const dirty = activeTab ? isUnsaved(activeTab) : false;
  const save = () => {
    const id = useEditorStore.getState().activeTabId;
    if (id) void useEditorStore.getState().requestSaveOrConflict(id);
  };

  return (
    <header className="shrink-0 flex items-center gap-1 h-12 px-1 border-b border-border bg-background">
      <Button variant="ghost" size="icon" className="size-9" onClick={back} aria-label="返回">
        <ChevronLeft className="size-5" />
      </Button>
      <span className="flex-1 truncate text-sm font-medium">{activeTab?.title ?? '笔记'}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        onClick={() => setMobileMode(mobileMode === 'edit' ? 'preview' : 'edit')}
        aria-label={mobileMode === 'edit' ? '切换到预览' : '切换到编辑'}
      >
        {mobileMode === 'edit' ? <Eye className="size-5" /> : <Pencil className="size-5" />}
      </Button>
      <Button variant="ghost" size="sm" className="min-h-[36px]" onClick={save} disabled={!dirty}>
        保存
      </Button>
    </header>
  );
}
