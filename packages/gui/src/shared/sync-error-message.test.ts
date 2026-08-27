import { describe, expect, it } from 'vitest';
import { syncErrorMessage } from './sync-error-message.js';

describe('syncErrorMessage', () => {
  // The 13 ErrorCode values from @orpheus-aviary/skybridge-proto. Pinned
  // here so a SDK upgrade that adds a code AND forgets to map it triggers
  // a test failure (in addition to the `Record<ErrorCodeValue, string>`
  // exhaustiveness check at compile time).
  it.each<[string, string]>([
    ['INVALID_CREDENTIALS', '邮箱或密码不正确'],
    ['TOKEN_MISSING', '登录凭证缺失，请重新登录'],
    ['TOKEN_INVALID', '登录已失效，请重新登录'],
    ['DEVICE_HEADER_MISSING', '设备信息缺失，请重新登录'],
    ['DEVICE_FORBIDDEN', '这台设备已被移出该账号，请退出登录后重新登录（会重新注册一台设备）'],
    ['DEVICE_ALREADY_REGISTERED', '该设备已在此账号注册'],
    ['WORKSPACE_NOT_FOUND', '找不到对应的工作区'],
    ['WORKSPACE_EXISTS', '工作区已存在'],
    ['BAD_REQUEST', '请求格式错误'],
    ['INVALID_PAYLOAD', '请求内容不合法'],
    ['BATCH_TOO_LARGE', '一次同步的数据量过大'],
    ['NOT_IMPLEMENTED', '服务器尚未支持该操作'],
    ['INTERNAL_ERROR', '服务器内部错误，请稍后重试'],
  ])('api code %s → %s', (code, expected) => {
    expect(syncErrorMessage({ kind: 'api', code })).toBe(expected);
  });

  it('unknown api code falls back with code interpolation', () => {
    expect(syncErrorMessage({ kind: 'api', code: 'NEW_FUTURE_CODE' })).toBe(
      '同步出错（NEW_FUTURE_CODE）',
    );
  });

  it('network', () => {
    expect(syncErrorMessage({ kind: 'network' })).toBe('网络连接失败，请检查服务器地址或本机网络');
  });

  it('safe_storage_unavailable', () => {
    expect(syncErrorMessage({ kind: 'safe_storage_unavailable' })).toBe(
      '系统钥匙串不可用，无法安全存储登录凭证',
    );
  });

  it('unknown with detail', () => {
    expect(syncErrorMessage({ kind: 'unknown', detail: 'boom' })).toBe('同步出错：boom');
  });

  it('unknown without detail', () => {
    expect(syncErrorMessage({ kind: 'unknown' })).toBe('同步出错');
  });
});
