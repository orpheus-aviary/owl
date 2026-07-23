import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useNoteNavGuard } from '@/stores/note-nav-guard';

/**
 * Mobile note-navigation dirty prompt (§4.1.5a + revised model). Fires when the
 * current note has unsaved edits and the user either opens another note or
 * leaves the editor (返回). Three choices — 保存 / 放弃 / (打开笔记|继续编辑) —
 * fed back through `choose`; dismissing (Esc / backdrop) cancels and stays put.
 * Mounted once in MainApp; only ever appears on the mobile shell.
 *
 * The third button is context-labelled: opening another note → 打开笔记 (jump to
 * THIS unsaved note instead); leaving the editor → 继续编辑 (stay on it).
 */
export function NoteNavGuardDialog() {
  const prompt = useNoteNavGuard((s) => s.prompt);
  const choose = useNoteNavGuard((s) => s.choose);
  const open = prompt !== null;
  const saving = prompt?.phase === 'saving';
  const saveFailed = prompt?.phase === 'save-failed';
  const openCurrentLabel = prompt?.kind === 'leave' ? '继续编辑' : '打开笔记';

  // Esc / backdrop = cancel (stay put), except while a save is in flight.
  const onOpenChange = (next: boolean) => {
    if (!next && !saving) void choose('cancel');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>未保存的更改</DialogTitle>
          <DialogDescription>
            「{prompt?.title}」有未保存的修改。
            {saveFailed && (
              <span className="mt-2 block text-xs text-destructive">
                保存失败，请重试或选择「放弃」。
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => void choose('open-current')} disabled={saving}>
            {openCurrentLabel}
          </Button>
          <Button variant="outline" onClick={() => void choose('discard')} disabled={saving}>
            放弃
          </Button>
          <Button onClick={() => void choose('save')} disabled={saving}>
            {saving ? '保存中…' : saveFailed ? '重试' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
