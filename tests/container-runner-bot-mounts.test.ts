import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('container-runner: bot mounts builder', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mnt-'));
    process.env.DATA_DIR = tmpDir;
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('buildBotMounts returns scratch + profile paths', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m = buildBotMounts({
      folder: 'alpha',
      botId: 'bot_abc12345',
      mode: 'advisor',
    });
    expect(m).not.toBeNull();
    expect(m!.scratchHost).toBe(path.join(tmpDir, 'scratch', 'alpha', 'bots', 'bot_abc12345'));
    expect(m!.profileHost).toBe(path.join(tmpDir, 'bot-profiles', 'bot_abc12345'));
    expect(m!.botMode).toBe('advisor');
    // 目录已创建
    expect(fs.existsSync(m!.scratchHost)).toBe(true);
    expect(fs.existsSync(m!.profileHost)).toBe(true);
    // advisor 模板已写入
    expect(fs.existsSync(path.join(m!.profileHost, 'CLAUDE.md'))).toBe(true);
  });

  test('buildBotMounts returns null when botId empty (PR1 legacy path)', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m = buildBotMounts({
      folder: 'alpha',
      botId: '',
      mode: 'writer',
    });
    expect(m).toBeNull();
  });

  test('buildBotMounts writes writer template for writer mode', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m = buildBotMounts({
      folder: 'alpha',
      botId: 'bot_xyz12345',
      mode: 'writer',
    });
    expect(m).not.toBeNull();
    const content = fs.readFileSync(path.join(m!.profileHost, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('advisor');
    expect(content).toContain('协作准则');
  });

  test('buildBotMounts advisor template contains scratch path reference', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m = buildBotMounts({
      folder: 'beta',
      botId: 'bot_review99',
      mode: 'advisor',
    });
    expect(m).not.toBeNull();
    const content = fs.readFileSync(path.join(m!.profileHost, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('advisor');
    expect(content).toContain('/workspace/scratch');
  });

  test('buildBotMounts scratch path is per-folder per-botId', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m1 = buildBotMounts({ folder: 'folder1', botId: 'bot_aaa11111', mode: 'writer' });
    const m2 = buildBotMounts({ folder: 'folder2', botId: 'bot_bbb22222', mode: 'writer' });
    expect(m1!.scratchHost).not.toBe(m2!.scratchHost);
    expect(m1!.scratchHost).toContain('folder1');
    expect(m2!.scratchHost).toContain('folder2');
    expect(m1!.scratchHost).toContain('bot_aaa11111');
    expect(m2!.scratchHost).toContain('bot_bbb22222');
  });

  test('buildBotMounts second call does not overwrite existing profile', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const botId = 'bot_persist1';
    // 第一次调用写 advisor 模板
    buildBotMounts({ folder: 'main', botId, mode: 'advisor' });
    const file = path.join(tmpDir, 'bot-profiles', botId, 'CLAUDE.md');
    const firstContent = fs.readFileSync(file, 'utf-8');
    // 第二次调用（writer 模式）不应覆盖
    buildBotMounts({ folder: 'main', botId, mode: 'writer' });
    const secondContent = fs.readFileSync(file, 'utf-8');
    expect(secondContent).toBe(firstContent);
  });
});
