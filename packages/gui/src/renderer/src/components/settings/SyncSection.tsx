import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SyncStatusReply } from '../../../../shared/sync-status-types.js';
import { DevicesCard } from './DevicesCard';
import { DEFAULT_SERVER_URL, LoginForm, type LoginFormValues } from './LoginForm';
import { SavedProfilesCard } from './SavedProfilesCard';
import { SettingRow } from './SettingRow';

/**
 * P5-d Phase 8 — Settings → 同步 tab.
 *
 * Single display truth: identity (email / workspace_slug / device_name)
 * always comes from `sync:status` IPC. Login success drops the
 * IPC-returned summary on purpose and re-fetches status — so new
 * display fields only require one IPC change, not two.
 *
 * P5-d (multi-account add): logging in while already on an account is allowed —
 * it adds the new account and switches to it (the prior account stays saved for
 * quick-switch). The auth view exposes an「添加账号」action; the form itself is
 * the shared `<LoginForm>`. The add form's visibility is driven by the URL
 * (`?action=add`), so the sidebar「+ 添加账号」deep-link and the in-page button
 * share one source of truth and cancel just clears the param.
 */

type SessionShape = NonNullable<SyncStatusReply['session']>;
type SnapshotShape = SyncStatusReply['snapshot'];

type View =
  | { kind: 'loading' }
  | { kind: 'unauth'; snapshot: SnapshotShape }
  | { kind: 'auth'; session: SessionShape; snapshot: SnapshotShape };

/**
 * Prefill the login form's server with the best known host so same-server
 * account switching doesn't retype it: the active session's server (auth /
 * add), else a keychain-broken account's snapshot server, else the default.
 */
function rememberedServer(view: View): string {
  if (view.kind === 'auth') return view.session.server_url;
  if (view.kind === 'unauth') return view.snapshot?.server_url ?? DEFAULT_SERVER_URL;
  return DEFAULT_SERVER_URL;
}

export function SyncSection() {
  // The add form is URL-driven: `?action=add` opens it (in-page button + sidebar
  // deep-link share one source of truth); cancel clears the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const adding = searchParams.get('action') === 'add';

  const [view, setView] = useState<View>({ kind: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [error, setError] = useState<string | null>(null); // page-level: status / logout
  const [loginError, setLoginError] = useState<string | null>(null); // form-level: login

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
    } else {
      setView({ kind: 'unauth', snapshot });
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleLogin = async (values: LoginFormValues) => {
    setLoginError(null);
    setSubmitting(true);
    const reply = await window.owlAPI.sync.login(values);
    setSubmitting(false);
    if (!reply.ok) {
      setLoginError(reply.message);
      return;
    }
    // Success → main fires `profile:switched` → the window reloads onto the new
    // profile (16a). Refresh status anyway so the identity updates even if the
    // reload is deferred — the "single display truth" loop (login → status).
    await refreshStatus();
  };

  const openAdd = () => {
    setLoginError(null);
    setSearchParams({ tab: 'sync', action: 'add' }, { replace: true });
  };
  const cancelAdd = () => {
    setLoginError(null);
    setSearchParams({ tab: 'sync' }, { replace: true });
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
        <LoginForm
          initialServerUrl={rememberedServer(view)}
          submitting={submitting}
          error={loginError}
          onSubmit={handleLogin}
        />
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

          {/* Multi-account add — log in to another account from here. The new
              account becomes active; this one stays saved for quick-switch. */}
          {adding ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground px-1">
                登录另一个账号；当前账号会保留在列表中，可随时切换。
              </p>
              <LoginForm
                initialServerUrl={rememberedServer(view)}
                submitting={submitting}
                error={loginError}
                onSubmit={handleLogin}
                onCancel={cancelAdd}
              />
            </div>
          ) : (
            <div className="flex justify-start">
              <Button variant="outline" size="sm" onClick={openAdd}>
                添加账号
              </Button>
            </div>
          )}

          <DevicesCard />
        </>
      )}

      {/* W4/delete-local-copy — saved-account management; renders nothing for a
          pure-local user (no account profiles). Shown across all views so a
          user on local can still delete a stale account copy. */}
      <SavedProfilesCard />
    </div>
  );
}
