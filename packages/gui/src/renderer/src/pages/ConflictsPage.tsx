/**
 * P5-c §6.16 / §6.17 + W7 — list of unresolved sync conflicts (LWW losers).
 *
 * Each row shows the local "副本" (losing) + remote (winning) content side by
 * side with their `updated_at_ms` timestamps. Per row the user can:
 *   - 复制 the local content / 打开笔记 in the editor
 *   - 用本地覆盖 — write the local copy back as the winning version (CAS)
 *   - 手动处理… — hand-merge in `<ConflictMergeDialog>` (CAS)
 *   - 采用远端 — accept the remote winner already in the note; soft-delete the
 *     row (the old "忽略" — renamed since it's a deliberate keep-remote choice,
 *     not a no-op)
 *
 * Resolve writes go through the daemon's `POST /conflicts/:id/resolve`, which
 * uses the note's current `updated_at` as a CAS baseline: if the note changed
 * after detection the write 409s instead of blind-overwriting (AC3). A note
 * with unsaved edits open in the editor blocks resolve until saved/discarded
 * (D9); a clean open tab is refreshed with the resolved content afterwards.
 */

import { ConflictMergeDialog } from '@/components/sync/ConflictMergeDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useOpenNote } from '@/hooks/useOpenNote';
import {
  ApiError,
  type ConflictRecord,
  type ResolveConflictBody,
  getNote as apiGetNote,
  ignoreConflict as apiIgnoreConflict,
  resolveConflict as apiResolveConflict,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { useConflictsStore } from '@/stores/conflicts-store';
import { useDataBus } from '@/stores/data-bus';
import { useEditorStore } from '@/stores/editor-store';
import { isUnsaved } from '@/stores/editor-tabs';
import { currentGen, isStale } from '@/stores/session-epoch';
import {
  AlertTriangle,
  Check,
  CircleCheck,
  Copy,
  GitMerge,
  RefreshCw,
  SquarePen,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

function formatTimestamp(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 0011 (0.6.2 W1) — explain the LWW outcome when the timestamps alone can't.
 * The winner is decided by the three-tuple `(updated_at_ms, lww_counter,
 * device_id)`, so a same-millisecond conflict looks arbitrary unless we surface
 * the other two dimensions:
 *   - ms differ            → timestamps already explain it, add nothing
 *   - ms tie, counter differs → append `· #<counter>` to each side
 *   - ms + counter tie     → append the device and spell the rule out
 *   - counters both NULL   → row predates 0011, add nothing
 * A NULL device_id renders as「未知设备」— never invent a device name.
 */
interface LwwExplain {
  localSuffix: string;
  remoteSuffix: string;
  hint: string | null;
}

const NO_LWW_EXPLAIN: LwwExplain = { localSuffix: '', remoteSuffix: '', hint: null };

function deviceLabel(deviceId: string | null): string {
  return deviceId ? `设备 ${deviceId.slice(0, 8)}` : '未知设备';
}

function explainLww(row: ConflictRecord): LwwExplain {
  if (row.local_lww_counter === null && row.remote_lww_counter === null) return NO_LWW_EXPLAIN;
  if (row.local_updated_at_ms !== row.remote_updated_at_ms) return NO_LWW_EXPLAIN;
  if (row.local_lww_counter !== row.remote_lww_counter) {
    return {
      localSuffix: ` · #${row.local_lww_counter}`,
      remoteSuffix: ` · #${row.remote_lww_counter}`,
      hint: null,
    };
  }
  return {
    localSuffix: ` · #${row.local_lww_counter} · ${deviceLabel(row.local_device_id)}`,
    remoteSuffix: ` · #${row.remote_lww_counter} · ${deviceLabel(row.remote_device_id)}`,
    hint: '同一毫秒 · 计数相同，由设备 id 定序',
  };
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

/** Extract the raw string content of a payload for the merge editor (no
 *  placeholder — an absent copy just seeds an empty pane). */
function payloadContent(raw: string | null): string {
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw) as { content?: unknown };
    return typeof obj.content === 'string' ? obj.content : '';
  } catch {
    return '';
  }
}

const DIRTY_TAB_MSG = '该笔记有未保存的修改，请先保存或放弃后再解决冲突。';

function resolveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.errorCode) {
      case 'VERSION_MISMATCH':
        return '笔记在解决冲突期间被改动，请点击刷新后重试。';
      case 'ALREADY_TRASHED':
        return '笔记已被移入回收站，无法写入。';
      case 'NOTE_NOT_FOUND':
        return '笔记不存在，可能已被删除。';
      case 'CONFLICT_NOT_FOUND':
        return '该冲突已不存在（可能已在别处解决）。';
      case 'BAD_PAYLOAD':
        return '本地副本内容已损坏，无法用本地覆盖，请改用合并。';
      case 'UNSUPPORTED_ENTITY':
        return '该类型的冲突暂不支持解决。';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

type ResolveOutcome = { ok: true } | { ok: false; message: string };

/** True when `entityId` has a tab open with unsaved edits (D9 block). */
function noteHasUnsavedTab(entityId: string): boolean {
  const tab = useEditorStore.getState().tabs.find((t) => t.noteId === entityId);
  return tab !== undefined && isUnsaved(tab);
}

type BaselineResult =
  | { kind: 'ok'; ms: number }
  | { kind: 'stale' }
  | { kind: 'error'; message: string };

/**
 * Read the note's current `updated_at` as the CAS baseline (AC3), lossless ms
 * from the ISO wire value — same derivation as the editor's CAS baseline.
 * `'stale'` means the session switched mid-fetch (drop silently).
 */
async function loadResolveBaseline(entityId: string, gen: number): Promise<BaselineResult> {
  try {
    const noteRes = await apiGetNote(entityId);
    if (isStale(gen)) return { kind: 'stale' };
    if (!noteRes.data) return { kind: 'error', message: '笔记不存在，可能已被删除。' };
    return { kind: 'ok', ms: new Date(noteRes.data.updatedAt).getTime() };
  } catch (err) {
    if (isStale(gen)) return { kind: 'stale' };
    return { kind: 'error', message: resolveErrorMessage(err) };
  }
}

/** Refresh the sidebar count + list + cross-page buses after a resolve. */
async function refreshAfterResolve(gen: number): Promise<void> {
  await useConflictsStore.getState().refresh();
  await useConflictsStore.getState().refreshList();
  if (isStale(gen)) return;
  useDataBus.getState().bumpNotes();
  useDataBus.getState().bumpConflicts();
}

/**
 * Resolve one conflict end-to-end: block dirty tabs (D9), take the CAS baseline
 * (AC3), POST the resolve, refresh a clean open tab + the conflict list.
 * Generation-guarded (③): a session switch mid-flight drops every write-back.
 */
async function performResolve(
  row: ConflictRecord,
  strategy: 'local' | 'merged',
  mergedContent?: string,
): Promise<ResolveOutcome> {
  const gen = currentGen();
  if (noteHasUnsavedTab(row.entity_id)) return { ok: false, message: DIRTY_TAB_MSG };

  const baseline = await loadResolveBaseline(row.entity_id, gen);
  if (baseline.kind === 'stale') return { ok: true };
  if (baseline.kind === 'error') return { ok: false, message: baseline.message };

  try {
    const body: ResolveConflictBody =
      strategy === 'merged'
        ? { strategy: 'merged', content: mergedContent ?? '', expected_updated_at_ms: baseline.ms }
        : { strategy: 'local', expected_updated_at_ms: baseline.ms };
    const res = await apiResolveConflict(row.id, body);
    if (isStale(gen)) return { ok: true };
    // Clean-tab baseline refresh (D9): the tab was clean (dirty blocked above);
    // gate on a live tab so we never open a fresh one for an un-viewed note.
    if (res.data?.resolved === true) {
      const liveTab = useEditorStore.getState().tabs.find((t) => t.noteId === row.entity_id);
      if (liveTab) useEditorStore.getState().openNote(res.data.note);
    }
  } catch (err) {
    if (isStale(gen)) return { ok: true };
    return { ok: false, message: resolveErrorMessage(err) };
  }

  await refreshAfterResolve(gen);
  return { ok: true };
}

export function ConflictRow({
  row,
  busy,
  onIgnore,
  onResolveLocal,
  onOpenMerge,
}: {
  row: ConflictRecord;
  busy?: boolean;
  onIgnore: (id: string) => void | Promise<void>;
  onResolveLocal: (row: ConflictRecord) => void | Promise<void>;
  onOpenMerge: (row: ConflictRecord) => void;
}) {
  const local = parsePayloadContent(row.local_payload);
  const remote = parsePayloadContent(row.remote_payload);
  const lww = explainLww(row);
  const openNote = useOpenNote();
  const isMobile = useIsMobile();
  const [copied, setCopied] = useState(false);
  const isNote = row.entity_type === 'note';
  const canOverwrite = isNote && row.local_payload !== null;
  // Open the conflicting note in the editor (shows the winning/remote version —
  // the user can paste the copied losing content to recover/merge). Desktop =
  // openNoteById + navigate('/'); mobile routes to /note/:id.
  const handleOpen = useCallback(() => {
    void openNote({ noteId: row.entity_id });
  }, [openNote, row.entity_id]);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(local);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn('[conflicts] copy failed:', err);
    }
  }, [local]);
  return (
    <div className="border border-border rounded-md p-3 mb-3 bg-card">
      <div
        className={cn(
          'flex gap-2 mb-2',
          isMobile ? 'flex-col items-stretch' : 'items-start justify-between',
        )}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="size-4 text-yellow-500" />
          <span>笔记 #{row.entity_id.slice(0, 8)}</span>
          <Badge variant="secondary" className="text-[10px]">
            {row.losing_side === 'local' ? '本地输' : (row.losing_side ?? '未知')}
          </Badge>
          <span className="text-[11px]">检测于 {formatTimestamp(row.detected_at)}</span>
          {lww.hint && <span className="text-[11px]">· {lww.hint}</span>}
        </div>
        <div className={cn('flex items-center gap-1', isMobile ? 'flex-wrap' : 'shrink-0')}>
          <Button variant="ghost" size="sm" onClick={handleOpen} className="text-xs">
            <SquarePen className="size-3.5 mr-1" /> 打开笔记
          </Button>
          {canOverwrite && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void onResolveLocal(row)}
              className="text-xs"
            >
              <Undo2 className="size-3.5 mr-1" /> 用本地覆盖
            </Button>
          )}
          {isNote && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onOpenMerge(row)}
              className="text-xs"
            >
              <GitMerge className="size-3.5 mr-1" /> 手动处理…
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void onIgnore(row.id)}
            className="text-xs"
          >
            <CircleCheck className="size-3.5 mr-1" /> 采用远端
          </Button>
        </div>
      </div>
      <div className={cn('grid gap-2 text-xs', isMobile ? 'grid-cols-1' : 'grid-cols-2')}>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-medium text-muted-foreground">
              本地副本 ({formatTimestamp(row.local_updated_at_ms)}
              {lww.localSuffix})
            </span>
            {row.local_payload && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleCopy()}
                className="h-5 px-1.5 text-[11px]"
              >
                {copied ? (
                  <>
                    <Check className="size-3 mr-1" /> 已复制
                  </>
                ) : (
                  <>
                    <Copy className="size-3 mr-1" /> 复制
                  </>
                )}
              </Button>
            )}
          </div>
          <pre className="whitespace-pre-wrap break-words bg-muted/30 p-2 rounded text-foreground max-h-60 overflow-auto">
            {local}
          </pre>
        </div>
        <div>
          <div className="font-medium text-muted-foreground mb-1">
            远端胜出 ({formatTimestamp(row.remote_updated_at_ms)}
            {lww.remoteSuffix})
          </div>
          <pre className="whitespace-pre-wrap break-words bg-muted/30 p-2 rounded text-foreground max-h-60 overflow-auto">
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

  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [mergeRow, setMergeRow] = useState<ConflictRecord | null>(null);
  const [mergeSubmitting, setMergeSubmitting] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

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

  const handleResolveLocal = useCallback(async (row: ConflictRecord) => {
    setBanner(null);
    setBusyId(row.id);
    const out = await performResolve(row, 'local');
    setBusyId(null);
    if (!out.ok) setBanner(out.message);
  }, []);

  const handleOpenMerge = useCallback((row: ConflictRecord) => {
    setBanner(null);
    if (noteHasUnsavedTab(row.entity_id)) {
      setBanner(DIRTY_TAB_MSG);
      return;
    }
    setMergeError(null);
    setMergeRow(row);
  }, []);

  const handleMergeSubmit = useCallback(
    async (content: string) => {
      if (!mergeRow) return;
      setMergeError(null);
      setMergeSubmitting(true);
      const out = await performResolve(mergeRow, 'merged', content);
      setMergeSubmitting(false);
      if (out.ok) {
        setMergeRow(null);
      } else {
        setMergeError(out.message);
      }
    },
    [mergeRow],
  );

  // Mobile only — the merge dialog's「采用本地副本」shortcut (resolveConflict
  // ('local')); desktop adopts local from the row's「用本地覆盖」instead.
  const handleMergeResolveLocal = useCallback(async () => {
    if (!mergeRow) return;
    setMergeError(null);
    setMergeSubmitting(true);
    const out = await performResolve(mergeRow, 'local');
    setMergeSubmitting(false);
    if (out.ok) {
      setMergeRow(null);
    } else {
      setMergeError(out.message);
    }
  }, [mergeRow]);

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
      {banner && (
        <div className="text-sm text-destructive mb-2 shrink-0 flex items-center justify-between gap-2">
          <span>{banner}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setBanner(null)}
            className="h-5 px-1.5 text-[11px]"
          >
            知道了
          </Button>
        </div>
      )}
      <ScrollArea className="flex-1 min-h-0 pr-2">
        {list.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground py-8 text-center">没有未解决的冲突</div>
        )}
        {list.map((row) => (
          <ConflictRow
            key={row.id}
            row={row}
            busy={busyId === row.id}
            onIgnore={handleIgnore}
            onResolveLocal={handleResolveLocal}
            onOpenMerge={handleOpenMerge}
          />
        ))}
      </ScrollArea>
      {mergeRow && (
        <ConflictMergeDialog
          open={mergeRow !== null}
          localContent={payloadContent(mergeRow.local_payload)}
          remoteContent={payloadContent(mergeRow.remote_payload)}
          submitting={mergeSubmitting}
          error={mergeError}
          onCancel={() => {
            setMergeRow(null);
            setMergeError(null);
          }}
          onSubmit={handleMergeSubmit}
          onResolveLocal={handleMergeResolveLocal}
        />
      )}
    </div>
  );
}
