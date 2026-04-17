/**
 * Setup 向导迁移工具：将 user-im 配置迁移为 Bot。
 * 独立模块，最小化依赖，便于测试。
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { createBot } from './db-bots.js';
import { getUserFeishuConfig, saveBotFeishuConfig } from './runtime-config.js';
import type { Bot } from './types.js';

export interface MigrateResult {
  bot: Bot;
}

/**
 * 将用户的 user-im Feishu 配置迁移为一个新的 Bot：
 * 1. 读取 user-im 凭证
 * 2. 创建 Bot 记录
 * 3. 写入 Bot 凭证文件
 * 4. 删除旧的 user-im 文件
 */
export async function migrateUserImToBot(
  userId: string,
  opts: { botName: string },
): Promise<MigrateResult> {
  const existing = getUserFeishuConfig(userId);
  if (!existing) {
    throw new Error(`no user-im config for user ${userId}`);
  }

  const bot = createBot({
    user_id: userId,
    name: opts.botName,
    channel: 'feishu',
  });

  saveBotFeishuConfig(bot.id, {
    appId: existing.appId,
    appSecret: existing.appSecret,
    enabled: existing.enabled ?? true,
  });

  // 删除旧的 user-im 配置文件
  const userImPath = path.join(DATA_DIR, 'config', 'user-im', userId, 'feishu.json');
  try {
    fs.unlinkSync(userImPath);
  } catch {
    // 文件不存在或其他 IO 错误：记录但不抛（Bot 已创建，可回头再删）
  }

  return { bot };
}
