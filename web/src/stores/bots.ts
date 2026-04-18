import { create } from 'zustand';
import { api } from '../api/client';
import { wsManager } from '../api/ws';

export type BotConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'reconnecting'
  | 'disabled';

export type BotConcurrencyMode = 'writer' | 'advisor';
export type BotActivationMode = 'when_mentioned' | 'always' | 'manual';

export interface Bot {
  id: string;
  user_id: string;
  channel: 'feishu';
  name: string;
  default_folder: string | null;
  activation_mode: BotActivationMode;
  concurrency_mode: BotConcurrencyMode;
  status: 'active' | 'inactive';
  deleted_at: string | null;
  open_id: string | null;
  remote_name: string | null;
  created_at: string;
  updated_at: string;
  connection_state: BotConnectionState;
  last_connected_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
}

export interface BotCreateInput {
  name: string;
  channel: 'feishu';
  default_folder?: string;
  activation_mode?: BotActivationMode;
  concurrency_mode?: BotConcurrencyMode;
  app_id?: string;
  app_secret?: string;
}

export interface BotBinding {
  group_jid: string;
  folder: string;
}

export interface BotProfile {
  content: string;
  mode: BotConcurrencyMode;
}

export interface BotConnectionStatusMsg {
  bot_id: string;
  state: BotConnectionState;
  last_connected_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
}

interface BotsState {
  bots: Bot[];
  loading: boolean;
  error: string | null;
  saving: boolean;

  loadBots: () => Promise<void>;
  createBot: (input: BotCreateInput) => Promise<Bot>;
  updateBot: (id: string, patch: Partial<Pick<Bot, 'name' | 'default_folder' | 'activation_mode' | 'concurrency_mode'>>) => Promise<void>;
  updateCredentials: (id: string, appId: string, appSecret: string) => Promise<void>;
  enableBot: (id: string) => Promise<void>;
  disableBot: (id: string) => Promise<void>;
  deleteBot: (id: string) => Promise<void>;
  testConnection: (id: string) => Promise<{ ok: boolean; error?: string }>;
  getProfile: (id: string) => Promise<BotProfile>;
  saveProfile: (id: string, content: string) => Promise<void>;
  getBindings: (id: string) => Promise<BotBinding[]>;
  listBindings: (id: string) => Promise<BotBinding[]>;
  addBinding: (id: string, groupJid: string) => Promise<void>;
  removeBinding: (id: string, groupJid: string) => Promise<void>;
  readProfile: (id: string) => Promise<BotProfile>;
  writeProfile: (id: string, content: string) => Promise<void>;

  /** WebSocket 推送入口，供 wsManager 调用 */
  applyConnectionStatus: (msg: BotConnectionStatusMsg) => void;
}

export const useBotsStore = create<BotsState>((set, get) => ({
  bots: [],
  loading: false,
  error: null,
  saving: false,

  loadBots: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ bots: Bot[] }>('/api/bots');
      set({ bots: data.bots, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  createBot: async (input) => {
    set({ saving: true, error: null });
    try {
      const data = await api.post<{ bot: Bot }>('/api/bots', input);
      set((s) => ({ bots: [...s.bots, data.bot], saving: false }));
      return data.bot;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '创建失败';
      set({ saving: false, error: msg });
      throw err;
    }
  },

  updateBot: async (id, patch) => {
    await api.put(`/api/bots/${encodeURIComponent(id)}`, patch);
    await get().loadBots();
  },

  updateCredentials: async (id, appId, appSecret) => {
    await api.put(`/api/bots/${encodeURIComponent(id)}/credentials`, {
      app_id: appId,
      app_secret: appSecret,
    });
    await get().loadBots();
  },

  enableBot: async (id) => {
    await api.post(`/api/bots/${encodeURIComponent(id)}/enable`);
    await get().loadBots();
  },

  disableBot: async (id) => {
    await api.post(`/api/bots/${encodeURIComponent(id)}/disable`);
    await get().loadBots();
  },

  deleteBot: async (id) => {
    await api.delete(`/api/bots/${encodeURIComponent(id)}`);
    set((s) => ({ bots: s.bots.filter((b) => b.id !== id) }));
  },

  testConnection: async (id) => {
    return api.post<{ ok: boolean; error?: string }>(
      `/api/bots/${encodeURIComponent(id)}/test-connection`,
      {},
      15_000,
    );
  },

  getProfile: async (id) => {
    return api.get<BotProfile>(`/api/bots/${encodeURIComponent(id)}/profile`);
  },

  saveProfile: async (id, content) => {
    await api.put(`/api/bots/${encodeURIComponent(id)}/profile`, { content });
  },

  readProfile: async (id) => {
    return api.get<BotProfile>(`/api/bots/${encodeURIComponent(id)}/profile`);
  },

  writeProfile: async (id, content) => {
    await api.put(`/api/bots/${encodeURIComponent(id)}/profile`, { content });
  },

  getBindings: async (id) => {
    const data = await api.get<{ bindings: BotBinding[] }>(
      `/api/bots/${encodeURIComponent(id)}/bindings`,
    );
    return data.bindings;
  },

  listBindings: async (id) => {
    const data = await api.get<{ bindings: BotBinding[] }>(
      `/api/bots/${encodeURIComponent(id)}/bindings`,
    );
    return data.bindings;
  },

  addBinding: async (id, groupJid) => {
    await api.post(`/api/bots/${encodeURIComponent(id)}/bindings`, { group_jid: groupJid });
  },

  removeBinding: async (id, groupJid) => {
    await api.delete(
      `/api/bots/${encodeURIComponent(id)}/bindings/${encodeURIComponent(groupJid)}`,
    );
  },

  applyConnectionStatus: (msg) => {
    set((s) => ({
      bots: s.bots.map((b) =>
        b.id === msg.bot_id
          ? {
              ...b,
              connection_state: msg.state,
              last_connected_at: msg.last_connected_at,
              consecutive_failures: msg.consecutive_failures,
              last_error_code: msg.last_error_code,
            }
          : b,
      ),
    }));
  },
}));

// 订阅 WebSocket bot_connection_status 事件，实时更新连接状态
wsManager.on('bot_connection_status', (data: BotConnectionStatusMsg) => {
  useBotsStore.getState().applyConnectionStatus(data);
});
