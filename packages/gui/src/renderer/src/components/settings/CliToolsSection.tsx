import { Button } from '@/components/ui/button';
import type { CliDetectResult } from '@/types/owl-api';
import { Check, Copy, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const INSTALL_CMD = 'npm install -g @orpheus-aviary/owl-cli';

/**
 * Runs once on mount and on the manual 重新检测 button. The `cli:detect`
 * IPC handler falls back to an expanded PATH (Homebrew / nvm / npm-global)
 * so Finder-launched Electron can still find the binary.
 */
export function CliToolsSection() {
  const [result, setResult] = useState<CliDetectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await window.owlAPI.cli.detect());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function copyInstallCmd() {
    await navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div>
      <h3 className="text-sm font-medium px-1 pb-2">CLI 工具</h3>
      <div className="border border-border rounded-md px-4 py-3">
        {result === null && loading && <div className="text-sm text-muted-foreground">检测中…</div>}
        {result?.installed && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <Check className="h-4 w-4 text-green-600" />
                <span>已安装 owl CLI</span>
              </div>
              <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
                <RefreshCw className={`h-3 w-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
                重新检测
              </Button>
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5 pl-6">
              <div>
                路径：<span className="font-mono">{result.path}</span>
              </div>
              {result.version && (
                <div>
                  版本：<span className="font-mono">{result.version}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {result !== null && !result.installed && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <X className="h-4 w-4 text-red-600" />
                <span>未找到 owl CLI</span>
              </div>
              <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
                <RefreshCw className={`h-3 w-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
                重新检测
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              CLI 让你在终端和 AI agent 中读写 owl 笔记。
            </p>
            <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
              <code className="text-xs font-mono flex-1 select-all">{INSTALL_CMD}</code>
              <Button size="sm" variant="ghost" onClick={copyInstallCmd} className="h-7 px-2">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">安装完成后点 "重新检测"。</p>
          </div>
        )}
      </div>
    </div>
  );
}
