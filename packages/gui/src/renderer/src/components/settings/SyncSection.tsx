import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SyncStatusReply } from '../../../../shared/sync-status-types.js';
import { DevicesCard } from './DevicesCard';

/**
 * P5-d Phase 8 — Settings → 同步 tab.
 *
 * Single display truth: identity (email / workspace_slug / device_name)
 * always comes from `sync:status` IPC. Login success drops the
 * IPC-returned summary on purpose and re-fetches status — so new
 * display fields only require one IPC change, not two.
 */

type SessionShape = NonNullable<SyncStatusReply['session']>;
type SnapshotShape = SyncStatusReply['snapshot'];

type View =
  | { kind: 'loading' }
  | { kind: 'unauth'; snapshot: SnapshotShape }
  | { kind: 'auth'; session: SessionShape; snapshot: SnapshotShape };

// Skybridge server's actual default port is 8443
// (`skybridge/packages/server/src/config.ts`). The earlier `18443` in the
// Phase 8 design doc was a typo that survived into the form default and
// was caught during manual testing 2026-05-29.
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8443';

export function SyncSection() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const reply = await window.owlAPI.sync.status();
    if (!reply.ok) {
      setError(reply.message);
      return;
    }
    setError(null);
    const { session, snapshot } = reply.data;
    if (session) {
      setView({ kind: 'auth', session, snapshot });
      // Pre-fill server URL with the active session's server, so logout
      // → re-login flow doesn't lose the last-used host.
      setServerUrl(session.server_url);
    } else {
      setView({ kind: 'unauth', snapshot });
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverUrl.trim() || !email.trim() || !password) return;
    setError(null);
    setSubmitting(true);
    const reply = await window.owlAPI.sync.login({
      serverUrl: serverUrl.trim(),
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (!reply.ok) {
      setError(reply.message);
      return;
    }
    setPassword('');
    await refreshStatus();
  };

  const handleLogout = async () => {
    setConfirmingLogout(false);
    setError(null);
    setSubmitting(true);
    const reply = await window.owlAPI.sync.logout();
    setSubmitting(false);
    if (!reply.ok) {
      setError(reply.message);
      return;
    }
    await refreshStatus();
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">同步</h2>
        <p className="text-sm text-muted-foreground">
          通过 skybridge 在多设备间同步笔记。账号、工作区、设备信息保存在系统钥匙串。
        </p>
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</div>
      )}

      {view.kind === 'loading' && (
        <div className="text-sm text-muted-foreground flex items-center gap-2 px-3 py-4">
          <Loader2 className="size-4 animate-spin" />
          正在读取同步状态…
        </div>
      )}

      {view.kind === 'unauth' && view.snapshot !== null && view.snapshot.server_url === null && (
        // W6: explicitly mark the local profile. Only when the daemon HAS
        // reported (snapshot !== null) and it's local (server_url === null) —
        // not for daemon-down (snapshot null) nor a keychain-broken account
        // profile (session null but server_url present).
        <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded">
          当前为<span className="font-medium text-foreground">本地独立工作区</span>
          ，笔记仅存储在本地。登录账号可在多设备间同步。
        </div>
      )}

      {view.kind === 'unauth' && (
        <form
          onSubmit={handleLogin}
          className="border border-border rounded-md divide-y divide-border"
        >
          <SettingRow label="服务器地址">
            <Input
              type="text"
              className="w-72 h-8"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder={DEFAULT_SERVER_URL}
              autoComplete="off"
              spellCheck={false}
            />
          </SettingRow>
          <SettingRow label="邮箱">
            <Input
              type="email"
              className="w-72 h-8"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </SettingRow>
          <SettingRow label="密码">
            <Input
              type="password"
              className="w-72 h-8"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </SettingRow>
          <div className="px-4 py-3 flex justify-end">
            <Button type="submit" disabled={submitting || !email || !password || !serverUrl.trim()}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              登录
            </Button>
          </div>
        </form>
      )}

      {view.kind === 'auth' && (
        <>
          <div className="border border-border rounded-md divide-y divide-border">
            <SettingRow label="账号">
              <span className="text-sm text-foreground">{view.session.email}</span>
            </SettingRow>
            <SettingRow label="工作区">
              <span className="text-sm font-mono text-foreground">
                {view.session.workspace_slug ?? view.session.workspace_id}
              </span>
            </SettingRow>
            <SettingRow label="当前设备">
              <span className="text-sm text-foreground">{view.session.device_name}</span>
            </SettingRow>
            <div className="px-4 py-3 flex justify-end gap-2">
              {confirmingLogout ? (
                <>
                  <span className="text-xs text-muted-foreground self-center mr-2">确认退出？</span>
                  <Button variant="outline" size="sm" onClick={() => setConfirmingLogout(false)}>
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleLogout}
                    disabled={submitting}
                  >
                    {submitting && <Loader2 className="size-4 animate-spin" />}
                    确认退出
                  </Button>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setConfirmingLogout(true)}>
                  退出登录
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground px-1">
            ⏰ 提醒仅在当前账号激活时触发；切换到其他账号或本地独立工作区时，此账号的提醒不会响起。
          </p>
          <DevicesCard />
        </>
      )}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
