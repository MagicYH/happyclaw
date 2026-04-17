import { describe, expect, test, vi } from 'vitest';
import type { Bot } from '../src/types.js';

describe('loadBotConnections', () => {
  test('skips bots without feishu config', async () => {
    const { loadBotConnections } = await import('../src/index.js');
    const connectBot = vi.fn();
    const bots: Bot[] = [
      {
        id: 'bot_a',
        user_id: 'u1',
        channel: 'feishu',
        name: 'A',
        default_folder: null,
        activation_mode: 'when_mentioned',
        concurrency_mode: 'writer',
        status: 'active',
        deleted_at: null,
        open_id: null,
        remote_name: null,
        created_at: '2026-04-17T00:00:00Z',
        updated_at: '2026-04-17T00:00:00Z',
      },
    ];
    await loadBotConnections(bots, {
      getBotFeishuConfig: () => null,
      connectBot,
    });
    expect(connectBot).not.toHaveBeenCalled();
  });

  test('connects each bot with valid feishu config', async () => {
    const { loadBotConnections } = await import('../src/index.js');
    const connectBot = vi.fn().mockResolvedValue(true);
    const bots: Bot[] = [
      {
        id: 'bot_a',
        user_id: 'u1',
        channel: 'feishu',
        name: 'A',
        default_folder: null,
        activation_mode: 'when_mentioned',
        concurrency_mode: 'writer',
        status: 'active',
        deleted_at: null,
        open_id: null,
        remote_name: null,
        created_at: '2026-04-17T00:00:00Z',
        updated_at: '2026-04-17T00:00:00Z',
      },
    ];
    await loadBotConnections(bots, {
      getBotFeishuConfig: (id: string) =>
        id === 'bot_a' ? { appId: 'cli_x', appSecret: 'y', enabled: true } : null,
      connectBot,
    });
    expect(connectBot).toHaveBeenCalledWith({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'y' },
    });
  });

  test('skips disabled bots', async () => {
    const { loadBotConnections } = await import('../src/index.js');
    const connectBot = vi.fn();
    await loadBotConnections(
      [
        {
          id: 'bot_a',
          user_id: 'u1',
          channel: 'feishu',
          name: 'A',
          default_folder: null,
          activation_mode: 'when_mentioned',
          concurrency_mode: 'writer',
          status: 'disabled',
          deleted_at: null,
          open_id: null,
          remote_name: null,
          created_at: '2026-04-17T00:00:00Z',
          updated_at: '2026-04-17T00:00:00Z',
        },
      ],
      { getBotFeishuConfig: () => ({ appId: 'x', appSecret: 'y', enabled: true }), connectBot },
    );
    expect(connectBot).not.toHaveBeenCalled();
  });
});
