/**
 * useBotsStore 单元测试
 *
 * 注意：此测试文件依赖 T4 web test harness（vitest + @testing-library/react + jsdom）。
 * 若 T4 尚未完成，本文件已写好但暂时无法跑通。
 * T4 完成后执行：npx vitest run web/src/stores/__tests__/bots.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useBotsStore } from '../bots';
import type { Bot, BotCreateInput, BotConnectionStatusMsg } from '../bots';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../api/ws', () => ({
  wsManager: {
    on: vi.fn(),
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(),
    setupNetworkListeners: vi.fn(),
  },
}));

import { api } from '../../api/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot_test0001',
    user_id: 'u1',
    channel: 'feishu',
    name: 'Test Bot',
    default_folder: null,
    activation_mode: 'when_mentioned',
    concurrency_mode: 'writer',
    status: 'active',
    deleted_at: null,
    open_id: null,
    remote_name: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    connection_state: 'disconnected',
    last_connected_at: null,
    consecutive_failures: 0,
    last_error_code: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useBotsStore', () => {
  beforeEach(() => {
    // 重置 store 状态
    useBotsStore.setState({ bots: [], loading: false, error: null, saving: false });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── loadBots ───────────────────────────────────────────────────────────────

  describe('loadBots', () => {
    it('成功时更新 bots 列表并清除 loading', async () => {
      const bots = [makeBot(), makeBot({ id: 'bot_test0002', name: 'Bot 2' })];
      vi.mocked(api.get).mockResolvedValueOnce({ bots });

      await useBotsStore.getState().loadBots();

      const state = useBotsStore.getState();
      expect(state.bots).toEqual(bots);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('失败时设置 error 并清除 loading', async () => {
      vi.mocked(api.get).mockRejectedValueOnce(new Error('Network error'));

      await useBotsStore.getState().loadBots();

      const state = useBotsStore.getState();
      expect(state.bots).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.error).toBe('Network error');
    });

    it('请求期间 loading 为 true', async () => {
      let resolve!: (v: unknown) => void;
      vi.mocked(api.get).mockReturnValueOnce(new Promise((r) => { resolve = r; }));

      const promise = useBotsStore.getState().loadBots();
      expect(useBotsStore.getState().loading).toBe(true);

      resolve({ bots: [] });
      await promise;
      expect(useBotsStore.getState().loading).toBe(false);
    });
  });

  // ─── createBot ──────────────────────────────────────────────────────────────

  describe('createBot', () => {
    it('成功时追加到 bots 并返回新 bot', async () => {
      const newBot = makeBot({ name: 'New Bot' });
      vi.mocked(api.post).mockResolvedValueOnce({ bot: newBot });

      const result = await useBotsStore.getState().createBot({
        name: 'New Bot',
        channel: 'feishu',
      } satisfies BotCreateInput);

      expect(result).toEqual(newBot);
      expect(useBotsStore.getState().bots).toContain(newBot);
      expect(useBotsStore.getState().saving).toBe(false);
    });

    it('失败时设置 error 并 rethrow', async () => {
      const err = new Error('创建失败');
      vi.mocked(api.post).mockRejectedValueOnce(err);

      await expect(
        useBotsStore.getState().createBot({ name: 'X', channel: 'feishu' }),
      ).rejects.toThrow('创建失败');

      expect(useBotsStore.getState().saving).toBe(false);
      expect(useBotsStore.getState().error).toBe('创建失败');
    });
  });

  // ─── enableBot / disableBot ──────────────────────────────────────────────────

  describe('enableBot / disableBot', () => {
    it('enableBot 调用正确端点并刷新列表', async () => {
      const bot = makeBot({ status: 'inactive' });
      useBotsStore.setState({ bots: [bot] });
      vi.mocked(api.post).mockResolvedValueOnce({});
      vi.mocked(api.get).mockResolvedValueOnce({ bots: [{ ...bot, status: 'active' }] });

      await useBotsStore.getState().enableBot(bot.id);

      expect(api.post).toHaveBeenCalledWith(`/api/bots/${bot.id}/enable`);
    });

    it('disableBot 调用正确端点并刷新列表', async () => {
      const bot = makeBot();
      useBotsStore.setState({ bots: [bot] });
      vi.mocked(api.post).mockResolvedValueOnce({});
      vi.mocked(api.get).mockResolvedValueOnce({ bots: [{ ...bot, status: 'inactive' }] });

      await useBotsStore.getState().disableBot(bot.id);

      expect(api.post).toHaveBeenCalledWith(`/api/bots/${bot.id}/disable`);
    });
  });

  // ─── deleteBot ───────────────────────────────────────────────────────────────

  describe('deleteBot', () => {
    it('成功时从 bots 数组中移除', async () => {
      const bot = makeBot();
      useBotsStore.setState({ bots: [bot] });
      vi.mocked(api.delete).mockResolvedValueOnce({});

      await useBotsStore.getState().deleteBot(bot.id);

      expect(useBotsStore.getState().bots).toHaveLength(0);
    });
  });

  // ─── updateCredentials ───────────────────────────────────────────────────────

  describe('updateCredentials', () => {
    it('调用正确端点并传递 app_id / app_secret', async () => {
      const bot = makeBot();
      useBotsStore.setState({ bots: [bot] });
      vi.mocked(api.put).mockResolvedValueOnce({});
      vi.mocked(api.get).mockResolvedValueOnce({ bots: [bot] });

      await useBotsStore.getState().updateCredentials(bot.id, 'cli_xxx', 'sec_yyy');

      expect(api.put).toHaveBeenCalledWith(
        `/api/bots/${bot.id}/credentials`,
        { app_id: 'cli_xxx', app_secret: 'sec_yyy' },
      );
    });
  });

  // ─── testConnection ──────────────────────────────────────────────────────────

  describe('testConnection', () => {
    it('返回 ok=true 时透传结果', async () => {
      vi.mocked(api.post).mockResolvedValueOnce({ ok: true });

      const result = await useBotsStore.getState().testConnection('bot_test0001');

      expect(result).toEqual({ ok: true });
      expect(api.post).toHaveBeenCalledWith(
        '/api/bots/bot_test0001/test-connection',
        {},
        15_000,
      );
    });

    it('返回 ok=false 时包含 error 字段', async () => {
      vi.mocked(api.post).mockResolvedValueOnce({ ok: false, error: 'AUTH_FAILED' });

      const result = await useBotsStore.getState().testConnection('bot_test0001');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('AUTH_FAILED');
    });
  });

  // ─── getProfile / saveProfile ────────────────────────────────────────────────

  describe('getProfile / saveProfile', () => {
    it('getProfile 返回 content 和 mode', async () => {
      vi.mocked(api.get).mockResolvedValueOnce({ content: '# Bot Profile', mode: 'writer' });

      const profile = await useBotsStore.getState().getProfile('bot_test0001');

      expect(profile.content).toBe('# Bot Profile');
      expect(profile.mode).toBe('writer');
    });

    it('saveProfile 调用 PUT 端点', async () => {
      vi.mocked(api.put).mockResolvedValueOnce({});

      await useBotsStore.getState().saveProfile('bot_test0001', '# Updated');

      expect(api.put).toHaveBeenCalledWith(
        '/api/bots/bot_test0001/profile',
        { content: '# Updated' },
      );
    });

    it('readProfile 与 getProfile 等价', async () => {
      vi.mocked(api.get).mockResolvedValueOnce({ content: '# Profile', mode: 'advisor' });

      const profile = await useBotsStore.getState().readProfile('bot_test0001');

      expect(api.get).toHaveBeenCalledWith('/api/bots/bot_test0001/profile');
      expect(profile.mode).toBe('advisor');
    });

    it('writeProfile 与 saveProfile 等价', async () => {
      vi.mocked(api.put).mockResolvedValueOnce({});

      await useBotsStore.getState().writeProfile('bot_test0001', '# New');

      expect(api.put).toHaveBeenCalledWith(
        '/api/bots/bot_test0001/profile',
        { content: '# New' },
      );
    });
  });

  // ─── listBindings / addBinding / removeBinding ───────────────────────────────

  describe('bindings', () => {
    it('listBindings 返回 bindings 数组', async () => {
      const bindings = [{ group_jid: 'feishu:grp_001', folder: 'main' }];
      vi.mocked(api.get).mockResolvedValueOnce({ bindings });

      const result = await useBotsStore.getState().listBindings('bot_test0001');

      expect(result).toEqual(bindings);
    });

    it('addBinding 调用 POST 端点', async () => {
      vi.mocked(api.post).mockResolvedValueOnce({});

      await useBotsStore.getState().addBinding('bot_test0001', 'feishu:grp_001');

      expect(api.post).toHaveBeenCalledWith(
        '/api/bots/bot_test0001/bindings',
        { group_jid: 'feishu:grp_001' },
      );
    });

    it('removeBinding 调用 DELETE 端点', async () => {
      vi.mocked(api.delete).mockResolvedValueOnce({});

      await useBotsStore.getState().removeBinding('bot_test0001', 'feishu:grp_001');

      expect(api.delete).toHaveBeenCalledWith(
        `/api/bots/bot_test0001/bindings/${encodeURIComponent('feishu:grp_001')}`,
      );
    });
  });

  // ─── applyConnectionStatus ───────────────────────────────────────────────────

  describe('applyConnectionStatus', () => {
    it('更新匹配 bot 的连接状态字段', () => {
      const bot = makeBot({ connection_state: 'disconnected' });
      useBotsStore.setState({ bots: [bot] });

      const msg: BotConnectionStatusMsg = {
        bot_id: bot.id,
        state: 'connected',
        last_connected_at: '2026-01-01T10:00:00.000Z',
        consecutive_failures: 0,
        last_error_code: null,
      };

      useBotsStore.getState().applyConnectionStatus(msg);

      const updated = useBotsStore.getState().bots[0];
      expect(updated.connection_state).toBe('connected');
      expect(updated.last_connected_at).toBe('2026-01-01T10:00:00.000Z');
      expect(updated.consecutive_failures).toBe(0);
    });

    it('不匹配的 bot_id 不修改其他 bot', () => {
      const bot = makeBot();
      const otherBot = makeBot({ id: 'bot_other001', connection_state: 'disconnected' });
      useBotsStore.setState({ bots: [bot, otherBot] });

      useBotsStore.getState().applyConnectionStatus({
        bot_id: bot.id,
        state: 'error',
        last_connected_at: null,
        consecutive_failures: 3,
        last_error_code: 'AUTH_FAILED',
      });

      // otherBot 不受影响
      expect(useBotsStore.getState().bots[1].connection_state).toBe('disconnected');
    });

    it('错误状态时保存 last_error_code', () => {
      const bot = makeBot();
      useBotsStore.setState({ bots: [bot] });

      useBotsStore.getState().applyConnectionStatus({
        bot_id: bot.id,
        state: 'error',
        last_connected_at: null,
        consecutive_failures: 2,
        last_error_code: 'NETWORK_TIMEOUT',
      });

      const updated = useBotsStore.getState().bots[0];
      expect(updated.last_error_code).toBe('NETWORK_TIMEOUT');
      expect(updated.consecutive_failures).toBe(2);
    });
  });
});
