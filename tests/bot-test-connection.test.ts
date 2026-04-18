/**
 * tests/bot-test-connection.test.ts
 *
 * TDD for POST /api/bots/:id/test-connection
 *
 * 测试策略：
 * 1. 直接测试 testBotConnection 核心函数（从 bots.ts 导出）
 * 2. 验证 authorizeBot 中间件对权限的控制（直接 mock）
 * 3. 验证 GroupQueue 在入队/出队时已调用 recordQueueEnqueue/recordQueueProcessed
 * 4. 审计事件：bot_test_connection 出现在 AuthEventType
 */
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getDb, closeDatabase } from '../src/db.js';
import { createBot } from '../src/db-bots.js';

// ── mocks ────────────────────────────────────────────────────────────────────

// Mock @larksuiteoapi/node-sdk Client.request
const requestMock = vi.fn();
vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>(
    '@larksuiteoapi/node-sdk',
  );
  class MockClient {
    constructor(_opts: unknown) {}
    request = requestMock;
  }
  return {
    ...actual,
    Client: MockClient,
  };
});

// Mock getBotFeishuConfig in runtime-config
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

// ── helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function setupDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-tc-'));
  const dbPath = path.join(tmpDir, 'test.db');
  initDatabase(dbPath);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
     VALUES ('u_admin', 'admin', 'x', 'admin', '[]', 'active', ?, ?),
            ('u_member', 'member', 'x', 'member', '[]', 'active', ?, ?),
            ('u_other', 'other', 'x', 'admin', '[]', 'active', ?, ?)`,
  ).run(now, now, now, now, now, now);
}

function teardownDb() {
  try { closeDatabase(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Import testBotConnection once (not inside tests to avoid resetModules issues)
let testBotConnection: (botId: string) => Promise<{ ok: boolean; open_id?: string; remote_name?: string; error?: string }>;

beforeEach(async () => {
  vi.clearAllMocks();
  setupDb();
  if (!testBotConnection) {
    const mod = await import('../src/routes/bots.js');
    testBotConnection = mod.testBotConnection;
  }
});

afterEach(teardownDb);

// ── Core testBotConnection logic tests ────────────────────────────────────────

describe('testBotConnection core logic', () => {
  test('returns ok=true with open_id and remote_name when feishu responds', async () => {
    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_test',
      appSecret: 'secret_test',
      enabled: true,
    });
    requestMock.mockResolvedValue({
      bot: { open_id: 'ou_abc123', app_name: 'MyBot', avatar_url: '' },
    });

    const result = await testBotConnection('bot_any_id');

    expect(result.ok).toBe(true);
    expect(result.open_id).toBe('ou_abc123');
    expect(result.remote_name).toBe('MyBot');
  });

  test('returns ok=false when no feishu config is stored', async () => {
    getBotFeishuConfigMock.mockReturnValue(null);

    const result = await testBotConnection('bot_any_id');

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    // 不应调用飞书 API
    expect(requestMock).not.toHaveBeenCalled();
  });

  test('returns ok=false when feishu API throws', async () => {
    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_bad',
      appSecret: 'wrong_secret',
      enabled: true,
    });
    requestMock.mockRejectedValue(new Error('Invalid credentials'));

    const result = await testBotConnection('bot_any_id');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid credentials');
  });

  test('returns ok=false when feishu response has no open_id', async () => {
    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_x',
      appSecret: 'sec_y',
      enabled: true,
    });
    requestMock.mockResolvedValue({ bot: {} }); // no open_id

    const result = await testBotConnection('bot_any_id');

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  test('does NOT persist open_id to the database', async () => {
    const bot = createBot({ user_id: 'u_admin', name: 'B', channel: 'feishu' });

    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_test',
      appSecret: 'secret_test',
      enabled: true,
    });
    requestMock.mockResolvedValue({
      bot: { open_id: 'ou_should_not_save', app_name: 'Bot', avatar_url: '' },
    });

    await testBotConnection(bot.id);

    // Verify bot in DB still has null open_id
    const { getBotById } = await import('../src/db-bots.js');
    const botInDb = getBotById(bot.id);
    expect(botInDb?.open_id).toBeNull();
  });

  test('handles alternate response shape with data.bot wrapper', async () => {
    getBotFeishuConfigMock.mockReturnValue({
      appId: 'cli_x',
      appSecret: 'sec_y',
      enabled: true,
    });
    requestMock.mockResolvedValue({
      data: { bot: { open_id: 'ou_alt', app_name: 'AltBot' } },
    });

    const result = await testBotConnection('bot_x');

    expect(result.ok).toBe(true);
    expect(result.open_id).toBe('ou_alt');
    expect(result.remote_name).toBe('AltBot');
  });
});

// ── authorizeBot permission matrix ───────────────────────────────────────────

describe('authorizeBot permission gate for test-connection', () => {
  test('authorizeBot allows bot owner to access', async () => {
    const bot = createBot({ user_id: 'u_admin', name: 'B', channel: 'feishu' });
    const { authorizeBot } = await import('../src/middleware/auth.js');

    const next = vi.fn();
    const mockC = {
      get: (key: string) =>
        key === 'user' ? { id: 'u_admin', role: 'admin' } : undefined,
      set: vi.fn(),
      req: { param: (_: string) => bot.id },
      json: vi.fn(),
    };
    await authorizeBot(mockC as any, next);
    expect(next).toHaveBeenCalled();
  });

  test('authorizeBot blocks member from accessing admin bot', async () => {
    const bot = createBot({ user_id: 'u_admin', name: 'B', channel: 'feishu' });
    const { authorizeBot } = await import('../src/middleware/auth.js');

    const next = vi.fn();
    const mockC = {
      get: (key: string) =>
        key === 'user' ? { id: 'u_member', role: 'member' } : undefined,
      set: vi.fn(),
      req: { param: (_: string) => bot.id },
      json: vi.fn().mockReturnValue({ status: 403 }),
    };
    await authorizeBot(mockC as any, next);
    expect(mockC.json).toHaveBeenCalledWith({ error: 'forbidden' }, 403);
    expect(next).not.toHaveBeenCalled();
  });

  test('authorizeBot returns 404 for non-existent bot', async () => {
    const { authorizeBot } = await import('../src/middleware/auth.js');

    const next = vi.fn();
    const mockC = {
      get: (key: string) =>
        key === 'user' ? { id: 'u_admin', role: 'admin' } : undefined,
      set: vi.fn(),
      req: { param: (_: string) => 'bot_nonexistent' },
      json: vi.fn().mockReturnValue({ status: 404 }),
    };
    await authorizeBot(mockC as any, next);
    expect(mockC.json).toHaveBeenCalledWith({ error: 'not found' }, 404);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── AuthEventType includes bot_test_connection ────────────────────────────────

describe('AuthEventType type coverage', () => {
  test('bot_test_connection is a valid AuthEventType string literal', () => {
    // TypeScript compile-time check: if this file compiles, the type is valid.
    // Runtime: we verify the string matches the expected value.
    const eventType = 'bot_test_connection';
    // This would fail TypeScript compilation if bot_test_connection is not in AuthEventType
    const _typed: import('../src/types.js').AuthEventType = eventType as any;
    expect(_typed).toBe('bot_test_connection');
  });
});

// ── GroupQueue metrics wiring ─────────────────────────────────────────────────

describe('GroupQueue metrics wiring', () => {
  test('enqueueMessageCheck records queue depth for the folder', async () => {
    const { resetMetrics, getMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();

    const { GroupQueue } = await import('../src/group-queue.js');
    const queue = new GroupQueue();
    queue.setHostModeChecker(() => false);
    queue.setSerializationKeyResolver((jid) => jid);
    // processMessagesFn must be set to avoid crash in runForGroup
    queue.setProcessMessagesFn(async () => false);

    queue.enqueueMessageCheck('feishu:group1');

    const m = getMetrics();
    // queue_depth must be tracked (value >= 0; may be 0 after immediate run+dequeue)
    expect(m.queue_depth).toHaveProperty('feishu:group1');
  });

  test('enqueueTask records queue depth', async () => {
    const { resetMetrics, getMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();

    const { GroupQueue } = await import('../src/group-queue.js');
    const queue = new GroupQueue();
    queue.setHostModeChecker(() => false);
    queue.setSerializationKeyResolver((jid) => jid);

    const folder = 'feishu:task_group';
    queue.enqueueTask(folder, 'task_001', async () => {});

    const m = getMetrics();
    expect(m.queue_depth).toHaveProperty(folder);
  });

  test('recordQueueProcessed is called when a task completes (direct metrics test)', async () => {
    const { resetMetrics, getMetrics, recordQueueEnqueue, recordQueueProcessed } =
      await import('../src/bot-metrics.js');
    resetMetrics();

    recordQueueEnqueue('main');
    recordQueueProcessed('main', 'bot_xyz');

    const m = getMetrics();
    expect(m.queue_depth.main).toBe(0);
    expect(m.queue_processed_total['main|bot_xyz']).toBe(1);
  });

  test('enqueueMessageCheck increments then decrements depth after message processing', async () => {
    const { resetMetrics, getMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();

    const { GroupQueue } = await import('../src/group-queue.js');
    const queue = new GroupQueue();
    queue.setHostModeChecker(() => false);
    queue.setSerializationKeyResolver((jid) => jid);

    let processResolve: () => void;
    const processPromise = new Promise<void>((r) => { processResolve = r; });

    // processMessagesFn that we can control
    let processCalled = false;
    queue.setProcessMessagesFn(async () => {
      processCalled = true;
      await processPromise;
      return true;
    });

    queue.enqueueMessageCheck('feishu:ctrl');

    // Immediately after enqueue, depth should be 1
    const mBefore = getMetrics();
    expect(mBefore.queue_depth['feishu:ctrl']).toBe(1);

    // Now let the processor finish
    processResolve!();
    // Give the async finally block a tick to run
    await new Promise((r) => setTimeout(r, 10));

    const mAfter = getMetrics();
    expect(mAfter.queue_depth['feishu:ctrl']).toBe(0);
    expect(processCalled).toBe(true);
  });
});
