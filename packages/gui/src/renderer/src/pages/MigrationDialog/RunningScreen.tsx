import type { MigratePhase } from '@/types/owl-api';
import { Check, Circle, Loader2 } from 'lucide-react';

const STEPS: ReadonlyArray<{ phase: MigratePhase; label: string }> = [
  { phase: 'backup', label: '备份原库' },
  { phase: 'copy', label: '复制数据' },
  { phase: 'fts-rebuild', label: '重建全文索引' },
  { phase: 'swap', label: '原子替换' },
];

interface Props {
  currentPhase: MigratePhase | null;
}

/**
 * Progress screen: 4-step ordered list. The current phase shows a spinner;
 * all phases that come earlier in STEPS are marked done. After the migration
 * resolves, the container will bump currentPhase to 'swap' so the final step
 * also appears done before the screen switches.
 */
export function RunningScreen({ currentPhase }: Props) {
  const currentIndex = currentPhase ? STEPS.findIndex((s) => s.phase === currentPhase) : -1;

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
      <div className="max-w-md w-full rounded-lg border border-border p-6 bg-card space-y-4">
        <h2 className="text-lg font-semibold">正在迁移数据库…</h2>
        <ul className="space-y-2">
          {STEPS.map((step, i) => {
            const status: 'done' | 'active' | 'pending' =
              i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
            return (
              <li key={step.phase} className="flex items-center gap-2 text-sm">
                {status === 'done' ? (
                  <Check className="size-4 text-green-500" aria-label="完成" />
                ) : status === 'active' ? (
                  <Loader2 className="size-4 animate-spin text-primary" aria-label="进行中" />
                ) : (
                  <Circle className="size-4 text-muted-foreground" aria-label="等待" />
                )}
                <span className={status === 'pending' ? 'text-muted-foreground' : ''}>
                  {step.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
