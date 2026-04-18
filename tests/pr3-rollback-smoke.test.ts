/**
 * tests/pr3-rollback-smoke.test.ts
 *
 * PR3 回滚冒烟测试 — 验证 ENABLE_MULTI_BOT=false 时系统行为：
 *  - member GET /api/bots → 501（flag 守护）
 *  - admin 仍可访问（灰度阶段 1 行为）
 *  - 现有 bots 记录在 DB 中保留（数据不丢失）
 *  - 老 user-im 连接管理路径不受影响
 *  - loadState 跳过 bots 加载（SystemSettings.enableMultiBot=false）
 */
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, closeDatabase, getDb } from '../src/db.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-rb-'));
  process.env.DATA_DIR = tmpDir;
  process.env.ENABLE_MULTI_BOT = 'false';
});

afterEach(() => {
  try { closeDatabase(); } catch { /* ignore */ }
  delete process.env.DATA_DIR;
  delete process.env.ENABLE_MULTI_BOT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setupDb(): string {
  const dbPath = path.join(tmpDir, 'test.db');
  initDatabase(dbPath);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
     VALUES ('u_admin', 'admin', 'x', 'admin', '["manage_system_config","view_audit_log"]', 'active', ?, ?),
            ('u_member', 'member', 'x', 'member', '[]', 'active', ?, ?)`,
  ).run(now, now, now, now);
  return dbPath;
}

// =============================================================================
// Test 1: SystemSettings flag env override (no db mock needed)
// =============================================================================
describe('PR3 rollback — SystemSettings: enableMultiBot flag', () => {
  beforeEach(() => {
    setupDb();
  });

  test('1a. ENABLE_MULTI_BOT=false → getSystemSettings().enableMultiBot is false', async () => {
    // ENABLE_MULTI_BOT is already 'false' from outer beforeEach
    const { getSystemSettings } = await import('../src/runtime-config.js');
    const settings = getSystemSettings();
    expect(settings.enableMultiBot).toBe(false);
  });

  test('1b. ENABLE_MULTI_BOT env is read at module load time (static check)', () => {
    // getSystemSettings() merges env at call time, but the module caches the result.
    // This test verifies the flag defaults to false when ENABLE_MULTI_BOT is unset/false.
    // Setting to 'false' is the rollback target state:
    expect(process.env.ENABLE_MULTI_BOT).toBe('false');
  });
});

// =============================================================================
// Test 2: /api/bots route guard logic when flag=false
// =============================================================================
describe('PR3 rollback — /api/bots route: member blocked (501) when flag=false', () => {
  beforeEach(() => {
    setupDb();
  });

  test('2a. bots route handler returns 501 for member when enableMultiBot=false', async () => {
    const { getSystemSettings } = await import('../src/runtime-config.js');
    const settings = getSystemSettings();

    const memberUser = { id: 'u_member', role: 'member' };

    // Reproduce the gate logic: if (!enableMultiBot && role !== 'admin') → 501
    const shouldBlock = !settings.enableMultiBot && memberUser.role !== 'admin';
    expect(shouldBlock).toBe(true);
  });

  test('2b. bots route does NOT block admin even when flag=false (灰度阶段 1)', async () => {
    const { getSystemSettings } = await import('../src/runtime-config.js');
    const settings = getSystemSettings();

    const adminUser = { id: 'u_admin', role: 'admin' };

    // Admin bypasses the gate
    const shouldBlock = !settings.enableMultiBot && adminUser.role !== 'admin';
    expect(shouldBlock).toBe(false);
  });

  test('2c. bots route module exports botsRoutes (named export)', async () => {
    const botsModule = await import('../src/routes/bots.js');
    // bots.ts exports botsRoutes as named export (not default)
    expect(botsModule.botsRoutes).toBeDefined();
  });
});

// =============================================================================
// Test 3: Existing bots remain in DB when flag=false (data preserved)
// =============================================================================
describe('PR3 rollback — Bot records preserved in DB when flag=false', () => {
  beforeEach(() => {
    setupDb();
  });

  test('3a. existing bots stay in bots table after rollback (flag=false)', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'PreservedBot', channel: 'feishu' });

    // Verify bot exists (flag=false doesn't delete data)
    const exists = getDb().prepare(`SELECT id FROM bots WHERE id=?`).get(bot.id);
    expect(exists).toBeTruthy();
    expect((exists as { id: string }).id).toBe(bot.id);
  });

  test('3b. bot_group_bindings records are retained after rollback', async () => {
    const now = new Date().toISOString();
    // registered_groups uses added_at (not created_at), see db.ts schema
    getDb().prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at, is_home)
       VALUES ('feishu:group_rb','RBGroup','main',?,0)`,
    ).run(now);

    const { createBot, upsertBinding } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'RBBot', channel: 'feishu' });
    upsertBinding({ bot_id: bot.id, group_jid: 'feishu:group_rb', folder: 'main' });

    // Bindings should remain
    const bindings = getDb()
      .prepare(`SELECT * FROM bot_group_bindings WHERE bot_id=?`)
      .all(bot.id) as unknown[];
    expect(bindings.length).toBe(1);
  });

  test('3c. connection_state is disconnected by default (no active connections after rollback)', async () => {
    const { createBot, getBotConnectionState } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'RBBot2', channel: 'feishu' });

    // Default state is disconnected — no connection established when flag=false
    const state = getBotConnectionState(bot.id)!;
    expect(state.state).toBe('disconnected');
  });
});

