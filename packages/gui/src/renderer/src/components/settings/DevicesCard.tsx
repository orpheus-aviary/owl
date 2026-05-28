import { Button } from '@/components/ui/button';
import { ChevronDownIcon, ChevronRightIcon, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { SyncDeviceEntry } from '../../../../shared/sync-devices-types.js';

/**
 * P5-d Phase 10 — Settings → 同步 tab → 「管理我的设备」collapsible
 * sub-card. Read-only:
 *  - skybridge server ^0.1.3 has no revoke endpoint (Phase 10.5+).
 *
 * Behaviour (locked, see design §4 + §6.1):
 *  - collapsed by default — single-device users don't pay the fetch
 *  - first expand triggers sync.devices(); subsequent expand re-uses
 *    the in-component cache (no re-fetch)
 *  - explicit refresh button is the only re-fetch trigger
 *  - on error, the body renders a 「重试」button which also acts as
 *    an explicit re-fetch
 *  - current device (matches toml [device].id via main's is_current
 *    flag) is highlighted with a green dot + `[当前]` chip
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; devices: SyncDeviceEntry[] }
  | { kind: 'error'; message: string };

export function DevicesCard() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const fetchDevices = useCallback(async () => {
    setPhase({ kind: 'loading' });
    const reply = await window.owlAPI.sync.devices();
    if (!reply.ok) {
      setPhase({ kind: 'error', message: reply.message });
      return;
    }
    setPhase({ kind: 'loaded', devices: reply.data.devices });
  }, []);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    // Trigger fetch only on the first expansion (idle phase).
    // Subsequent expansions re-use the cached list; users hit
    // the refresh button to re-fetch.
    if (next && phase.kind === 'idle') {
      void fetchDevices();
    }
  };

  const headerCount = phase.kind === 'loaded' ? ` (${phase.devices.length})` : '';

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          className="flex items-center gap-2 text-sm font-medium hover:text-foreground/80"
        >
          {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          <span>管理我的设备{headerCount}</span>
        </button>
        {open && phase.kind === 'loaded' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetchDevices()}
            aria-label="刷新设备列表"
            title="刷新"
          >
            <RefreshCw className="size-4" />
          </Button>
        )}
      </div>

      {open && (
        <div className="border-t border-border">
          {phase.kind === 'loading' && (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              加载设备列表…
            </div>
          )}
          {phase.kind === 'error' && (
            <div className="px-4 py-4 flex flex-col gap-3">
              <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">
                {phase.message}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => void fetchDevices()}>
                  重试
                </Button>
              </div>
            </div>
          )}
          {phase.kind === 'loaded' &&
            (phase.devices.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                未发现任何设备
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {phase.devices.map((d) => (
                  <DeviceRow key={d.id} device={d} />
                ))}
              </ul>
            ))}
        </div>
      )}
    </div>
  );
}

function DeviceRow({ device }: { device: SyncDeviceEntry }) {
  const meta = [device.platform ?? null, device.app_version ?? null]
    .filter((s): s is string => Boolean(s))
    .join(' · ');

  return (
    <li className="px-4 py-3 flex items-start gap-3">
      <span
        aria-hidden
        className={
          device.is_current
            ? 'mt-1.5 size-2 rounded-full bg-green-500 shrink-0'
            : 'mt-1.5 size-2 rounded-full bg-muted-foreground/40 shrink-0'
        }
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{device.name}</span>
          {device.is_current && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-700 dark:text-green-400 shrink-0">
              当前
            </span>
          )}
        </div>
        {meta && <div className="text-xs text-muted-foreground mt-0.5 truncate">{meta}</div>}
        <div className="text-xs text-muted-foreground mt-0.5">
          上次活跃 {formatRelative(device.last_seen_at)}
        </div>
      </div>
    </li>
  );
}

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

// formatRelative — pure function, takes an explicit `now` for testability;
// default to Date.now() in production.
export function formatRelative(timestampMs: number, now: number = Date.now()): string {
  const deltaMs = timestampMs - now;
  const deltaSec = Math.round(deltaMs / 1000);
  const absSec = Math.abs(deltaSec);
  if (absSec < 60) return RELATIVE_FORMATTER.format(deltaSec, 'second');
  const deltaMin = Math.round(deltaSec / 60);
  if (Math.abs(deltaMin) < 60) return RELATIVE_FORMATTER.format(deltaMin, 'minute');
  const deltaHour = Math.round(deltaMin / 60);
  if (Math.abs(deltaHour) < 24) return RELATIVE_FORMATTER.format(deltaHour, 'hour');
  const deltaDay = Math.round(deltaHour / 24);
  if (Math.abs(deltaDay) < 30) return RELATIVE_FORMATTER.format(deltaDay, 'day');
  const deltaMonth = Math.round(deltaDay / 30);
  if (Math.abs(deltaMonth) < 12) return RELATIVE_FORMATTER.format(deltaMonth, 'month');
  const deltaYear = Math.round(deltaMonth / 12);
  return RELATIVE_FORMATTER.format(deltaYear, 'year');
}
