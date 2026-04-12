import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfigStore } from '@/stores/config-store';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

const LINE_HEIGHT_OPTIONS = [1.4, 1.6, 1.8];

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

export function AppearanceSection() {
  const win = useConfigStore((s) => s.window);
  const font = useConfigStore((s) => s.font);
  const patchWindow = useConfigStore((s) => s.patchWindow);
  const patchFont = useConfigStore((s) => s.patchFont);

  // Local draft state for window size so typing mid-number doesn't thrash
  // Electron config writes. Commits on blur or Enter.
  const [widthDraft, setWidthDraft] = useState(String(win.width));
  const [heightDraft, setHeightDraft] = useState(String(win.height));

  useEffect(() => {
    setWidthDraft(String(win.width));
    setHeightDraft(String(win.height));
  }, [win.width, win.height]);

  const commitWidth = () => {
    const n = Number(widthDraft);
    if (Number.isFinite(n) && n >= 400 && n !== win.width) {
      patchWindow({ width: Math.round(n) });
    } else {
      setWidthDraft(String(win.width));
    }
  };

  const commitHeight = () => {
    const n = Number(heightDraft);
    if (Number.isFinite(n) && n >= 300 && n !== win.height) {
      patchWindow({ height: Math.round(n) });
    } else {
      setHeightDraft(String(win.height));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">外观</h2>
        <p className="text-sm text-muted-foreground">字体大小、行高等外观设置。</p>
      </div>

      <div className="border border-border rounded-md divide-y divide-border">
        <SettingRow label="默认窗口大小" help="下次启动生效">
          <Input
            type="number"
            className="w-20 h-8"
            value={widthDraft}
            onChange={(e) => setWidthDraft(e.target.value)}
            onBlur={commitWidth}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <span className="text-sm text-muted-foreground">×</span>
          <Input
            type="number"
            className="w-20 h-8"
            value={heightDraft}
            onChange={(e) => setHeightDraft(e.target.value)}
            onBlur={commitHeight}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </SettingRow>

        <SettingRow label="全局字体大小" help="相对基准值 16px 的偏移量">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => patchFont({ global_offset: font.global_offset - 1 })}
            disabled={font.global_offset <= -6}
          >
            <Minus className="size-3.5" />
          </Button>
          <span className="text-sm font-mono w-10 text-center">
            {font.global_offset >= 0 ? `+${font.global_offset}` : font.global_offset}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => patchFont({ global_offset: font.global_offset + 1 })}
            disabled={font.global_offset >= 8}
          >
            <Plus className="size-3.5" />
          </Button>
        </SettingRow>

        <SettingRow label="编辑器字体大小" help="CodeMirror 字号（px）">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => patchFont({ editor_font_size: font.editor_font_size - 1 })}
            disabled={font.editor_font_size <= 10}
          >
            <Minus className="size-3.5" />
          </Button>
          <span className="text-sm font-mono w-10 text-center">{font.editor_font_size}</span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => patchFont({ editor_font_size: font.editor_font_size + 1 })}
            disabled={font.editor_font_size >= 24}
          >
            <Plus className="size-3.5" />
          </Button>
        </SettingRow>

        <SettingRow label="编辑器行高">
          <div className="flex items-center gap-1">
            {LINE_HEIGHT_OPTIONS.map((v) => (
              <Button
                key={v}
                size="sm"
                variant={font.editor_line_height === v ? 'default' : 'outline'}
                onClick={() => patchFont({ editor_line_height: v })}
              >
                {v.toFixed(1)}
              </Button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="配色方案" help="即将推出">
          <span className="text-xs text-muted-foreground">—</span>
        </SettingRow>
      </div>
    </div>
  );
}
