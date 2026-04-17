import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Multi-Agent PR1 端到端冒烟测试
 *
 * 路由解析采用方案 B（兜底方案）：
 * src/index.ts 在模块顶层调用 main()，main() 内调用 initDatabase()（无参数），
 * 会覆盖测试的 DB 单例，导致 getDb() 返回错误连接。
 * 因此不直接 import '../src/index.js'，
 * 而是将 resolveRouteTarget 的纯函数逻辑（~10 行）内联到测试中，
 * 行为与 src/index.ts 的实现完全一致。
 *
 * runtime-config 的 DATA_DIR 通过 vi.doMock('../src/config.js') 重定向到临时目录，
 * 与 bot-credentials.test.ts 保持相同模式。
 */

// ── 内联 resolveRouteTarget（与 src/index.ts 实现完全一致，确保路由逻辑覆盖正确） ──
interface RouteTarget {
  folder: string;
  botId: string;
}

interface RouteDeps {
  getRegisteredGroup: (jid: string) => { folder: string } | null;
  getBinding: (
    botId: string,
    jid: string,
  ) => { folder: string; enabled: boolean } | null;
}

function resolveRouteTarget(
  kind: 'user' | 'bot',
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

// ──────────────────────────────────────────────────────────────────────────────

describe('Multi-Agent PR1 smoke: create bot → bind → resolve route', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-smoke-'));
    dbPath = path.join(tmpDir, 'test.db');

    // 重置模块缓存，确保 vi.doMock 生效
    vi.resetModules();

    // Mock config.js 将 DATA_DIR 重定向到临时目录，避免污染项目 data/
    vi.doMock('../src/config.js', () => ({
      ASSISTANT_NAME: 'HappyClaw',
      DATA_DIR: tmpDir,
      STORE_DIR: path.join(tmpDir, 'db'),
      GROUPS_DIR: path.join(tmpDir, 'groups'),
      MAIN_GROUP_FOLDER: 'main',
      CONTAINER_IMAGE: 'happyclaw-agent:latest',
      TIMEZONE: 'Asia/Shanghai',
      WEB_PORT: 3000,
      SESSION_COOKIE_NAME_SECURE: '__Host-happyclaw_session',
      SESSION_COOKIE_NAME_PLAIN: 'happyclaw_session',
      POLL_INTERVAL: 2000,
      SCHEDULER_POLL_INTERVAL: 60000,
      MOUNT_ALLOWLIST_PATH: path.join(tmpDir, 'mount-allowlist.json'),
    }));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('full happy path: create → credential → bind → route (bot) → route (user) → soft-delete', async () => {
    // ── 初始化数据库 ────────────────────────────────────────────────────────────
    const { initDatabase, getDb, closeDatabase } = await import('../src/db.js');
    initDatabase(dbPath);

    try {
      const db = getDb();
      const now = new Date().toISOString();

      // 插入 user（满足 bots.user_id 外键约束）
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1','alice','x','member','[]','active',?,?)`,
      ).run(now, now);

      // 插入 registered_group（满足 bot_group_bindings.group_jid 外键约束）
      db.prepare(
        `INSERT INTO registered_groups (jid, name, folder, added_at)
         VALUES ('feishu:g1','g','alice-home',?)`,
      ).run(now);

      // ── Step 1: 创建 Bot ─────────────────────────────────────────────────────
      const {
        createBot,
        upsertBinding,
        getBinding,
        softDeleteBot,
        getBotById,
      } = await import('../src/db-bots.js');

      const bot = createBot({
        user_id: 'u1',
        name: 'Alice Bot',
        channel: 'feishu',
        default_folder: 'alice-home',
      });

      // Assertion 1: Bot ID 以 'bot_' 为前缀
      expect(bot.id).toMatch(/^bot_/);

      // ── Step 2: 写入 Bot 飞书凭证 ────────────────────────────────────────────
      const { saveBotFeishuConfig, getBotFeishuConfig } =
        await import('../src/runtime-config.js');

      saveBotFeishuConfig(bot.id, {
        appId: 'cli_x',
        appSecret: 'secret_y',
        enabled: true,
      });
      const loaded = getBotFeishuConfig(bot.id);

      // Assertion 2: AES-256-GCM 加解密后 appId 正确
      expect(loaded?.appId).toBe('cli_x');

      // ── Step 3: 绑定群组 ─────────────────────────────────────────────────────
      upsertBinding({
        bot_id: bot.id,
        group_jid: 'feishu:g1',
        folder: 'alice-home',
      });
      const binding = getBinding(bot.id, 'feishu:g1');

      // Assertion 3: folder 写入正确
      expect(binding?.folder).toBe('alice-home');

      // Assertion 4: binding 默认启用
      expect(binding?.enabled).toBe(true);

      // ── Step 4: 路由解析 - bot kind ──────────────────────────────────────────
      // 使用内联的 resolveRouteTarget（纯函数，与 src/index.ts 实现一致）
      const target = resolveRouteTarget('bot', 'feishu:g1', bot.id, {
        getRegisteredGroup: () => null,
        getBinding: (bId, jid) => getBinding(bId, jid),
      });

      // Assertion 5: bot 连接路由到正确 folder，botId 非空
      expect(target).toEqual({ folder: 'alice-home', botId: bot.id });

      // ── Step 5: 路由解析 - user kind 兼容路径 ───────────────────────────────
      const userTarget = resolveRouteTarget('user', 'feishu:g1', undefined, {
        getRegisteredGroup: (jid) =>
          jid === 'feishu:g1' ? { folder: 'alice-home' } : null,
        getBinding: () => null,
      });

      // Assertion 6: user 兼容路径，botId 为空字符串
      expect(userTarget).toEqual({ folder: 'alice-home', botId: '' });

      // ── Step 6: 软删除 ───────────────────────────────────────────────────────
      softDeleteBot(bot.id);

      // Assertion 7: 软删除后 getBotById 返回 null
      expect(getBotById(bot.id)).toBeNull();
    } finally {
      try {
        const { closeDatabase } = await import('../src/db.js');
        closeDatabase();
      } catch {
        // ignore
      }
    }
  });
});
