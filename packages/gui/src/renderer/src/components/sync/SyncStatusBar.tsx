import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { SyncState, SyncStatusSnapshot } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getPlatform } from '@/platform';
import { useSwitchGuard } from '@/stores/switch-guard';
import { type ProbeStatus, useSyncStatus } from '@/stores/sync-status';
import { Check, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProfileSummary, SyncProfilesReply } from '../../../../shared/sync-profiles-types.js';

/**
 * P5-b §6.3 / §7 — daemon sync status indicator. Lives at the very
 * bottom of the left sidebar (`mt-auto` in `MainApp.tsx`), shaped like
 * the surrounding 64px-wide nav items: a coloured dot on top, a 2-char
 * Chinese label below. No router behaviour — hover/click opens a
 * popover with workspace / device / last-sync / last-error details.
 *
 * P5-d Phase 17 (W8): the account-details view has a「手动同步」action
 * (drives `POST /sync/run` via `owlAPI.sync.run`) so the user can force a
 * pull/push round — handy when "offline" and they want an immediate retry.
 * The SSE bridge still auto-retries forever on its own (`sse-bridge.ts:42-58`,
 * 2/4/8/16/30s + jitter, never gives up) and runs a catch-up `runManualSync`
 * on every reconnect, so there is deliberately NO manual reconnect button —
 * offline stays informational; manual sync is the one actionable affordance.
 *
 * ① — the label is derived in four branches (strict → permissive): an
 * unreachable daemon →「未连接」(D12) overrides any stale snapshot; an
 * unregistered workspace →「本地」(D1, see `isAccountSnapshot`); a registered
 * account → its live `SyncState` via `STATE_INFO`; no snapshot yet →「连接中」
 * (D2). Only the account branch mirrors `SyncState`, so adding a state to the
 * union still means updating `STATE_INFO` — but「本地/连接中/未连接」sit outside it.
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

// States that sit OUTSIDE the account-sync `SyncState` union: a purely-local
// workspace (D1 — hollow ring, no cloud), a not-yet-probed daemon (D2), and a
// daemon that can't be reached at all (D12). Hollow ring = `border` with no
// `bg-*` fill so the dot renders as an outline circle.
const LOCAL_INFO: StateInfo = {
  label: '本地',
  dotClass: 'border border-muted-foreground',
  spin: false,
};
const PENDING_INFO: StateInfo = {
  label: '连接中',
  dotClass: 'border border-muted-foreground/50',
  spin: false,
};
const DOWN_INFO: StateInfo = { label: '未连接', dotClass: 'bg-amber-500', spin: false };

/**
 * A snapshot is a real synced account ONLY when the device AND workspace are
 * registered. `server_url` alone is NOT the signal: a leftover `[server].url`
 * in skybridge_config.toml (dev cruft, or a half-finished login) leaves
 * `server_url` set while `device_id`/`workspace_id` stay null — that workspace
 * is still purely local (nothing is pushed), so it must read「本地」, never
 *「已同步」. No config at all → all three null → also local.
 */
function isAccountSnapshot(s: SyncStatusSnapshot): boolean {
  return s.device_id !== null && s.workspace_id !== null;
}

