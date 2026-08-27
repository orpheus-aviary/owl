// 哪些设备该出现在 owl 的设备列表里，以及已撤销的那些怎么摆。
//
// 🔴 设备是按**账号**注册的，不是按 workspace。同一个 skybridge 账号下
// 同时挂着 lark 的注册（真机上就是 owl 两台 + lark 手机三台混在一起）。
// skybridge 的 `devices` 表**没有 tool 列**，`app_version` 是唯一能区分
// 它们的东西 —— owl 注册时写 `owl <version>`（`sync-auth-transport.ts`），
// lark 写 `lark <version>`。
//
// 这套规则和文案是从 lark 的 `packages/shared/src/sync-devices.ts` 抄过来的，
// **有意保持一致**：同一份设备列表在两个工具里显示成不同的样子，是没人能
// 推理的状态。改这里之前先看那边。

/**
 * 两条规则，第二条才是需要小心的那半：
 *
 *   1. `owl …` 是我们的，显示。
 *   2. **未知（`null`）也显示** —— 无法证明它不是我们的（老客户端、早于这个
 *      约定的构建都可能没写），而这个列表正是用户来「撤销我不再信任的设备」
 *      的地方。往隐藏的方向猜错，等于把他要找的东西藏起来。
 */
export function isOwlDevice(appVersion: string | null): boolean {
  return appVersion === null || /^owl(\s|$)/i.test(appVersion);
}

export interface OwlDeviceSplit<T> {
  shown: T[];
  /**
   * 有多少台属于别的工具。
   *
   * **要数出来并说出口**，理由和「未知的也显示」是同一个：一台持有本账号凭证的
   * 设备值得被知道，哪怕它的数据归别处管。在那边撤销是那个工具的事。
   */
  hidden: number;
}

export function splitOwlDevices<T>(
  rows: readonly T[],
  appVersionOf: (row: T) => string | null,
): OwlDeviceSplit<T> {
  const shown = rows.filter((row) => isOwlDevice(appVersionOf(row)));
  return { shown, hidden: rows.length - shown.length };
}

/**
 * 列表对「它没显示什么」的交代。隐藏 0 台时为 `null`。
 *
 * 两句都得说 —— 那些设备持有这个账号的凭证、以及撤销它们是另一个工具的事 ——
 * 否则这个数字读起来像缺陷而不像事实。
 */
export function hiddenDevicesNote(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `另有 ${hidden} 台设备属于同一账号的其它工具（lark 等），这里不显示——它们也持有这个账号的凭证，要停用请到那个工具里撤销。`;
}

// ── 已撤销的设备 ───────────────────────────────────────────────────────────
//
// 🔴 它们**永远不会消失**，而且这是服务端的设计而非缺口：skybridge 只做软撤销，
// 因为 `changes.device_id` 和 `attachments.uploaded_by_device` 都是
// `ON DELETE RESTRICT` —— 一台写过行的设备被删掉，那些「谁写的」就成了孤儿。
// `GET /devices` 原样返回全部，不过滤。
//
// 而且它们会**累积**：登录时发现设备被撤销就注册新的一台（复用等于把用户刚关上的
// 门重新打开），所以同一台机器撤销三次就是四行，三行是墓碑。
//
// 所以是折叠而不是过滤。直接藏掉是在谎报这个账号里有什么，而这个列表正是用来核对
// 这件事的；折进一行里，是「越用越长的列表」和「越用越长但看得见」的区别。

export interface RevokedDeviceSplit<T> {
  /** 还能用的。列表默认显示这些。 */
  active: T[];
  /** 墓碑，折叠在后面。 */
  revoked: T[];
}

export function splitRevokedDevices<T>(
  rows: readonly T[],
  revokedAtOf: (row: T) => number | null,
): RevokedDeviceSplit<T> {
  const active: T[] = [];
  const revoked: T[] = [];
  for (const row of rows) (revokedAtOf(row) === null ? active : revoked).push(row);
  return { active, revoked };
}

/** 折叠区自己的标签。后面没东西时为 `null`。 */
export function revokedDevicesLabel(count: number, open: boolean): string | null {
  if (count <= 0) return null;
  return open ? `收起已撤销的 ${count} 台` : `显示已撤销的 ${count} 台`;
}

/**
 * 折叠区为什么存在 —— 展开后显示一次。
 *
 * 它回答的正是「展开」这个动作引出的问题：这些为什么还在，能不能删掉。诚实的答案
 * 是不能，而一个让人去找并不存在的删除按钮的列表，比一个明说的更糟。
 */
export const REVOKED_DEVICES_NOTE =
  '已撤销的设备留在账号里，是因为同步记录里每一条变更都记着是哪台设备写的——删掉设备，那些记录就说不清出处了。它们已经不能再访问这个账号，撤销同一台设备多次会留下多条。';
