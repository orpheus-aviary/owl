/**
 * P5-d Phase 10 — Settings → 同步 tab → 「管理我的设备」子卡片所用类型。
 *
 * SDK 返回 camelCase `ApiDevice`；shared 层转 snake_case（与
 * `SyncStatusResult` 风格一致），由 main IPC handler 在 `sync:devices`
 * reply 时做映射。`is_current` 在 main 层计算（toml `[device].id` vs SDK
 * 返回的 device id 对比），renderer 不需再做匹配。
 */

import type { SyncIpcReply } from './sync-status-types.js';

export interface SyncDeviceEntry {
  id: string;
  name: string;
  platform: string | null;
  app_version: string | null;
  client_version: string | null;
  created_at: number;
  last_seen_at: number;
  is_current: boolean;
}

export interface SyncDevicesReply {
  devices: SyncDeviceEntry[];
}

export type SyncDevicesIpcReply = SyncIpcReply<SyncDevicesReply>;