export function SyncStatusBar({
  className = '',
  variant = 'sidebar',
}: {
  className?: string;
  /** `sidebar` = the 64px vertical nav item; `drawer` = a full-width row pinned
   *  to the mobile folder-drawer footer, opening its popover upward. */
  variant?: 'sidebar' | 'drawer';
}) {
  const snapshot = useSyncStatus((s) => s.snapshot);
  const probeStatus = useSyncStatus((s) => s.probeStatus);
  const isDrawer = variant === 'drawer';

  // P5-d Phase 17 (W4) — saved-profile list for the quick-switch section.
  // Fetched when the popover opens (a cheap toml read); 16a reloads the whole
  // window on any profile change, so a freshly-mounted bar always re-fetches.
  const [profiles, setProfiles] = useState<SyncProfilesReply | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const loadProfiles = (open: boolean) => {
    if (!open) return;
    // Optional Electron-local capability — the web host has no quick-switch.
    const profilesFn = getPlatform().sync.profiles;
    if (!profilesFn) return;
    setProfilesLoading(true);
    void profilesFn().then((reply) => {
      setProfiles(reply.ok ? reply.data : null);
      setProfilesLoading(false);
    });
  };

  const state = snapshot?.state ?? 'idle';
  // Four-branch, strict → permissive (D12): an unreachable daemon overrides any
  // (possibly stale) snapshot; then an unregistered workspace reads「本地」, a
  // registered account its live sync state, and no-snapshot-yet「连接中」.
  const info =
    probeStatus === 'unreachable'
      ? DOWN_INFO
      : snapshot != null
        ? isAccountSnapshot(snapshot)
          ? STATE_INFO[snapshot.state]
          : LOCAL_INFO
        : PENDING_INFO;

  return (
    <Popover onOpenChange={loadProfiles}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // sidebar: `w-full` column so the button fills the 64px nav and the
          // dot stays centred (a content-width button would drift off-centre).
          // drawer: a full-width horizontal row for the drawer footer, tall
          // enough to be a touch target.
          className={cn(
            'w-full text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors',
            isDrawer
              ? 'flex flex-row items-center gap-2 h-12 px-3 text-sm border-t border-border'
              : 'flex flex-col items-center justify-center gap-0.5 h-14 text-[10px]',
            className,
          )}
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
      <PopoverContent side={isDrawer ? 'top' : 'right'} align="end" className="w-72">
        <SyncStatusDetails snapshot={snapshot} state={state} probeStatus={probeStatus} />
        {/* W4 quick-switch — only when the daemon has reported (account or
            local view); the cold-start (null) view stays a calm explainer. */}
        {snapshot && <ProfileSwitcher data={profiles} loading={profilesLoading} />}
      </PopoverContent>
    </Popover>
  );
}

