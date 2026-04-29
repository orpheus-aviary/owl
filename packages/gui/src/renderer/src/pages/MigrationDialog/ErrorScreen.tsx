import { XCircle } from 'lucide-react';
import { type ErrorCopy, errorCopyFor } from './errorCopy';

interface Props {
  reason: string;
  message: string;
  onRetry: () => void;
  onQuit: () => void;
}

/**
 * Failure terminal. errorCopy.ts decides title/body/showRetry per reason —
 * so incompatible/source_db_corruption/schema_mismatch land on "exit only"
 * while the MigrationBusy family + unknown get the retry path.
 */
export function ErrorScreen({ reason, message, onRetry, onQuit }: Props) {
  const copy: ErrorCopy = errorCopyFor(reason, message);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
      <div className="max-w-md w-full rounded-lg border border-border p-6 bg-card space-y-4">
        <div className="flex items-center gap-2">
          <XCircle className="size-5 text-destructive" />
          <h2 className="text-lg font-semibold">{copy.title}</h2>
        </div>
        <p className="text-sm whitespace-pre-wrap">{copy.body}</p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onQuit}
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
          >
            退出
          </button>
          {copy.showRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm hover:bg-primary/90"
            >
              重试
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
