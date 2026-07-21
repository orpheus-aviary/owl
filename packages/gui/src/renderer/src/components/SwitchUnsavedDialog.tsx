import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSwitchGuard } from '@/stores/switch-guard';

/**
 * ③ addendum — batch unsaved-tabs prompt shown when a profile switch (login /
 * logout / quick-switch) would discard dirty tabs. Unlike the quit-time
 * `UnsavedTabsDialog` (sequential, per-tab), this is a single 3-way choice
 * because the switch is all-or-nothing. Mounted once in MainApp; driven by
 * `useSwitchGuard`.
 */
export function SwitchUnsavedDialog() {
  const open = useSwitchGuard((s) => s.open);
  const unsavedCount = useSwitchGuard((s) => s.unsavedCount);
  const saving = useSwitchGuard((s) => s.saving);
  const saveFailed = useSwitchGuard((s) => s.saveFailed);
  const discard = useSwitchGuard((s) => s.discard);
  const saveAll = useSwitchGuard((s) => s.saveAll);
  const cancel = useSwitchGuard((s) => s.cancel);

  // Esc / click-outside = cancel, except while a save-all is in flight.
  const onOpenChange = (next: boolean) => {
    if (!next && !saving) cancel();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>有未保存的更改</DialogTitle>
          <DialogDescription>
            有 <span className="font-medium">{unsavedCount}</span>{' '}
            个未保存的标签页。切换账号后这些修改将丢失。
            {saveFailed && (
              <span className="mt-2 block text-xs text-destructive">
                部分保存失败，请重试或选择「放弃并切换」。
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={cancel} disabled={saving}>
            取消
          </Button>
          <Button variant="outline" onClick={discard} disabled={saving}>
            放弃并切换
          </Button>
          <Button onClick={saveAll} disabled={saving}>
            {saving ? '保存中…' : saveFailed ? '重试' : '保存全部并切换'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
