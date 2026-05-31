import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { SyncState, SyncStatusSnapshot } from '@/lib/api';
import { useSyncStatus } from '@/stores/sync-status';
import { Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * P5-b §6.3 / §7 — daemon sync status indicator. Lives at the very
 * bottom of the left sidebar (`mt-auto` in `MainApp.tsx`), shaped like
 * the surrounding 64px-wide nav items: a coloured dot on top, a 2-char
 * Chinese label below. No router behaviour — hover/click opens a
 * popover with workspace / device / last-sync / last-error details.
 *
 * No manual sync button: P5-b's SSE bridge auto-retries forever
 * (`sse-bridge.ts:42-58`, 2/4/8/16/30s + jitter, never gives up) and
 * runs a catch-up `runManualSync` on every reconnect, so an "offline"
 * state is informational, not actionable. Power users can still drive
 * sync from `owl sync run`.
 *
 * The four state labels mirror `SyncState` exactly — adding a new state
 * to the union means updating `STATE_INFO` below.
 */

interface StateInfo {
  label: string;
  /** Tailwind class for the status dot fill. */
  dotClass: string;
  /** Whether the dot should spin (overrides shape). */
  spin: boolean;
}

const STATE_INFO: Record<SyncState, StateInfo> = {
  idle: { label: '已同步', dotClass: 'bg-muted-foreground', spin: false },
  syncing: { label: '同步中', dotClass: 'text-sky-500', spin: true },
  error: { label: '出错', dotClass: 'bg-red-500', spin: false },
  offline: { label: '离线', dotClass: 'bg-amber-500', spin: false },
};

export function SyncStatusBar({ className = '' }: { className?: string }) {
  const snapshot = useSyncStatus((s) => s.snapshot);

  // `null` = haven't heard from daemon yet. Render as idle so the first
  // paint doesn't flash an alarm — SSE / fetch will overwrite within a
  // few hundred ms once the channel is up.
  const state = snapshot?.state ?? 'idle';
  const info = STATE_INFO[state];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // `w-full` so the button stretches to the sidebar's 64px column
          // (without it the button shrinks to content width and the dot
          // appears off-centre relative to the surrounding NavLinks).
          // The fixed-size icon slot keeps the layout stable across
          // dot/spinner transitions — same 16px box as `<item.icon size-4>`
          // in `MainApp.tsx`, so the label baseline lines up with the rest
          // of the sidebar.
          className={`flex flex-col items-center justify-center gap-0.5 h-14 w-full text-[10px] text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors ${className}`}
          aria-label={`同步状态：${info.label}`}
        >
          <span className="flex size-4 items-center justify-center">
            {info.spin ? (
              <Loader2 className={`size-4 animate-spin ${info.dotClass}`} />
            ) : (
              <span aria-hidden="true" className={`block size-2.5 rounded-full ${info.dotClass}`} />
            )}
          </span>
          <span>{info.label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-72">
        <SyncStatusDetails snapshot={snapshot} state={state} />
      </PopoverContent>
    </Popover>
  );
}

function SyncStatusDetails({
  snapshot,
  state,
}: {
  snapshot: SyncStatusSnapshot | null;
  state: SyncState;
}) {
  // No snapshot at all → daemon hasn't reported yet (cold start or
  // sync not configured). Surface a calm explainer rather than the
  // "0 pending / null device" placeholder we'd otherwise render.
  if (!snapshot) {
    return (
      <PopoverHeader>
        <PopoverTitle>同步状态</PopoverTitle>
        <PopoverDescription>
          daemon 尚未上报同步状态。如果未配置 skybridge，可在{' '}
          <Link to="/settings?tab=sync" className="underline">
            设置 → 同步
          </Link>{' '}
          中登录。
        </PopoverDescription>
      </PopoverHeader>
    );
  }

  // W6: snapshot reported AND server_url null → local profile (not an account).
  // Surface it plainly instead of a wall of "未配置 / 未注册" rows.
  if (snapshot.server_url === null) {
    return (
      <PopoverHeader>
        <PopoverTitle>本地独立工作区</PopoverTitle>
        <PopoverDescription>
          笔记仅存储在本地，不会同步到其他设备。可在{' '}
          <Link to="/settings?tab=sync" className="underline">
            设置 → 同步
          </Link>{' '}
          登录账号以启用多设备同步。
        </PopoverDescription>
      </PopoverHeader>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      <PopoverHeader>
        <PopoverTitle className="text-sm">{STATE_INFO[state].label}</PopoverTitle>
        {state === 'offline' && (
          <PopoverDescription>
            连不上同步服务器，后台每 ≤30s 自动重试，无需手动操作。
          </PopoverDescription>
        )}
        {state === 'syncing' && <PopoverDescription>正在与同步服务器交换变更。</PopoverDescription>}
        {state === 'error' && snapshot.last_error && (
          <PopoverDescription className="text-destructive break-words">
            {snapshot.last_error}
          </PopoverDescription>
        )}
      </PopoverHeader>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>服务器</dt>
        <dd className="break-all text-foreground">{snapshot.server_url ?? '未配置'}</dd>

        <dt>设备</dt>
        <dd className="font-mono text-foreground">
          {snapshot.device_id ? shortId(snapshot.device_id) : '未注册'}
        </dd>

        <dt>工作区</dt>
        <dd className="font-mono text-foreground">
          {snapshot.workspace_id ? shortId(snapshot.workspace_id) : '未注册'}
        </dd>

        <dt>最近同步</dt>
        <dd className="text-foreground">{formatRelativeTime(snapshot.last_sync_at)}</dd>

        <dt>待推送</dt>
        <dd className="text-foreground">{snapshot.pending_count}</dd>

        <dt>已拉取 seq</dt>
        <dd className="text-foreground">{snapshot.pulled_seq}</dd>

        <dt>已推送 seq</dt>
        <dd className="text-foreground">{snapshot.pushed_seq}</dd>
      </dl>

      <Link
        to="/settings?tab=sync"
        className="text-xs text-muted-foreground hover:text-foreground self-end"
      >
        管理账号 →
      </Link>
    </div>
  );
}

/**
 * Skybridge device / workspace ids are UUIDs — too long for a 288px
 * popover row. Truncate to the first segment to stay readable while
 * still being copy-friendly.
 */
function shortId(id: string): string {
  const dash = id.indexOf('-');
  if (dash <= 0) return id.length > 12 ? `${id.slice(0, 12)}…` : id;
  return `${id.slice(0, dash)}…`;
}

/**
 * Daemon hands `last_sync_at` as a Unix millisecond timestamp (or null
 * when no successful sync has happened yet). We render a short relative
 * label rather than absolute time because the popover is glanceable —
 * the user mostly wants to know "did this work recently?".
 */
export function formatRelativeTime(ms: number | null, now = Date.now()): string {
  if (ms === null) return '从未';
  const diff = Math.max(0, now - ms);
  if (diff < 5_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