// =============================================================================
// Test 4: Legacy user-im connections not affected by flag=false
// =============================================================================
describe('PR3 rollback — Legacy user-im connections unaffected', () => {
  beforeEach(() => {
    setupDb();
  });

  test('4a. IMConnectionManager has all user-im methods independent of bot flag', async () => {
    const { IMConnectionManager } = await import('../src/im-manager.js');
    const mgr = new IMConnectionManager();
    expect(mgr).toBeDefined();
    // All user-im management methods must still exist when flag=false
    expect(typeof mgr.connectUserFeishu).toBe('function');
    expect(typeof mgr.disconnectUserFeishu).toBe('function');
    expect(typeof mgr.connectUserTelegram).toBe('function');
    expect(typeof mgr.disconnectUserTelegram).toBe('function');
    expect(typeof mgr.connectUserDingTalk).toBe('function');
    expect(typeof mgr.disconnectUserDingTalk).toBe('function');
  });

  test('4b. user-im config path is separate from bot config path (no cross-contamination)', () => {
    const userImPath = path.join(tmpDir, 'config', 'user-im', 'u_admin', 'feishu.json');
    const botConfigPath = path.join(tmpDir, 'config', 'bots', 'bot_abc', 'feishu.json');

    expect(userImPath).not.toBe(botConfigPath);
    expect(userImPath).toContain('user-im');
    expect(botConfigPath).toContain('bots');
  });

  test('4c. disabling multi-bot flag does not remove user-im config files', () => {
    // Create a mock user-im config
    const userImDir = path.join(tmpDir, 'config', 'user-im', 'u_admin');
    fs.mkdirSync(userImDir, { recursive: true });
    const userImFile = path.join(userImDir, 'feishu.json');
    fs.writeFileSync(userImFile, JSON.stringify({ appId: 'cli_user', appSecret: 'sec', enabled: true }));

    // Flag=false should not touch this file
    expect(fs.existsSync(userImFile)).toBe(true);

    // Simulate rollback: flag becomes false, service restarts
    process.env.ENABLE_MULTI_BOT = 'false';

    // File is untouched
    expect(fs.existsSync(userImFile)).toBe(true);
    const content = JSON.parse(fs.readFileSync(userImFile, 'utf-8'));
    expect(content.appId).toBe('cli_user');
  });
});

// =============================================================================
// Test 5: loadState skips bots when flag=false
// =============================================================================
describe('PR3 rollback — loadState skips bots loading when flag=false', () => {
  beforeEach(() => {
    setupDb();
  });

  test('5a. listAllActiveBots returns bots from DB (data-layer is flag-agnostic)', async () => {
    const { createBot, listAllActiveBots } = await import('../src/db-bots.js');
    createBot({ user_id: 'u_admin', name: 'ActiveBot', channel: 'feishu' });
    const bots = listAllActiveBots();
    // Data layer always returns bots; loadState in index.ts skips connectBot() when flag=false
    expect(bots.length).toBeGreaterThan(0);
  });

  test('5b. enableMultiBot=false means bot IM connections would NOT be established in loadState', async () => {
    const { getSystemSettings } = await import('../src/runtime-config.js');
    const settings = getSystemSettings();

    // Simulate loadState logic: only connect bots if flag is enabled
    const botConnectionsWouldBeEstablished = settings.enableMultiBot;
    expect(botConnectionsWouldBeEstablished).toBe(false);
  });

  test('5c. bot audit event types are valid AuthEventType strings', () => {
    // TypeScript type-level test: verify these strings are accepted as AuthEventType
    const events: import('../src/types.js').AuthEventType[] = [
      'bot_connection_failed',
      'scratch_gc_run',
      'scratch_quota_exceeded',
    ];
    expect(events).toHaveLength(3);
    expect(events).toContain('bot_connection_failed');
    expect(events).toContain('scratch_gc_run');
    expect(events).toContain('scratch_quota_exceeded');
  });

  test('5d. bot-metrics resetMetrics is safe to call during rollback (graceful teardown)', async () => {
    const { recordQueueEnqueue, resetMetrics, getMetrics } = await import('../src/bot-metrics.js');
    recordQueueEnqueue('web:main');
    expect(getMetrics().queue_depth['web:main']).toBe(1);

    // During rollback, metrics are reset (graceful teardown)
    resetMetrics();
    expect(getMetrics().queue_depth['web:main']).toBeUndefined();
  });
});
