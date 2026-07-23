import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { LoginAndOpenSessionInput } from '../../../../shared/sync-auth-types.js';
import { SettingRow } from './SettingRow';

// Skybridge server's actual default port is 8443
// (`skybridge/packages/server/src/config.ts`).
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8443';

// The form's output IS the login input (④: aliasing — not a hand-kept twin —
// so `remember` and any future field flow through automatically).
export type LoginFormValues = LoginAndOpenSessionInput;

/**
 * P5-d (multi-account add) — the skybridge login form, shared by the unauth
 * view and the auth-view「添加账号」action.
 *
 * Owns its own input state (a fresh mount = empty email/password), seeded with
 * `initialServerUrl` so same-server account switching doesn't retype the host —
 * the parent passes `session.server_url ?? snapshot.server_url ?? DEFAULT` so it
 * never regresses to a hardcoded default. Login errors render INSIDE the form;
 * the page-level banner is reserved for status / logout. `onCancel`, when given,
 * shows a 取消 button (auth-view add only — the unauth view has no cancel).
 */
export function LoginForm({
  initialServerUrl,
  submitting,
  error,
  onSubmit,
  onCancel,
  hideServerUrl,
  showRemember,
}: {
  initialServerUrl: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: LoginFormValues) => void;
  onCancel?: () => void;
  /**
   * Phase B (B1) — hide the 服务器地址 row. The web host's daemon is fixed by
   * its own config (the field is meaningless there); `initialServerUrl` is
   * still passed through to onSubmit for shape parity, just not user-editable.
   */
  hideServerUrl?: boolean;
  /**
   * ④ — show the「记住我」checkbox (web host only). Desktop leaves it off: its
   * local session isn't browser-persisted, so `remember` would be meaningless.
   */
  showRemember?: boolean;
}) {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  // Mobile web: the SettingRow stacks, so the input takes the full row width
  // rather than the fixed desktop `w-72` that would overflow a phone.
  const inputCls = cn('h-8', useIsMobile() ? 'w-full' : 'w-72');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverUrl.trim() || !email.trim() || !password) return;
    onSubmit({ serverUrl: serverUrl.trim(), email: email.trim(), password, remember });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-border rounded-md divide-y divide-border"
    >
      {!hideServerUrl && (
        <SettingRow label="服务器地址">
          <Input
            type="text"
            className={inputCls}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={DEFAULT_SERVER_URL}
            autoComplete="off"
            spellCheck={false}
          />
        </SettingRow>
      )}
      <SettingRow label="邮箱">
        <Input
          type="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
      </SettingRow>
      <SettingRow label="密码">
        <Input
          type="password"
          className={inputCls}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </SettingRow>
      {showRemember && (
        <label className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住我（在此浏览器保持登录，刷新不必重登）
        </label>
      )}
      {error && <div className="px-4 py-2 text-sm text-destructive bg-destructive/10">{error}</div>}
      <div className="px-4 py-3 flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
        )}
        <Button type="submit" disabled={submitting || !email || !password || !serverUrl.trim()}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          登录
        </Button>
      </div>
    </form>
  );
}
