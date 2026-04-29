interface Props {
  dbPath: string;
  onStart: () => void;
  onQuit: () => void;
}

/**
 * Initial screen when a legacy v0.2 db is detected. User confirms before we
 * touch anything — the migration itself is reversible (backup kept) but we
 * still ask because it's destructive by feel (path swap, wal/shm cleanup).
 */
export function ConfirmScreen({ dbPath, onStart, onQuit }: Props) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
      <div className="max-w-md w-full rounded-lg border border-border p-6 bg-card space-y-4">
        <h2 className="text-lg font-semibold">数据库需要迁移</h2>
        <p className="text-sm text-muted-foreground">检测到 owl.db 使用旧格式（v0.2）。</p>
        <p className="text-sm break-all font-mono text-muted-foreground">{dbPath}</p>
        <ul className="text-sm space-y-1 list-disc list-inside">
          <li>备份原库到 owl.db.v0.2-backup-&lt;ts&gt;</li>
          <li>升级结构到 user_version=1（FTS5 trigram、触发器、auto_delete_at）</li>
          <li>通常耗时 &lt;1 秒</li>
          <li>失败时原库不会被破坏</li>
        </ul>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onQuit}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
          >
            退出 Owl
          </button>
          <button
            type="button"
            onClick={onStart}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm hover:bg-primary/90"
          >
            开始迁移
          </button>
        </div>
      </div>
    </div>
  );
}
