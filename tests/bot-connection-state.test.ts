import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('bot-connection-state', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcs-'));
    process.env.DATA_DIR = tmpDir;
  });
  afterEach(async () => {
    const { closeDatabase } = await import('../src/db.js');
    closeDatabase();
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setup() {
    const { initDatabase, getDb } = await import('../src/db.js');
    initDatabase(path.join(tmpDir, 'test.db'));
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1','alice','x','member','[]','active',?,?)`,
    ).run(now, now);
    const { createBot } = await import('../src/db-bots.js');
    return createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
  }

  test('markConnected writes state + timestamp + zeroes failures', async () => {
    const bot = await setup();
    const { markConnected } = await import('../src/bot-connection-state.js');
    const broadcast = vi.fn();
    markConnected(bot.id, { broadcast });
    const { getBotConnectionState } = await import('../src/db-bots.js');
    const state = getBotConnectionState(bot.id)!;
    expect(state.state).toBe('connected');
    expect(state.last_connected_at).toBeTruthy();
    expect(state.consecutive_failures).toBe(0);
    expect(broadcast).toHaveBeenCalledOnce();
  });

  test('markFailed increments consecutive_failures', async () => {
    const bot = await setup();
    const { markFailed } = await import('../src/bot-connection-state.js');
    const broadcast = vi.fn();
    markFailed(bot.id, 'AUTH_FAILED', { broadcast });
    markFailed(bot.id, 'AUTH_FAILED', { broadcast });
    const { getBotConnectionState } = await import('../src/db-bots.js');
    const state = (await import('../src/db-bots.js')).getBotConnectionState(bot.id)!;
    expect(state.consecutive_failures).toBe(2);
    expect(state.state).toBe('error');
    expect(state.last_error_code).toBe('AUTH_FAILED');
  });

  test('≥3 consecutive failures emits bot_connection_failed audit event', async () => {
    const bot = await setup();
    const { markFailed } = await import('../src/bot-connection-state.js');
    const broadcast = vi.fn();
    for (let i = 0; i < 3; i++) markFailed(bot.id, 'ERR', { broadcast });
    const { getDb } = await import('../src/db.js');
    const logs = getDb().prepare(
      `SELECT event_type FROM auth_audit_log WHERE event_type='bot_connection_failed'`,
    ).all() as Array<{ event_type: string }>;
    expect(logs.length).toBe(1);  // 只记一次（防刷爆）
  });

  test('markDisconnected resets to disconnected but keeps failure count', async () => {
    const bot = await setup();
    const { markFailed, markDisconnected } = await import('../src/bot-connection-state.js');
    const broadcast = vi.fn();
    markFailed(bot.id, 'ERR', { broadcast });
    markDisconnected(bot.id, { broadcast });
    const state = (await import('../src/db-bots.js')).getBotConnectionState(bot.id)!;
    expect(state.state).toBe('disconnected');
    expect(state.consecutive_failures).toBe(1);
  });
});
