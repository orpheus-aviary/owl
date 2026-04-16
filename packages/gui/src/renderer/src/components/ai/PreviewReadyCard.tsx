import type { PreviewReadyCard as PreviewReadyData } from '@/stores/ai-store';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { useState } from 'react';

interface PreviewReadyCardProps {
  preview: PreviewReadyData;
}

/**
 * Minimal indicator for `preview_ready` events. The GUI never originates
 * these (chats default to source='gui'), but a daemon connected to an
 * external CLI agent can emit them and they'll surface here. Apply is
 * out of scope for the GUI — `apply_update` runs from the CLI side.
 */
export function PreviewReadyCard({ preview }: PreviewReadyCardProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-amber-500/10 text-left"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <Terminal className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium">外部预览 · {preview.action}</span>
        <span className="font-mono text-muted-foreground truncate">{preview.preview_id}</span>
      </button>
      {open && (
        <div className="border-t border-amber-500/40 bg-background/50 px-2 py-1.5 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            通过 CLI <code className="font-mono">apply_update</code> 提交此预览,GUI 不直接应用。
          </p>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug bg-muted/40 rounded p-1.5 max-h-48 overflow-y-auto">
            {preview.diff || '(无差异内容)'}
          </pre>
        </div>
      )}
    </div>
  );
}
