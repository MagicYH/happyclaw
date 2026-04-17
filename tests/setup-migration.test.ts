import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We mock config.js at top level and update DATA_DIR per test via beforeEach
// by using a module-level variable that the mock factory captures.
let mockDataDir = '';

vi.mock('../src/config.js', () => ({
  get DATA_DIR() {
    return mockDataDir;
  },
  ASSISTANT_NAME: 'HappyClaw',
}));

// Import db after mock so db.js uses mocked config if needed
import { initDatabase, getDb, closeDatabase } from '../src/db.js';

describe('migrateUserImToBot', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-migrate-'));
    dbPath = path.join(tmpDir, 'test.db');
    mockDataDir = tmpDir;

    // Initialize a fresh DB for each test
    initDatabase(dbPath);
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1','alice','x','member','[]','active',?,?)`,
      )
      .run(now, now);
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('migrates user Feishu config to a new Bot', async () => {
    const { saveUserFeishuConfig } = await import('../src/runtime-config.js');
    saveUserFeishuConfig('u1', { appId: 'cli_x', appSecret: 'secret_y', enabled: true });

    const { migrateUserImToBot } = await import('../src/setup-migration.js');
    const result = await migrateUserImToBot('u1', { botName: 'My Migrated Bot' });

    expect(result.bot.channel).toBe('feishu');
    expect(result.bot.name).toBe('My Migrated Bot');
    // 凭证文件应存在于 bot 路径
    expect(
      fs.existsSync(path.join(tmpDir, 'config', 'bots', result.bot.id, 'feishu.json')),
    ).toBe(true);
    // 老文件应被删除
    expect(
      fs.existsSync(path.join(tmpDir, 'config', 'user-im', 'u1', 'feishu.json')),
    ).toBe(false);

    // 读回凭证应匹配
    const { getBotFeishuConfig } = await import('../src/runtime-config.js');
    const loaded = getBotFeishuConfig(result.bot.id);
    expect(loaded?.appId).toBe('cli_x');
    expect(loaded?.appSecret).toBe('secret_y');
  });

  test('returns error when user has no user-im config', async () => {
    const { migrateUserImToBot } = await import('../src/setup-migration.js');
    await expect(migrateUserImToBot('u1', { botName: 'X' })).rejects.toThrow(/no user-im config/i);
  });
});
