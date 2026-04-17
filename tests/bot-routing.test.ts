import { describe, expect, test } from 'vitest';
import { resolveRouteTarget } from '../src/route-helpers.js';

// 直接 import 纯函数模块，不触发 index.ts 的 main()
describe('resolveRouteTarget: connection kind branching', () => {
  test('user connection resolves folder from registered_groups', () => {
    const result = resolveRouteTarget('user', 'feishu:g1', undefined, {
      getRegisteredGroup: (jid: string) =>
        jid === 'feishu:g1' ? ({ folder: 'folder-a' } as any) : null,
      getBinding: () => null,
    });
    expect(result).toEqual({ folder: 'folder-a', botId: '' });
  });

  test('bot connection resolves folder from bot_group_bindings', () => {
    const result = resolveRouteTarget('bot', 'feishu:g1', 'bot_a', {
      getRegisteredGroup: () => null,
      getBinding: (botId: string, jid: string) =>
        botId === 'bot_a' && jid === 'feishu:g1'
          ? ({ folder: 'folder-b', enabled: true } as any)
          : null,
    });
    expect(result).toEqual({ folder: 'folder-b', botId: 'bot_a' });
  });

  test('bot connection returns null when binding is disabled', () => {
    const result = resolveRouteTarget('bot', 'feishu:g1', 'bot_a', {
      getRegisteredGroup: () => null,
      getBinding: () => ({ folder: 'folder-b', enabled: false }) as any,
    });
    expect(result).toBeNull();
  });

  test('user connection returns null when registered_group not found', () => {
    const result = resolveRouteTarget('user', 'feishu:g1', undefined, {
      getRegisteredGroup: () => null,
      getBinding: () => null,
    });
    expect(result).toBeNull();
  });
});
