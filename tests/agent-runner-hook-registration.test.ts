// tests/agent-runner-hook-registration.test.ts
import { describe, expect, test, vi } from 'vitest';

describe('agent-runner: advisor hook registration', () => {
  test('buildHooksConfig returns PreToolUse hook only in advisor mode', async () => {
    const { buildHooksConfig } = await import(
      '../container/agent-runner/src/index.js'
    );
    const writer = buildHooksConfig({
      botMode: 'writer',
      projectRoot: '/workspace/group',
      preCompactHook: vi.fn(),
    });
    expect(writer.PreToolUse).toBeUndefined();
    expect(writer.PreCompact).toBeDefined();

    const advisor = buildHooksConfig({
      botMode: 'advisor',
      projectRoot: '/workspace/group',
      preCompactHook: vi.fn(),
    });
    expect(advisor.PreToolUse).toBeDefined();
    expect(advisor.PreToolUse).toHaveLength(1);
    expect(advisor.PreCompact).toBeDefined();
  });

  test('resolveBotModeFromEnv reads HAPPYCLAW_BOT_MODE or defaults to writer', async () => {
    const { resolveBotModeFromEnv } = await import(
      '../container/agent-runner/src/index.js'
    );
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: 'advisor' })).toBe('advisor');
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: 'writer' })).toBe('writer');
    expect(resolveBotModeFromEnv({})).toBe('writer');
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: 'bogus' })).toBe('writer');
  });

  // Additional edge cases (UT-44~UT-51 coverage)
  test('resolveBotModeFromEnv: empty string defaults to writer', async () => {
    const { resolveBotModeFromEnv } = await import(
      '../container/agent-runner/src/index.js'
    );
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: '' })).toBe('writer');
  });

  test('resolveBotModeFromEnv: undefined value defaults to writer', async () => {
    const { resolveBotModeFromEnv } = await import(
      '../container/agent-runner/src/index.js'
    );
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: undefined })).toBe('writer');
  });

  test('resolveBotModeFromEnv: numeric-like string defaults to writer', async () => {
    const { resolveBotModeFromEnv } = await import(
      '../container/agent-runner/src/index.js'
    );
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: '1' })).toBe('writer');
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: '0' })).toBe('writer');
  });

  test('buildHooksConfig writer mode: PreCompact defined, PreToolUse absent', async () => {
    const { buildHooksConfig } = await import(
      '../container/agent-runner/src/index.js'
    );
    const mockHook = vi.fn();
    const cfg = buildHooksConfig({
      botMode: 'writer',
      projectRoot: '/workspace/group',
      preCompactHook: mockHook,
    });
    expect(cfg.PreCompact).toBeDefined();
    expect(cfg.PreCompact).toHaveLength(1);
    expect((cfg.PreCompact as any)[0].hooks[0]).toBe(mockHook);
    expect(cfg.PreToolUse).toBeUndefined();
  });

  test('buildHooksConfig advisor mode: both PreCompact and PreToolUse defined', async () => {
    const { buildHooksConfig } = await import(
      '../container/agent-runner/src/index.js'
    );
    const mockHook = vi.fn();
    const cfg = buildHooksConfig({
      botMode: 'advisor',
      projectRoot: '/workspace/group',
      preCompactHook: mockHook,
    });
    expect(cfg.PreCompact).toBeDefined();
    expect(cfg.PreCompact).toHaveLength(1);
    expect(cfg.PreToolUse).toBeDefined();
    expect(cfg.PreToolUse).toHaveLength(1);
  });

  test('buildHooksConfig advisor PreToolUse hook: denies Write to project root', async () => {
    const { buildHooksConfig } = await import(
      '../container/agent-runner/src/index.js'
    );
    const cfg = buildHooksConfig({
      botMode: 'advisor',
      projectRoot: '/workspace/group',
      preCompactHook: vi.fn(),
    });
    const preToolUseHook = (cfg.PreToolUse as any)[0].hooks[0];
    const result = await preToolUseHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/workspace/group/src/foo.ts', content: 'x' },
        tool_use_id: 't1',
        cwd: '/workspace/group',
      } as any,
      'session',
      {} as any,
    );
    expect((result as any).hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('buildHooksConfig advisor PreToolUse hook: allows Write to scratch', async () => {
    const { buildHooksConfig } = await import(
      '../container/agent-runner/src/index.js'
    );
    const cfg = buildHooksConfig({
      botMode: 'advisor',
      projectRoot: '/workspace/group',
      preCompactHook: vi.fn(),
    });
    const preToolUseHook = (cfg.PreToolUse as any)[0].hooks[0];
    const result = await preToolUseHook(
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
    // allow returns empty object {}
    expect((result as any).hookSpecificOutput).toBeUndefined();
  });
});
