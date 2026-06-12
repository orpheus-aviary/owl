import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getPlatform } from '@/platform';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProfileSummary } from '../../../../shared/sync-profiles-types.js';

/**
 * P5-d Phase 17 (delete-local-copy) — Settings → 同步 tab → 「已保存账号」
 * management card. Lists every account profile saved on this machine (local is
 * implicit and not listed) and offers a destructive「删除本地副本」per row,
 * behind a strong confirm Dialog.
 *
 * Deleting an account's local copy logs it out on THIS device, removes its
 * local notes copy, and revokes this device remotely — irreversible, but the
 * account's data on the server / other devices is untouched (re-login re-syncs
 * it). Deleting the *active* profile reloads the window (16a, daemon → local);
 * deleting a non-active one just re-fetches the list.
 *
 * Renders nothing when there are no account profiles, so a pure-local user
 * never sees it.
 */
export function SavedProfilesCard() {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProfileSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const loadProfiles = useCallback(async () => {
    // Optional Electron-local capability — the web host has no profile mgmt.
    const profilesFn = getPlatform().sync.profiles;
    if (!profilesFn) return;
    const reply = await profilesFn();
    if (!mounted.current || !reply.ok) return;
    // local is implicit (id 'local') — never deletable, so drop it from the list.
    setProfiles(reply.data.profiles.filter((p) => p.id !== 'local'));
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadProfiles();
    return () => {
      mounted.current = false;
    };
  }, [loadProfiles]);

  if (!profiles || profiles.length === 0) return null;

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    const deleteFn = getPlatform().sync.deleteProfile;
    if (!deleteFn) return;
    setDeleting(true);
    setError(null);
    const reply = await deleteFn(pendingDelete.id);
    if (reply.ok) {
      // wasActive → the window reloads (16a) and this unmounts; otherwise the
      // row is gone, so re-fetch the list and close the dialog.
      setPendingDelete(null);
      setDeleting(false);
      await loadProfiles();
      return;
    }
    setError(reply.message);
    setDeleting(false);
  };

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="px-4 py-3 text-sm font-medium">已保存账号</div>
      <ul className="border-t border-border divide-y divide-border">
        {profiles.map((p) => (
          <li key={p.id} className="px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm truncate">{p.email ?? p.id}</span>
                {p.is_active && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-700 dark:text-green-400 shrink-0">
                    当前
                  </span>
                )}
                {p.db_missing && (
                  <span className="text-xs text-muted-foreground shrink-0">本地副本缺失</span>
                )}
              </div>
              {p.server_url && (
                <div className="text-xs text-muted-foreground mt-0.5 truncate">{p.server_url}</div>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-destructive hover:text-destructive"
              onClick={() => {
                setError(null);
                setPendingDelete(p);
              }}
            >
              删除本地副本
            </Button>
          </li>
        ))}
      </ul>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除账号本地副本</DialogTitle>
            <DialogDescription asChild>
              <div>
                删除账号{' '}
                <span className="font-medium text-foreground">
                  {pendingDelete?.email ?? pendingDelete?.id}
                </span>{' '}
                在本设备的本地副本？将从此设备登出该账号、删除其全部本地笔记副本，并从同步服务器移除此设备。
                <span className="text-destructive">此操作不可恢复</span>
                （账号在服务器及其他设备上的数据不受影响，可重新登录再次同步下来）。
              </div>
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-xs text-destructive break-words">{error}</p>}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={deleting}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void onConfirmDelete()}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
