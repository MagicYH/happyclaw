import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Bot Feishu credentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-botcfg-'));
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      ASSISTANT_NAME: 'HappyClaw',
      DATA_DIR: tmpDir,
    }));
    vi.doMock('../src/db.js', () => ({}));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('saveBotFeishuConfig writes encrypted file with 0600 mode', async () => {
    const { saveBotFeishuConfig } = await import('../src/runtime-config.js');
    saveBotFeishuConfig('bot_a', { appId: 'cli_x', appSecret: 'secret_y', enabled: true });
    const filePath = path.join(tmpDir, 'config', 'bots', 'bot_a', 'feishu.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    // mode 0o600 在 POSIX 下严格相等；跨平台时使用 mask
    expect(stat.mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(filePath, 'utf-8');
    // 密文不应包含明文 secret
    expect(content).not.toContain('secret_y');
  });

  test('getBotFeishuConfig returns decrypted config after save', async () => {
    const { saveBotFeishuConfig, getBotFeishuConfig } = await import('../src/runtime-config.js');
    saveBotFeishuConfig('bot_a', { appId: 'cli_x', appSecret: 'secret_y', enabled: true });
    const loaded = getBotFeishuConfig('bot_a');
    expect(loaded?.appId).toBe('cli_x');
    expect(loaded?.appSecret).toBe('secret_y');
    expect(loaded?.enabled).toBe(true);
  });

  test('getBotFeishuConfig returns null for unknown bot', async () => {
    const { getBotFeishuConfig } = await import('../src/runtime-config.js');
    expect(getBotFeishuConfig('bot_missing')).toBeNull();
  });
});
