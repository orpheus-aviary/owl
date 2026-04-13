import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { OwlConfig } from '@/lib/api';
import { useConfigStore } from '@/stores/config-store';
import { useEffect, useState } from 'react';

type LogLevel = OwlConfig['log']['level'];

const LOG_LEVELS: { id: LogLevel; label: string }[] = [
  { id: 'debug', label: 'debug' },
  { id: 'info', label: 'info' },
  { id: 'warn', label: 'warn' },
  { id: 'error', label: 'error' },
];

function SettingRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex flex-col min-w-0">
        <span className="text-sm">{label}</span>
        {help && <span className="text-[11px] text-muted-foreground">{help}</span>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A number field that holds a local draft string and commits to the store
 * only on blur / Enter, matching AppearanceSection / CustomSection UX.
 * Rejects invalid numbers by snapping back to the stored value.
 */
function NumberField({
  value,
  onCommit,
  min,
  unit,
  width = 'w-20',
}: {
  value: number;
  onCommit: (n: number) => void;
  min: number;
  unit?: string;
  width?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= min && Math.round(n) !== value) {
      onCommit(Math.round(n));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <>
      <Input
        type="number"
        className={`h-8 ${width}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
    </>
  );
}

export function AdvancedSection() {
  const ai = useConfigStore((s) => s.ai);
  const log = useConfigStore((s) => s.log);
  const patchAi = useConfigStore((s) => s.patchAi);
  const patchLog = useConfigStore((s) => s.patchLog);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">高级</h2>
        <p className="text-sm text-muted-foreground">LLM 参数与日志配置，谨慎修改。</p>
      </div>

      {/* LLM 参数 */}
      <div>
        <h3 className="text-sm font-medium px-1 pb-2">LLM 参数</h3>
        <div className="border border-border rounded-md divide-y divide-border">
          <SettingRow label="上下文轮数" help="AI 对话保留的历史轮数">
            <NumberField
              value={ai.context_rounds}
              min={0}
              onCommit={(n) => patchAi({ context_rounds: n })}
            />
          </SettingRow>
          <SettingRow label="最大搜索笔记数" help="FTS 搜索返回给 AI 的笔记上限">
            <NumberField
              value={ai.max_fts_notes}
              min={1}
              onCommit={(n) => patchAi({ max_fts_notes: n })}
            />
          </SettingRow>
          <SettingRow label="最近笔记上下文数" help="作为上下文注入的最近笔记数量">
            <NumberField
              value={ai.max_recent_notes}
              min={0}
              onCommit={(n) => patchAi({ max_recent_notes: n })}
            />
          </SettingRow>
        </div>
      </div>

      {/* 日志配置 */}
      <div>
        <h3 className="text-sm font-medium px-1 pb-2">日志</h3>
        <div className="border border-border rounded-md divide-y divide-border">
          <SettingRow label="单文件大小上限" help="滚动切分阈值">
            <NumberField
              value={log.max_size_mb}
              min={1}
              unit="MB"
              onCommit={(n) => patchLog({ max_size_mb: n })}
            />
          </SettingRow>
          <SettingRow label="保留历史数">
            <NumberField
              value={log.max_backups}
              min={0}
              unit="个"
              onCommit={(n) => patchLog({ max_backups: n })}
            />
          </SettingRow>
          <SettingRow label="最长保留天数">
            <NumberField
              value={log.max_age_days}
              min={1}
              unit="天"
              onCommit={(n) => patchLog({ max_age_days: n })}
            />
          </SettingRow>
          <SettingRow label="日志级别">
            <div className="flex items-center gap-1">
              {LOG_LEVELS.map((lvl) => (
                <Button
                  key={lvl.id}
                  size="sm"
                  variant={log.level === lvl.id ? 'default' : 'outline'}
                  onClick={() => patchLog({ level: lvl.id })}
                >
                  {lvl.label}
                </Button>
              ))}
            </div>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}
