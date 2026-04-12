import { Button } from '@/components/ui/button';
import type { ShortcutsConfig } from '@/lib/api';
import { DEFAULT_SHORTCUTS, useConfigStore } from '@/stores/config-store';
import { RotateCcw } from 'lucide-react';
import { ShortcutRecorder } from './ShortcutRecorder';

interface ShortcutRow {
  key: keyof ShortcutsConfig;
  label: string;
}

const ROWS: ShortcutRow[] = [
  { key: 'save', label: '保存' },
  { key: 'close_tab', label: '关闭 Tab' },
  { key: 'toggle_wrap', label: '切换自动换行' },
  { key: 'toggle_edit_mode', label: '切换编辑模式' },
  { key: 'new_note', label: '新建笔记' },
  { key: 'nav_editor', label: '导航到编辑' },
  { key: 'nav_browser', label: '导航到浏览' },
  { key: 'nav_trash', label: '导航到回收站' },
  { key: 'nav_reminders', label: '导航到提醒' },
  { key: 'nav_todo', label: '导航到待办' },
  { key: 'nav_ai', label: '导航到 AI' },
  { key: 'nav_settings', label: '导航到设置' },
];

export function ShortcutsSection() {
  const shortcuts = useConfigStore((s) => s.shortcuts);
  const patchShortcuts = useConfigStore((s) => s.patchShortcuts);
  const resetShortcuts = useConfigStore((s) => s.resetShortcuts);
  const error = useConfigStore((s) => s.error);

  // Map of currently duplicate bindings → which action keys share them.
  const duplicates = new Set<string>();
  const seen = new Map<string, keyof ShortcutsConfig>();
  for (const row of ROWS) {
    const binding = shortcuts[row.key];
    if (!binding) continue;
    const prior = seen.get(binding);
    if (prior) {
      duplicates.add(binding);
    } else {
      seen.set(binding, row.key);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">快捷键</h2>
          <p className="text-sm text-muted-foreground">
            点击快捷键框后按下组合键录制，按 Esc 取消。
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (confirm('确定恢复所有快捷键为默认值？')) {
              resetShortcuts();
            }
          }}
        >
          <RotateCcw className="size-3.5" />
          恢复默认
        </Button>
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</div>
      )}

      <div className="border border-border rounded-md divide-y divide-border">
        {ROWS.map((row) => {
          const binding = shortcuts[row.key];
          const isDup = binding && duplicates.has(binding);
          const isChanged = binding !== DEFAULT_SHORTCUTS[row.key];
          return (
            <div key={row.key} className="flex items-center justify-between px-4 py-2.5 gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm">{row.label}</span>
                {isChanged && <span className="text-[10px] text-muted-foreground">(已修改)</span>}
                {isDup && <span className="text-[10px] text-destructive">冲突</span>}
              </div>
              <ShortcutRecorder
                value={binding}
                onChange={(next) => patchShortcuts({ [row.key]: next })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
