import { describe, expect, test, vi, beforeEach } from 'vitest';

describe('resolveRouteTarget: connection kind branching', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('user connection resolves folder from registered_groups', async () => {
    // 将路由解析抽为纯函数 resolveRouteTarget(kind, jid, botId?, deps)
    // 然后 mock deps.getRegisteredGroup / deps.getBinding
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget(
      'user',
      'feishu:g1',
      undefined,
      {
        getRegisteredGroup: (jid: string) =>
          jid === 'feishu:g1' ? ({ folder: 'folder-a' } as any) : null,
        getBinding: () => null,
      },
    );
    expect(result).toEqual({ folder: 'folder-a', botId: '' });
  });

  test('bot connection resolves folder from bot_group_bindings', async () => {
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget(
      'bot',
      'feishu:g1',
      'bot_a',
      {
        getRegisteredGroup: () => null,
        getBinding: (botId: string, jid: string) =>
          botId === 'bot_a' && jid === 'feishu:g1'
            ? ({ folder: 'folder-b', enabled: true } as any)
            : null,
      },
    );
    expect(result).toEqual({ folder: 'folder-b', botId: 'bot_a' });
  });

  test('bot connection returns null when binding is disabled', async () => {
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget(
      'bot',
      'feishu:g1',
      'bot_a',
      {
        getRegisteredGroup: () => null,
        getBinding: () => ({ folder: 'folder-b', enabled: false } as any),
      },
    );
    expect(result).toBeNull();
  });

  test('user connection returns null when registered_group not found', async () => {
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget('user', 'feishu:g1', undefined, {
      getRegisteredGroup: () => null,
      getBinding: () => null,
    });
    expect(result).toBeNull();
  });
});
