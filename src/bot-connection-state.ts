/**
 * Bot Connection State (PR3)
 *
 * 统一管理 Bot 连接状态写表 + WebSocket 广播 + 审计日志。
 * 设计：v3 §10.1。
 */
import { logger } from './logger.js';
import {
  updateBotConnectionState,
  getBotById,
  getBotConnectionState,
} from './db-bots.js';
import { logAuthEvent } from './db.js';
import type { BotConnectionState } from './types.js';

export interface ConnectionStateDeps {
  broadcast: (msg: {
    type: 'bot_connection_status';
    bot_id: string;
    user_id: string;
    state: BotConnectionState;
    last_connected_at: string | null;
    consecutive_failures: number;
    last_error_code: string | null;
  }) => void;
}

function broadcastCurrent(botId: string, deps: ConnectionStateDeps): void {
  const bot = getBotById(botId);
  const state = getBotConnectionState(botId);
  if (!bot || !state) return;
  deps.broadcast({
    type: 'bot_connection_status',
    bot_id: botId,
    user_id: bot.user_id,
    state: state.state,
    last_connected_at: state.last_connected_at,
    consecutive_failures: state.consecutive_failures,
    last_error_code: state.last_error_code,
  });
}

export function markConnecting(botId: string, deps: ConnectionStateDeps): void {
  updateBotConnectionState(botId, { state: 'connecting', lastErrorCode: null });
  broadcastCurrent(botId, deps);
}

export function markConnected(botId: string, deps: ConnectionStateDeps): void {
  updateBotConnectionState(botId, {
    state: 'connected',
    lastConnectedAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastErrorCode: null,
  });
  broadcastCurrent(botId, deps);
}

export function markFailed(
  botId: string,
  errorCode: string,
  deps: ConnectionStateDeps,
): void {
  const current = getBotConnectionState(botId);
  const newCount = (current?.consecutive_failures ?? 0) + 1;
  updateBotConnectionState(botId, {
    state: 'error',
    consecutiveFailures: newCount,
    lastErrorCode: errorCode,
  });
  broadcastCurrent(botId, deps);

  // 在连续失败到达 3 次时写一条审计（不是每次都写，避免刷爆）
  if (newCount === 3) {
    const bot = getBotById(botId);
    if (bot) {
      logAuthEvent({
        event_type: 'bot_connection_failed',
        username: bot.user_id,
        actor_username: 'system',
        details: {
          bot_id: botId,
          error_code: errorCode,
          consecutive: newCount,
        },
        ip_address: null,
        user_agent: null,
      });
      logger.warn(
        { botId, errorCode, consecutive: newCount },
        'Bot consecutive failures reached threshold',
      );
    }
  }
}

export function markReconnecting(
  botId: string,
  deps: ConnectionStateDeps,
): void {
  updateBotConnectionState(botId, { state: 'reconnecting' });
  broadcastCurrent(botId, deps);
}

export function markDisconnected(
  botId: string,
  deps: ConnectionStateDeps,
): void {
  updateBotConnectionState(botId, { state: 'disconnected' });
  broadcastCurrent(botId, deps);
}

export function markDisabled(botId: string, deps: ConnectionStateDeps): void {
  updateBotConnectionState(botId, {
    state: 'disabled',
    consecutiveFailures: 0,
  });
  broadcastCurrent(botId, deps);
}
