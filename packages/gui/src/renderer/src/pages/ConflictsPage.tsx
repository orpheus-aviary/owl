/**
 * P5-c §6.16 / §6.17 — list of unresolved sync conflicts (LWW losers).
 *
 * Each row shows the local "副本" (losing) + remote (winning) content side
 * by side with their `updated_at_ms` timestamps. The user can `忽略` a row
 * — the daemon soft-deletes (UPDATE resolved_at, never DELETE) and emits
 * `conflicts:changed` so other open windows refresh.
 *
 * Cold-start `useConflictsStore.refresh()` is called by MainApp on mount;
 * this page additionally calls `refreshList()` so the actual rows arrive
 * lazily — sidebar count is cheap to keep current, full list is only
 * fetched when the page is open.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { type ConflictRecord, ignoreConflict as apiIgnoreConflict } from '@/lib/api';
import { useConflictsStore } from '@/stores/conflicts-store';
import { useDataBus } from '@/stores/data-bus';
import { AlertTriangle, EyeOff, RefreshCw } from 'lucide-react';
import { useCallback, useEffect } from 'react';

function formatTimestamp(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function parsePayloadContent(raw: string | null): string {
  if (!raw) return '(无副本)';
  try {
    const obj = JSON.parse(raw) as { content?: unknown };
    if (typeof obj.content === 'string') return obj.content;
    return JSON.stringify(obj, null, 2);
  } catch {
    return raw;
  }
}

function ConflictRow({
  row,
  onIgnore,
}: {
  row: ConflictRecord;
  onIgnore: (id: string) => void | Promise<void>;
}) {
  const local = parsePayloadContent(row.local_payload);
  const remote = parsePayloadContent(row.remote_payload);
  return (
    <div className="border border-border rounded-md p-3 mb-3 bg-card">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="size-4 text-yellow-500" />
          <span>笔记 #{row.entity_id.slice(0, 8)}</span>
          <Badge variant="secondary" className="text-[10px]">
            {row.losing_side === 'local' ? '本地输' : (row.losing_side ?? '未知')}
          </Badge>
          <span className="text-[11px]">检测于 {formatTimestamp(row.detected_at)}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void onIgnore(row.id)} className="text-xs">
          <EyeOff className="size-3.5 mr-1" /> 忽略
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="font-medium text-muted-foreground mb-1">
            本地副本 ({formatTimestamp(row.local_updated_at_ms)})
          </div>
          <pre className="whitespace-pre-wrap break-words bg-muted/30 p-2 rounded text-foreground">
            {local}
          </pre>
        </div>
        <div>
          <div className="font-medium text-muted-foreground mb-1">
            远端胜出 ({formatTimestamp(row.remote_updated_at_ms)})
          </div>
          <pre className="whitespace-pre-wrap break-words bg-muted/30 p-2 rounded text-foreground">
            {remote}
          </pre>
        </div>
      </div>
    </div>
  );
}

export function ConflictsPage() {
  const list = useConflictsStore((s) => s.list);
  const loading = useConflictsStore((s) => s.loading);
  const error = useConflictsStore((s) => s.error);
  const refreshList = useConflictsStore((s) => s.refreshList);
  const refresh = useConflictsStore((s) => s.refresh);
  const conflictVersion = useDataBus((s) => s.conflictVersion);
  const bumpConflicts = useDataBus((s) => s.bumpConflicts);

  // Fetch full list on mount and whenever the data-bus signals a change.
  // conflictVersion is the *retrigger signal* — the callback body doesn't read
  // it, but listing it in deps is the whole point of the data-bus pattern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: data-bus retrigger
  useEffect(() => {
    void refreshList();
  }, [refreshList, conflictVersion]);

  const handleIgnore = useCallback(
    async (id: string) => {
      try {
        await apiIgnoreConflict(id);
      } catch (err) {
        console.warn('[conflicts] ignore failed:', err);
        return;
      }
      // Optimistic local refresh — daemon will also push conflicts:changed,
      // but that round-trips through SSE; refresh count + list now so the
      // sidebar 红点 drops immediately.
      await refresh();
      await refreshList();
      bumpConflicts();
    },
    [refresh, refreshList, bumpConflicts],
  );

  return (
    <div className="flex flex-col h-full p-4 overflow-hidden">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <AlertTriangle className="size-5 text-yellow-500" />
          冲突 ({list.length})
        </h1>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refreshList()}
          disabled={loading}
          className="text-xs"
        >
          <RefreshCw className={`size-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> 刷新
        </Button>
      </div>
      {error && <div className="text-sm text-destructive mb-2 shrink-0">加载失败：{error}</div>}
      <ScrollArea className="flex-1 min-h-0 pr-2">
        {list.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground py-8 text-center">没有未解决的冲突</div>
        )}
        {list.map((row) => (
          <ConflictRow key={row.id} row={row} onIgnore={handleIgnore} />
        ))}
      </ScrollArea>
    </div>
  );
}
