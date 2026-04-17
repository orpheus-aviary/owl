import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { NoteTag } from '@/lib/api';
import { useEditorStore } from '@/stores/editor-store';
import type { ConflictDecision, PendingAiUpdate } from '@/stores/editor-store';
import { useCallback, useState } from 'react';
import { DiffView } from './diff/DiffView';

/**
 * Save-time conflict resolver. Mounted once at the app root (see `App.tsx`);
 * driven entirely by `editorStore.conflictPrompt`. Opens when the user's
 * Cmd+S would commit a save whose AI-staged payload diverges from what the
 * tab's save baselines assume.
 *
 * Layout:
 *   - Header lists which fields diverge (content / tags / folder).
 *   - Optional "查看差异" expands an inline `DiffView` split so the user
 *     can eyeball both versions before deciding.
 *   - Footer buttons resolve via `resolveConflict`.
 */
export function ConflictDialog() {
  const prompt = useEditorStore((s) => s.conflictPrompt);
  const resolveConflict = useEditorStore((s) => s.resolveConflict);
  const [showDiff, setShowDiff] = useState(false);

  const open = prompt !== null;

  const onClose = useCallback(() => {
    // Dismissing the dialog without choosing isn't really "cancel" — we
    // treat it as keeping-mine-and-not-saving. Simplest: just clear the
    // prompt so the user can retry Cmd+S. They can explicitly choose
    // keep-mine if they want the save to go through.
    useEditorStore.setState({ conflictPrompt: null });
    setShowDiff(false);
  }, []);

  const decide = useCallback(
    async (decision: ConflictDecision) => {
      await resolveConflict(decision);
      setShowDiff(false);
    },
    [resolveConflict],
  );

  if (!prompt) return null;

  const tab = useEditorStore.getState().tabs.find((t) => t.noteId === prompt.tabId);
  if (!tab) return null;

  const fields = buildConflictFields(prompt.conflict);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className={showDiff ? 'max-w-3xl' : undefined}>
        <DialogHeader>
          <DialogTitle>AI 对此笔记的修改与你本地的修改不一致</DialogTitle>
          <DialogDescription>
            冲突项：{fields.length === 0 ? '(无字段差异)' : fields.join('、')}
          </DialogDescription>
        </DialogHeader>

        {showDiff ? (
          <DiffView
            // Prefer `pre_stage_content` when stageAiUpdate overwrote live
            // edits — that's the version the user actually wrote. Fall back
            // to `tab.content` for the server-baseline-mismatch case where
            // the tab already held AI's version at save time.
            original={prompt.pending.pre_stage_content ?? tab.content}
            modified={prompt.pending.content}
            className="h-96 border border-border rounded-md"
          />
        ) : (
          <ConflictSummary tab={tab} pending={prompt.pending} />
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? '收起差异' : '查看差异'}
          </Button>
          <Button variant="outline" onClick={() => void decide('keep-mine')}>
            保留本地
          </Button>
          <Button onClick={() => void decide('accept-ai')}>接受 AI 版本</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildConflictFields(conflict: {
  contentChanged: boolean;
  tagsChanged: boolean;
  folderChanged: boolean;
}): string[] {
  const out: string[] = [];
  if (conflict.contentChanged) out.push('内容');
  if (conflict.tagsChanged) out.push('标签');
  if (conflict.folderChanged) out.push('文件夹');
  return out;
}

/** Compact summary shown when the user hasn't clicked "查看差异" yet. */
function ConflictSummary({
  tab,
  pending,
}: {
  tab: { tags: NoteTag[]; folderId: string | null };
  pending: PendingAiUpdate;
}) {
  const localTags = tab.tags.map((t) =>
    t.tagType === '#' ? `#${t.tagValue}` : `${t.tagType}${t.tagValue ? ` ${t.tagValue}` : ''}`,
  );
  const aiTags = pending.tags;
  return (
    <div className="space-y-3 text-sm">
      <Row label="本地标签" items={localTags} />
      <Row label="AI 标签" items={aiTags} />
      <div className="text-xs text-muted-foreground">
        本地文件夹：<span className="font-mono">{tab.folderId ?? '(root)'}</span> → AI 建议：
        <span className="font-mono">{pending.folder_id ?? '(root)'}</span>
      </div>
    </div>
  );
}

/**
 * Tag strings may repeat (rare but valid, e.g. two `#draft` entries if
 * the user double-added one). Suffix a counter to keep React keys stable
 * across re-renders without falling back to array indices.
 */
function dedupeForKeys(items: string[]): { key: string; value: string }[] {
  const seen = new Map<string, number>();
  return items.map((value) => {
    const count = seen.get(value) ?? 0;
    seen.set(value, count + 1);
    return { key: `${value}#${count}`, value };
  });
}

function Row({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground shrink-0 pt-0.5 w-16">{label}</span>
      {items.length === 0 ? (
        <span className="text-xs text-muted-foreground/60">(无)</span>
      ) : (
        dedupeForKeys(items).map(({ key, value }) => (
          <Badge key={key} variant="outline" className="text-[11px] font-mono">
            {value}
          </Badge>
        ))
      )}
    </div>
  );
}
