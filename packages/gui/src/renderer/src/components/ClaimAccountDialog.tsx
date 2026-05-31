import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCallback, useEffect, useState } from 'react';
import type { ClaimChoice, ClaimPromptInput } from '../../../shared/sync-claim-types.js';

/**
 * P5-d Phase 16 (D10b) — claim-empty-account prompt.
 *
 * Shown when the login flow detects a first login to an *empty* account while
 * the local workspace holds notes. The user chooses:
 *   - 并入 (merge)      → whole-db copy local → the account, uploaded on first
 *                         sync, visible on all the account's devices, irreversible
 *   - 保持独立 (independent) → local stays put; the account syncs only its own data
 *
 * Forced choice: no close button, Esc / click-outside default to 独立 (the safe,
 * non-destructive option — local is never touched). Mirrors the
 * UnsavedTabsDialog IPC-event-driven pattern.
 */
export function ClaimAccountDialog() {
  const [prompt, setPrompt] = useState<ClaimPromptInput | null>(null);

  useEffect(() => {
    return window.owlAPI.sync.onClaimPrompt((input) => setPrompt(input));
  }, []);

  const respond = useCallback((choice: ClaimChoice) => {
    window.owlAPI.sync.respondClaim(choice);
    setPrompt(null);
  }, []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      // Esc / click-outside → safe default: keep local independent.
      if (!next) respond('independent');
    },
    [respond],
  );

  return (
    <Dialog open={prompt !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>本地笔记如何处理？</DialogTitle>
          <DialogDescription asChild>
            <div>
              检测到本地有{' '}
              <span className="font-medium text-foreground">{prompt?.localCount ?? 0}</span>{' '}
              条笔记。登录账号 <span className="font-medium text-foreground">{prompt?.email}</span>
              ：
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  <span className="font-medium">并入账号</span>
                  ：上传到该账号，所有设备可见，<span className="text-destructive">不可撤销</span>。
                </li>
                <li>
                  <span className="font-medium">保持独立</span>
                  ：笔记留在本地，账号只同步它自己的数据。
                </li>
              </ul>
              {prompt?.hasSyncTraces && (
                <span className="mt-2 block text-xs text-destructive">
                  ⚠️ 本地库含旧同步痕迹，并入新账号会一并上传。
                </span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => respond('independent')}>
            保持独立
          </Button>
          <Button onClick={() => respond('merge')}>并入账号</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