function SyncStatusDetails({
  snapshot,
  state,
  probeStatus,
}: {
  snapshot: SyncStatusSnapshot | null;
  state: SyncState;
  probeStatus: ProbeStatus;
}) {
  // Manual sync (W8) — only meaningful in the account-details view below,
  // but hooks must be unconditional so they live at the top.
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const runSync = async () => {
    setRunning(true);
    setRunError(null);
    const reply = await getPlatform().sync.run();
    setRunning(false);
    // Success path needs no local update — the daemon broadcasts
    // `sync:status_changed` over SSE and `useSyncStatus` picks it up.
    if (!reply.ok) setRunError(reply.message);
  };

  // D12: the daemon itself is unreachable — surface it above whatever (possibly
  // stale) snapshot detail follows, in every branch below.
  const banner =
    probeStatus === 'unreachable' ? (
      <PopoverDescription className="text-amber-600 dark:text-amber-500">
        daemon 未响应，正在重试…
      </PopoverDescription>
    ) : null;

  // No snapshot at all → daemon hasn't reported yet (cold start or
  // sync not configured). Surface a calm explainer rather than the
  // "0 pending / null device" placeholder we'd otherwise render.
  if (!snapshot) {
    return (
      <PopoverHeader>
        <PopoverTitle>同步状态</PopoverTitle>
        {banner}
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

  // Not a registered account (no device/workspace binding) → purely local,
  // regardless of any leftover server_url. Surface it plainly instead of a wall
  // of "未注册" rows + a manual-sync button that would only ever error. See
  // `isAccountSnapshot`.
  if (!isAccountSnapshot(snapshot)) {
    return (
      <PopoverHeader>
        <PopoverTitle>本地独立工作区</PopoverTitle>
        {banner}
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
        {banner}
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

      {runError && <p className="text-xs text-destructive break-words">{runError}</p>}

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runSync()}
          disabled={running || state === 'syncing'}
        >
          {(running || state === 'syncing') && <Loader2 className="size-4 animate-spin" />}
          手动同步
        </Button>
        <Link
          to="/settings?tab=sync"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          管理账号 →
        </Link>
      </div>
    </div>
  );
}

/**
 * P5-d Phase 17 (W4) — the sidebar quick-switch list: `local` + every saved
 * account, the effective-active one marked. Clicking a switchable row does a
 * password-free `switchProfile`; on success the whole window reloads (16a) so
 * this component just surfaces failures inline. A profile that can't be
 * quick-switched (db missing / no refresh token) is greyed with a link into
 * Settings — never a `/sync/switch` that would revive an empty db (⑦).
 *
 * Exported for direct unit testing (the popover mock in tests never fires
 * `onOpenChange`, so SyncStatusBar's fetch path isn't exercised there).
 */
export function ProfileSwitcher({
  data,
  loading,
}: {
  data: SyncProfilesReply | null;
  loading: boolean;
}) {
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (data === null) {
    return loading ? (
      <p className="border-t pt-2 px-1 text-xs text-muted-foreground">加载账号…</p>
    ) : null;
  }

  const onSwitch = async (id: string) => {
    // Optional Electron-local capability — the web host has no profile switch.
    const switchFn = getPlatform().sync.switchProfile;
    if (!switchFn) return;
    // ③: quick-switch discards the current profile's dirty tabs — gate first.
    if (!(await useSwitchGuard.getState().request())) return;
    setSwitchingId(id);
    setError(null);
    const reply = await switchFn(id);
    // Success → the window reloads (16a) and this unmounts; only failure lands.
    if (!reply.ok) {
      setError(reply.message);
      setSwitchingId(null);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-1 border-t pt-2">
      <p className="px-1 text-xs font-medium text-muted-foreground">切换账号</p>
      <ul className="flex max-h-48 flex-col overflow-y-auto">
        {data.profiles.map((p) => (
          <ProfileRow
            key={p.id}
            profile={p}
            switching={switchingId === p.id}
            disabled={switchingId !== null}
            onSwitch={() => onSwitch(p.id)}
          />
        ))}
      </ul>
      {error && <p className="px-1 text-xs text-destructive break-words">{error}</p>}
      {/* Add another account — deep-links into Settings with the add form open.
          PopoverClose dismisses this (uncontrolled) popover on navigate. Logging
          in there adds + switches to the new account; the current one stays. */}
      <PopoverClose asChild>
        <Link
          to="/settings?tab=sync&action=add"
          className="flex items-center gap-2 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3 shrink-0" />
          添加账号
        </Link>
      </PopoverClose>
    </div>
  );
}

function ProfileRow({
  profile,
  switching,
  disabled,
  onSwitch,
}: {
  profile: ProfileSummary;
  switching: boolean;
  disabled: boolean;
  onSwitch: () => void;
}) {
  const label =
    profile.id === 'local' ? '本地工作区' : (profile.email ?? profile.server_url ?? profile.id);

  if (profile.is_active) {
    return (
      <li className="flex items-center gap-2 px-1 py-1 text-xs">
        <Check className="size-3 shrink-0 text-green-600 dark:text-green-400" />
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-muted-foreground">（当前）</span>
      </li>
    );
  }

  if (!profile.can_quick_switch) {
    // Ghost (local copy gone) or legacy (no refresh token) → not switchable.
    const hint = profile.db_missing ? '本地副本缺失' : '需重新登录';
    return (
      <li className="flex items-center justify-between gap-2 px-1 py-1 text-xs text-muted-foreground/60">
        <span className="truncate">{label}</span>
        <Link to="/settings?tab=sync" className="shrink-0 underline">
          {hint}
        </Link>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={onSwitch}
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-accent disabled:opacity-50"
      >
        {switching ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </button>
    </li>
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
