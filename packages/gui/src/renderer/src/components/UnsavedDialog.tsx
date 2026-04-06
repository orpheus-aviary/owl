import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

export type UnsavedAction = 'save' | 'discard' | 'cancel';

interface UnsavedDialogProps {
  open: boolean;
  title: string;
  onAction: (action: UnsavedAction) => void;
}

export function UnsavedDialog({ open, title, onAction }: UnsavedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onAction('cancel')}>
      <DialogContent className="max-w-sm">
        <DialogTitle>未保存的更改</DialogTitle>
        <DialogDescription>「{title}」有未保存的修改，是否保存？</DialogDescription>
        <DialogFooter className="mt-2 gap-3">
          <Button variant="outline" onClick={() => onAction('discard')}>
            不保存
          </Button>
          <Button variant="outline" onClick={() => onAction('cancel')}>
            取消
          </Button>
          <Button onClick={() => onAction('save')}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
