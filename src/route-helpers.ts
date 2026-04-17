/**
 * PR2 路由辅助纯函数 — 独立模块，供 index.ts 和测试共用。
 *
 * 不依赖任何有副作用的模块（无 DB、无 Web server、无 IM 连接），
 * 因此测试可以直接 import 而不触发 main()。
 */

import type { IMConnectionKind, BotGroupBinding } from './types.js';
import type { RegisteredGroup } from './types.js';

export interface RouteTarget {
  folder: string;
  /** '' 表示 user 连接（兼容路径）；非空时为 Bot ID */
  botId: string;
}

export interface RouteDeps {
  getRegisteredGroup: (jid: string) => Pick<RegisteredGroup, 'folder'> | null;
  getBinding: (
    botId: string,
    jid: string,
  ) => Pick<BotGroupBinding, 'folder' | 'enabled'> | null;
}

/**
 * 阶段 0：按连接类型（user / bot）选择 folder 来源。
 * - user 连接：查 registered_groups.folder（单 Bot 兼容路径，`botId` 返回 ''）
 * - bot  连接：查 bot_group_bindings.folder（多 Bot 路径，binding 须 enabled）
 *
 * 返回 null 表示无法路由（消息应被丢弃）。
 */
export function resolveRouteTarget(
  kind: IMConnectionKind,
  groupJid: string,
  botId: string | undefined,
  deps: RouteDeps,
): RouteTarget | null {
  if (kind === 'user') {
    const rg = deps.getRegisteredGroup(groupJid);
    if (!rg) return null;
    return { folder: rg.folder, botId: '' };
  }
  if (!botId) return null;
  const binding = deps.getBinding(botId, groupJid);
  if (!binding || !binding.enabled) return null;
  return { folder: binding.folder, botId };
}
