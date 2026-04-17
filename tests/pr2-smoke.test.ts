/**
 * PR2 端到端冒烟测试
 *
 * 验证 advisor Bot 的完整启动链路：
 * 1. buildBotMounts 创建 scratch + bot-profile 目录
 * 2. buildHooksConfig + resolveBotModeFromEnv 在 advisor 模式注册 PreToolUse
 * 3. 模拟 PreToolUse Hook 接收 Write 到项目目录 → deny
 * 4. writer Bot 不注册 PreToolUse
 *
 * 覆盖测试用例：E2E-04（目录创建）、E2E-05（Hook 拦截真实 Write）
 */
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('PR2 smoke: advisor bot end-to-end glue', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr2-smoke-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // 清理数据库单例（如果已初始化）
    try {
      const { closeDatabase } = await import('../src/db.js');
      closeDatabase();
    } catch {
      // 若本 test 未初始化数据库则忽略
    }
  });

  test('advisor bot: profile created, mounts built, hook registered, Write denied, writer no hook', async () => {
    // --- 初始化数据库 ---
    const { initDatabase, getDb } = await import('../src/db.js');
    initDatabase(path.join(tmpDir, 'test.db'));
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1','alice','x','member','[]','active',?,?)`,
      )
      .run(now, now);

    // --- 创建 advisor bot ---
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({
      user_id: 'u1',
      name: 'Reviewer',
      channel: 'feishu',
      concurrency_mode: 'advisor',
    });

    // === Assert 1: buildBotMounts 创建 scratch + bot-profile 目录 ===
    const { buildBotMounts } = await import('../src/container-runner.js');
    const mounts = buildBotMounts({
      folder: 'main',
      botId: bot.id,
      mode: 'advisor',
    });
    expect(mounts).not.toBeNull();
    expect(fs.existsSync(mounts!.scratchHost)).toBe(true);
    expect(fs.existsSync(path.join(mounts!.profileHost, 'CLAUDE.md'))).toBe(true);
    // advisor 模板包含 advisor 关键词
    const profileContent = fs.readFileSync(
      path.join(mounts!.profileHost, 'CLAUDE.md'),
      'utf-8',
    );
    expect(profileContent).toContain('advisor');
    expect(profileContent).toContain('/workspace/scratch');

    // === Assert 2: resolveBotModeFromEnv + buildHooksConfig 在 advisor 模式注册 PreToolUse ===
    const { buildHooksConfig, resolveBotModeFromEnv } = await import(
      '../container/agent-runner/src/index.js'
    );
    const mode = resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: mounts!.botMode });
    expect(mode).toBe('advisor');

    const hooks = buildHooksConfig({
      botMode: mode,
      projectRoot: '/workspace/group',
      preCompactHook: async () => ({}),
    });
    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreCompact).toBeDefined();

    // === Assert 3: 模拟 PreToolUse Hook 接收 Write 到项目目录 → deny ===
    const preHook = hooks.PreToolUse![0].hooks[0];

    // Write 到项目目录 → deny
    const denyResult = await preHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/workspace/group/src/a.ts', content: 'x' },
        tool_use_id: 't1',
        cwd: '/workspace/group',
      } as any,
      'session',
      {} as any,
    );
    expect((denyResult as any).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((denyResult as any).hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect((denyResult as any).hookSpecificOutput.permissionDecisionReason).toMatch(
      /禁止写入项目目录/,
    );

    // Write 到 scratch → allow（返回空对象 {}）
    const allowResult = await preHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/workspace/scratch/report.md', content: 'ok' },
        tool_use_id: 't2',
        cwd: '/workspace/group',
      } as any,
      'session',
      {} as any,
    );
    // allow 时 hook 返回 {} 或无 hookSpecificOutput
    expect(
      (allowResult as any).hookSpecificOutput?.permissionDecision ?? 'allow',
    ).toBe('allow');

    // === Assert 4: writer Bot 不注册 PreToolUse ===
    const writerBot = createBot({
      user_id: 'u1',
      name: 'Coder',
      channel: 'feishu',
      concurrency_mode: 'writer',
    });
    const writerMounts = buildBotMounts({
      folder: 'main',
      botId: writerBot.id,
      mode: 'writer',
    });
    expect(writerMounts).not.toBeNull();
    // writer 模板不含 advisor 关键词
    const writerProfile = fs.readFileSync(
      path.join(writerMounts!.profileHost, 'CLAUDE.md'),
      'utf-8',
    );
    expect(writerProfile).not.toContain('advisor');
    expect(writerProfile).toContain('协作准则');

    const writerMode = resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: writerMounts!.botMode });
    expect(writerMode).toBe('writer');

    const writerHooks = buildHooksConfig({
      botMode: writerMode,
      projectRoot: '/workspace/group',
      preCompactHook: async () => ({}),
    });
    // writer 不注册 PreToolUse
    expect(writerHooks.PreToolUse).toBeUndefined();
    // PreCompact 仍然存在
    expect(writerHooks.PreCompact).toBeDefined();
  });
});
