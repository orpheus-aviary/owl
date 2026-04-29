import { AlertTriangle, Check } from 'lucide-react';

interface Props {
  notesCount: number;
  elapsedMs: number;
  backupPath: string;
  daemonFailed: boolean;
  onDone: () => void;
  onQuit: () => void;
}

/**
 * Post-migration screen. Normal path: "done" button triggers main-process
 * daemon spawn + window recreate. If daemon spawn fails AFTER migration,
 * main sends `migration:daemon-failed` → container flips daemonFailed=true
 * and this screen renders the inline banner so the user can retry without
 * losing the (already successful) migration result.
 */
export function SuccessScreen({
  notesCount,
  elapsedMs,
  backupPath,
  daemonFailed,
  onDone,
  onQuit,
}: Props) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
      <div className="max-w-md w-full rounded-lg border border-border p-6 bg-card space-y-4">
        <div className="flex items-center gap-2">
          <Check className="size-5 text-green-500" />
          <h2 className="text-lg font-semibold">迁移成功</h2>
        </div>
        <p className="text-sm">
          已迁移 {notesCount} 条笔记，耗时 {elapsedMs} ms。
        </p>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">备份已保存到：</p>
          <p className="text-xs break-all font-mono text-muted-foreground">{backupPath}</p>
        </div>

        {daemonFailed && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 space-y-2">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              <p>启动 daemon 失败。请查看 logs/daemon.log 后重试。</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onQuit}
                className="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent"
              >
                退出
              </button>
              <button
                type="button"
                onClick={onDone}
                className="rounded-md bg-destructive text-destructive-foreground px-3 py-1 text-xs hover:bg-destructive/90"
              >
                再试一次
              </button>
            </div>
          </div>
        )}

        {!daemonFailed && (
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onDone}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm hover:bg-primary/90"
            >
              完成
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
