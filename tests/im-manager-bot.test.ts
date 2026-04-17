import { describe, expect, test, beforeEach, vi } from 'vitest';

// mock feishu connection factory
const mockConnect = vi.fn().mockResolvedValue(true);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockFeishuChannel = {
  channelType: 'feishu',
  connect: mockConnect,
  disconnect: mockDisconnect,
  sendMessage: vi.fn(),
  sendReaction: vi.fn(),
  clearAckReaction: vi.fn(),
  setTyping: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
};

vi.mock('../src/im-channel.js', async () => {
  const actual = await vi.importActual<typeof import('../src/im-channel.js')>(
    '../src/im-channel.js',
  );
  return {
    ...actual,
    createFeishuChannel: vi.fn(() => mockFeishuChannel),
  };
});

describe('IMConnectionManager: bot connections', () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    vi.resetModules();
  });

  test('connectBot creates a new BotConnection and registers it', async () => {
    const { IMConnectionManager } = await import('../src/im-manager.js');
    const mgr = new IMConnectionManager();
    await mgr.connectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'secret_y' },
      callbacks: {},
    });
    expect(mgr.hasBotConnection('bot_a')).toBe(true);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('disconnectBot stops the connection and removes it', async () => {
    const { IMConnectionManager } = await import('../src/im-manager.js');
    const mgr = new IMConnectionManager();
    await mgr.connectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'secret_y' },
      callbacks: {},
    });
    await mgr.disconnectBot('bot_a');
    expect(mgr.hasBotConnection('bot_a')).toBe(false);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  test('reconnectBot stops old connection and creates new one with ignoreMessagesBefore', async () => {
    const { IMConnectionManager } = await import('../src/im-manager.js');
    const mgr = new IMConnectionManager();
    await mgr.connectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'old' },
      callbacks: {},
    });
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    await mgr.reconnectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'new' },
      callbacks: {},
    });
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    // 最近一次 connect 应携带 ignoreMessagesBefore
    const callArgs = mockConnect.mock.calls[0][0];
    expect(callArgs.ignoreMessagesBefore).toBeGreaterThan(0);
  });
});
