import type { ErrorCodeValue } from '@orpheus-aviary/skybridge-proto';

/**
 * Single source of truth for sync error → user-facing Chinese message.
 * Lives in `shared/` because both main (`sync-ipc.ts`'s catch path) and
 * renderer (component-level catch fallbacks) need it.
 *
 * `Record<ErrorCodeValue, string>` is exhaustive: when the SDK adds a
 * new code, `tsc --noEmit` fails until the map is updated — that's the
 * bug-bar for "missed an error case".
 */
const API_MESSAGES: Record<ErrorCodeValue, string> = {
  INVALID_CREDENTIALS: '邮箱或密码不正确',
  TOKEN_MISSING: '登录凭证缺失，请重新登录',
  TOKEN_INVALID: '登录已失效，请重新登录',
  TOKEN_EXPIRED: '登录凭证已过期，请重新登录',
  REFRESH_INVALID: '登录已失效，请重新登录',
  REFRESH_REPLAYED: '登录凭证异常（可能已在其他设备续期），请重新登录',
  DEVICE_HEADER_MISSING: '设备信息缺失，请重新登录',
  DEVICE_FORBIDDEN: '这台设备已被移出该账号，请退出登录后重新登录（会重新注册一台设备）',
  DEVICE_MISMATCH: '设备凭证不匹配，请重新登录',
  DEVICE_ALREADY_REGISTERED: '该设备已在此账号注册',
  WORKSPACE_NOT_FOUND: '找不到对应的工作区',
  WORKSPACE_EXISTS: '工作区已存在',
  BAD_REQUEST: '请求格式错误',
  INVALID_PAYLOAD: '请求内容不合法',
  BATCH_TOO_LARGE: '一次同步的数据量过大',
  NOT_IMPLEMENTED: '服务器尚未支持该操作',
  INTERNAL_ERROR: '服务器内部错误，请稍后重试',
};

export type SyncErrorInput =
  | { kind: 'api'; code: string }
  | { kind: 'network' }
  | { kind: 'safe_storage_unavailable' }
  | { kind: 'unknown'; detail?: string };

export function syncErrorMessage(input: SyncErrorInput): string {
  switch (input.kind) {
    case 'api': {
      const known = (API_MESSAGES as Record<string, string>)[input.code];
      return known ?? `同步出错（${input.code}）`;
    }
    case 'network':
      return '网络连接失败，请检查服务器地址或本机网络';
    case 'safe_storage_unavailable':
      return '系统钥匙串不可用，无法安全存储登录凭证';
    case 'unknown':
      return input.detail ? `同步出错：${input.detail}` : '同步出错';
  }
}
