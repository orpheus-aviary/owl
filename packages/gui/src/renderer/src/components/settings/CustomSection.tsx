import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { testLlmConnection } from '@/lib/api';
import type { LlmApiFormat, OwlConfig } from '@/lib/api';
import { useConfigStore } from '@/stores/config-store';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

const API_FORMATS: { id: LlmApiFormat; label: string; placeholder: string }[] = [
  { id: 'openai', label: 'OpenAI', placeholder: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', placeholder: 'https://api.anthropic.com/v1' },
];

const MODE_OPTIONS: { id: OwlConfig['editor']['default_mode']; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'split', label: '分屏' },
  { id: 'preview', label: '预览' },
];

function SettingRow({
  label,
  help,
  children,
  align = 'center',
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={`flex ${align === 'start' ? 'items-start' : 'items-center'} justify-between gap-4 px-4 py-3`}
    >
      <div className="flex flex-col min-w-0">
        <span className="text-sm">{label}</span>
        {help && <span className="text-[11px] text-muted-foreground">{help}</span>}
      </div>
      <div className="flex items-center gap-2 flex-wrap justify-end">{children}</div>
    </div>
  );
}

export function CustomSection() {
  const llm = useConfigStore((s) => s.llm);
  const trash = useConfigStore((s) => s.trash);
  const editor = useConfigStore((s) => s.editor);
  const browser = useConfigStore((s) => s.browser);
  const patchLlm = useConfigStore((s) => s.patchLlm);
  const patchTrash = useConfigStore((s) => s.patchTrash);
  const patchEditor = useConfigStore((s) => s.patchEditor);
  const patchBrowser = useConfigStore((s) => s.patchBrowser);

  // Draft state — commit on blur/Enter so typing doesn't trigger a config write
  // on every keystroke.
  const [urlDraft, setUrlDraft] = useState(llm.url);
  const [modelDraft, setModelDraft] = useState(llm.model);
  const [keyDraft, setKeyDraft] = useState(llm.api_key);
  const [daysDraft, setDaysDraft] = useState(String(trash.auto_delete_days));
  const [showKey, setShowKey] = useState(false);

  useEffect(() => setUrlDraft(llm.url), [llm.url]);
  useEffect(() => setModelDraft(llm.model), [llm.model]);
  useEffect(() => setKeyDraft(llm.api_key), [llm.api_key]);
  useEffect(() => setDaysDraft(String(trash.auto_delete_days)), [trash.auto_delete_days]);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const commitUrl = () => {
    if (urlDraft !== llm.url) patchLlm({ url: urlDraft });
  };
  const commitModel = () => {
    if (modelDraft !== llm.model) patchLlm({ model: modelDraft });
  };
  const commitKey = () => {
    if (keyDraft !== llm.api_key) patchLlm({ api_key: keyDraft });
  };
  const commitDays = () => {
    const n = Number(daysDraft);
    if (Number.isFinite(n) && n >= 1 && n !== trash.auto_delete_days) {
      patchTrash({ auto_delete_days: Math.round(n) });
    } else {
      setDaysDraft(String(trash.auto_delete_days));
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    // Flush drafts first so the test uses the visible values.
    const override = {
      url: urlDraft,
      model: modelDraft,
      api_key: keyDraft,
      api_format: llm.api_format,
    };
    try {
      const res = await testLlmConnection(override);
      setTestResult({ ok: true, message: res.data?.message ?? res.message ?? '连接成功' });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const currentFormat = API_FORMATS.find((f) => f.id === llm.api_format) ?? API_FORMATS[0];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">自定义</h2>
        <p className="text-sm text-muted-foreground">
          LLM API、自动删除天数、默认编辑模式与排序方式。
        </p>
      </div>

      {/* LLM API */}
      <div>
        <h3 className="text-sm font-medium px-1 pb-2">LLM API</h3>
        <div className="border border-border rounded-md divide-y divide-border">
          <SettingRow label="API 格式">
            <div className="flex items-center gap-1">
              {API_FORMATS.map((f) => (
                <Button
                  key={f.id}
                  size="sm"
                  variant={llm.api_format === f.id ? 'default' : 'outline'}
                  onClick={() => patchLlm({ api_format: f.id })}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          </SettingRow>

          <SettingRow label="URL" help={currentFormat.placeholder}>
            <Input
              className="w-72 h-8"
              placeholder={currentFormat.placeholder}
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={commitUrl}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </SettingRow>

          <SettingRow label="API Key">
            <Input
              type={showKey ? 'text' : 'password'}
              className="w-60 h-8 font-mono"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onBlur={commitKey}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? '隐藏' : '显示'}
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </SettingRow>

          <SettingRow label="模型名称">
            <Input
              className="w-60 h-8 font-mono"
              placeholder="gpt-4o-mini / claude-3-5-sonnet-latest"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={commitModel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </SettingRow>

          <SettingRow
            label="测试连接"
            help={
              testResult
                ? testResult.ok
                  ? `✓ ${testResult.message}`
                  : `✕ ${testResult.message}`
                : '发送一条 ping 消息验证配置'
            }
            align="start"
          >
            <Button size="sm" onClick={runTest} disabled={testing}>
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
              测试
            </Button>
          </SettingRow>
        </div>
      </div>

      {/* Behavior */}
      <div>
        <h3 className="text-sm font-medium px-1 pb-2">行为</h3>
        <div className="border border-border rounded-md divide-y divide-border">
          <SettingRow label="自动删除天数" help="回收站中超过该天数的笔记会被自动清理">
            <Input
              type="number"
              className="w-20 h-8"
              value={daysDraft}
              onChange={(e) => setDaysDraft(e.target.value)}
              onBlur={commitDays}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
            <span className="text-sm text-muted-foreground">天</span>
          </SettingRow>

          <SettingRow label="默认编辑模式" help="新开编辑页时使用">
            <div className="flex items-center gap-1">
              {MODE_OPTIONS.map((m) => (
                <Button
                  key={m.id}
                  size="sm"
                  variant={editor.default_mode === m.id ? 'default' : 'outline'}
                  onClick={() => patchEditor({ default_mode: m.id })}
                >
                  {m.label}
                </Button>
              ))}
            </div>
          </SettingRow>

          <SettingRow label="默认排序字段" help="浏览页初始排序">
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={browser.default_sort_field === 'updated' ? 'default' : 'outline'}
                onClick={() => patchBrowser({ default_sort_field: 'updated' })}
              >
                更新时间
              </Button>
              <Button
                size="sm"
                variant={browser.default_sort_field === 'created' ? 'default' : 'outline'}
                onClick={() => patchBrowser({ default_sort_field: 'created' })}
              >
                创建时间
              </Button>
            </div>
          </SettingRow>

          <SettingRow label="默认排序方向">
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={browser.default_sort_direction === 'desc' ? 'default' : 'outline'}
                onClick={() => patchBrowser({ default_sort_direction: 'desc' })}
              >
                降序
              </Button>
              <Button
                size="sm"
                variant={browser.default_sort_direction === 'asc' ? 'default' : 'outline'}
                onClick={() => patchBrowser({ default_sort_direction: 'asc' })}
              >
                升序
              </Button>
            </div>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}
