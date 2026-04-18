/**
 * tests/pr3-smoke.test.ts
 *
 * PR3 E2E 冒烟测试 — 覆盖四条核心路径：
 *  1. 创建 Bot → 连接状态写库 → 断开 → 状态更新
 *  2. scratch-gc 跑过期场景
 *  3. bot-metrics API 返回完整结构
 *  4. test-connection 成功路径
 */
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, closeDatabase, getDb } from '../src/db.js';

// ── Mock @larksuiteoapi/node-sdk for test-connection path ─────────────────────
const requestMock = vi.fn();
vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>(
    '@larksuiteoapi/node-sdk',
  );
  class MockClient {
    constructor(_opts: unknown) {}
    request = requestMock;
  }
  return { ...actual, Client: MockClient };
});

// ── Mock runtime-config for getBotFeishuConfig ────────────────────────────────
const getBotFeishuConfigMock = vi.fn();
vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime-config.js')>(
    '../src/runtime-config.js',
  );
  return {
    ...actual,
    getBotFeishuConfig: (...args: unknown[]) => getBotFeishuConfigMock(...args),
  };
});

// ── Test fixtures ─────────────────────────────────────────────────────────────
let tmpDir: string;

function setupDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-smoke-'));
  process.env.DATA_DIR = tmpDir;
  const dbPath = path.join(tmpDir, 'test.db');
  initDatabase(dbPath);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
     VALUES ('u_admin', 'admin', 'x', 'admin', '["manage_system_config","view_audit_log"]', 'active', ?, ?),
            ('u_member', 'member', 'x', 'member', '[]', 'active', ?, ?)`,
  ).run(now, now, now, now);
}

function teardownDb() {
  try { closeDatabase(); } catch { /* ignore */ }
  delete process.env.DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// =============================================================================
// Scenario 1: Bot lifecycle — create → connect → disconnect → state updated
// =============================================================================
describe('PR3 smoke — Scenario 1: Bot connection state lifecycle', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  test('1a. createBot writes bot with default connection_state=disconnected', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'SmokeBot', channel: 'feishu' });

    const row = getDb()
      .prepare(`SELECT connection_state, consecutive_failures FROM bots WHERE id=?`)
      .get(bot.id) as { connection_state: string; consecutive_failures: number } | null;

    expect(row).not.toBeNull();
    expect(row!.connection_state).toBe('disconnected');
    expect(row!.consecutive_failures).toBe(0);
  });

  test('1b. markConnected transitions state and zeroes failures', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'SmokeBot2', channel: 'feishu' });

    const broadcast = vi.fn();
    const { markConnected } = await import('../src/bot-connection-state.js');
    markConnected(bot.id, { broadcast });

    const { getBotConnectionState } = await import('../src/db-bots.js');
    const state = getBotConnectionState(bot.id)!;
    expect(state.state).toBe('connected');
    expect(state.consecutive_failures).toBe(0);
    expect(state.last_connected_at).toBeTruthy();
    // broadcast must be called
    expect(broadcast).toHaveBeenCalledOnce();
    const call = broadcast.mock.calls[0][0] as { type: string; bot_id: string };
    expect(call.type).toBe('bot_connection_status');
    expect(call.bot_id).toBe(bot.id);
  });

  test('1c. markDisconnected after markConnected resets state to disconnected', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'SmokeBot3', channel: 'feishu' });

    const broadcast = vi.fn();
    const { markConnected, markDisconnected } = await import('../src/bot-connection-state.js');
    markConnected(bot.id, { broadcast });
    markDisconnected(bot.id, { broadcast });

    const { getBotConnectionState } = await import('../src/db-bots.js');
    const state = getBotConnectionState(bot.id)!;
    expect(state.state).toBe('disconnected');
    // broadcast called twice (once connect, once disconnect)
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test('1d. markFailed increments consecutive_failures and sets error state', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'SmokeBot4', channel: 'feishu' });

    const broadcast = vi.fn();
    const { markFailed } = await import('../src/bot-connection-state.js');
    markFailed(bot.id, 'AUTH_FAILED', { broadcast });
    markFailed(bot.id, 'AUTH_FAILED', { broadcast });

    const { getBotConnectionState } = await import('../src/db-bots.js');
    const state = getBotConnectionState(bot.id)!;
    expect(state.state).toBe('error');
    expect(state.consecutive_failures).toBe(2);
    expect(state.last_error_code).toBe('AUTH_FAILED');
  });

  test('1e. WsMessageOut bot_connection_status payload shape is complete', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'SmokeBot5', channel: 'feishu' });

    const captured: unknown[] = [];
    const broadcast = vi.fn((msg: unknown) => captured.push(msg));
    const { markConnected } = await import('../src/bot-connection-state.js');
    markConnected(bot.id, { broadcast });

    const payload = captured[0] as Record<string, unknown>;
    expect(payload).toHaveProperty('type', 'bot_connection_status');
    expect(payload).toHaveProperty('bot_id');
    expect(payload).toHaveProperty('user_id');
    expect(payload).toHaveProperty('state');
    expect(payload).toHaveProperty('last_connected_at');
    expect(payload).toHaveProperty('consecutive_failures');
    expect(payload).toHaveProperty('last_error_code');
  });
});

// =============================================================================
// Scenario 2: scratch-gc runs expired scenario
// =============================================================================
describe('PR3 smoke — Scenario 2: scratch-gc expired scenario', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  test('2a. runScratchGc deletes directory with mtime > 30 days', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_smoke1234');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'note.md'), 'old content');
    const old = Date.now() - 31 * 24 * 3600 * 1000;
    fs.utimesSync(dir, new Date(old), new Date(old));
    fs.utimesSync(path.join(dir, 'note.md'), new Date(old), new Date(old));

    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({ retentionDays: 30 });

    expect(report.deleted).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('2b. runScratchGc keeps recently-touched directory', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_fresh9999');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'note.md'), 'fresh content');

    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({ retentionDays: 30 });

    expect(report.deleted).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('2c. GcReport has required fields: scanned, deleted, kept, errors, quotaExceeded', async () => {
    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({ retentionDays: 30 });

    expect(report).toHaveProperty('scanned');
    expect(report).toHaveProperty('deleted');
    expect(report).toHaveProperty('kept');
    expect(report).toHaveProperty('errors');
    expect(report).toHaveProperty('quotaExceeded');
    expect(typeof report.scanned).toBe('number');
    expect(typeof report.deleted).toBe('number');
  });

  test('2d. sizeOverride triggers quota exceeded when > 1GB', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_bigdata1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f.md'), 'x');

    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({
      retentionDays: 30,
      sizeOverride: () => 2 * 1024 * 1024 * 1024,
    });

    expect(report.quotaExceeded).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Scenario 3: bot-metrics API returns complete structure
// =============================================================================
describe('PR3 smoke — Scenario 3: bot-metrics complete structure', () => {
  beforeEach(() => {
    setupDb();
  });
  afterEach(async () => {
    const { resetMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();
    teardownDb();
  });

  test('3a. getMetrics returns all required top-level keys', async () => {
    const { getMetrics, resetMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();
    const m = getMetrics();

    expect(m).toHaveProperty('queue_depth');
    expect(m).toHaveProperty('queue_processed_total');
    expect(m).toHaveProperty('hook_invocations_total');
    expect(m).toHaveProperty('hook_denies_total');
    expect(m).toHaveProperty('scratch_size_bytes');
    expect(m).toHaveProperty('updated_at');
  });

  test('3b. recordQueueEnqueue / recordQueueProcessed update depth correctly', async () => {
    const { recordQueueEnqueue, recordQueueProcessed, getMetrics, resetMetrics } =
      await import('../src/bot-metrics.js');
    resetMetrics();

    recordQueueEnqueue('main');
    recordQueueEnqueue('main');
    recordQueueProcessed('main', 'bot_abc12345');

    const m = getMetrics();
    expect(m.queue_depth['main']).toBe(1);
    expect(m.queue_processed_total['main|bot_abc12345']).toBe(1);
  });

  test('3c. recordHookDeny accumulates hook deny counts', async () => {
    const { recordHookDeny, recordHookInvocation, getMetrics, resetMetrics } =
      await import('../src/bot-metrics.js');
    resetMetrics();

    recordHookInvocation('bot_test12345', 'Write');
    recordHookInvocation('bot_test12345', 'Write');
    recordHookDeny('bot_test12345', 'Write', 'project_path');

    const m = getMetrics();
    expect(m.hook_invocations_total['bot_test12345|Write']).toBe(2);
    expect(m.hook_denies_total['bot_test12345|Write|project_path']).toBe(1);
  });

  test('3d. updated_at is an ISO date string', async () => {
    const { getMetrics, resetMetrics, recordQueueEnqueue } = await import('../src/bot-metrics.js');
    resetMetrics();
    recordQueueEnqueue('home-1');
    const m = getMetrics();
    expect(() => new Date(m.updated_at)).not.toThrow();
    expect(new Date(m.updated_at).toISOString()).toBe(m.updated_at);
  });

  test('3e. scratch_size_bytes is populated after runScratchGc', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_sz00001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.txt'), Buffer.alloc(512));

    const { resetMetrics, getMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();
    const { runScratchGc } = await import('../src/scratch-gc.js');
    await runScratchGc({ retentionDays: 30 });

    const m = getMetrics();
    expect(Object.keys(m.scratch_size_bytes).length).toBeGreaterThanOrEqual(1);
    const key = 'main|bot_sz00001';
    expect(m.scratch_size_bytes[key]).toBeGreaterThanOrEqual(512);
  });
});

// =============================================================================
// Scenario 4: test-connection success path
// =============================================================================
describe('PR3 smoke — Scenario 4: test-connection success path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDb();
  });
  afterEach(teardownDb);

  test('4a. testBotConnection returns ok=true with open_id and remote_name on valid credentials', async () => {
    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_smoke',
      appSecret: 'secret_smoke',
      enabled: true,
    });
    requestMock.mockResolvedValue({
      bot: { open_id: 'ou_smoke_abc', app_name: 'SmokeBot', avatar_url: '' },
    });

    const { testBotConnection } = await import('../src/routes/bots.js');
    const result = await testBotConnection('bot_any_smoke');

    expect(result.ok).toBe(true);
    expect(result.open_id).toBe('ou_smoke_abc');
    expect(result.remote_name).toBe('SmokeBot');
  });

  test('4b. testBotConnection returns ok=false when config is null', async () => {
    getBotFeishuConfigMock.mockReturnValue(null);

    const { testBotConnection } = await import('../src/routes/bots.js');
    const result = await testBotConnection('bot_no_config');

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(requestMock).not.toHaveBeenCalled();
  });

  test('4c. testBotConnection returns ok=false when feishu API throws', async () => {
    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_err',
      appSecret: 'wrong',
      enabled: true,
    });
    requestMock.mockRejectedValue(new Error('Network error'));

    const { testBotConnection } = await import('../src/routes/bots.js');
    const result = await testBotConnection('bot_net_err');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network error');
  });

  test('4d. testBotConnection does NOT persist open_id to DB', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_admin', name: 'TCBot', channel: 'feishu' });

    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_tc',
      appSecret: 'sec_tc',
      enabled: true,
    });
    requestMock.mockResolvedValue({
      bot: { open_id: 'ou_tc_should_not_save', app_name: 'TCBot', avatar_url: '' },
    });

    const { testBotConnection } = await import('../src/routes/bots.js');
    await testBotConnection(bot.id);

    const { getBotById } = await import('../src/db-bots.js');
    const botInDb = getBotById(bot.id);
    expect(botInDb?.open_id).toBeNull();
  });
});
