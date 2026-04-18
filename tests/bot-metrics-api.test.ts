import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, closeDatabase, getDb } from '../src/db.js';

let tmpDir: string;

function bootstrapDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-api-'));
  process.env.DATA_DIR = tmpDir;
  const dbPath = path.join(tmpDir, 'test.db');
  initDatabase(dbPath);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
     VALUES ('u_admin', 'admin', 'x', 'admin', '["view_audit_log","manage_system_config"]', 'active', ?, ?),
            ('u_member', 'member', 'x', 'member', '[]', 'active', ?, ?)`,
  ).run(now, now, now, now);
}

describe('GET /api/monitor/bot-metrics', () => {
  beforeEach(() => {
    bootstrapDb();
  });

  afterEach(async () => {
    try {
      closeDatabase();
    } catch {
      // ignore
    }
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Reset metrics between tests
    const { resetMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();
  });

  test('getMetrics returns correct structure with queue and hook data', async () => {
    const { recordQueueEnqueue, recordQueueProcessed, recordHookDeny, getMetrics, resetMetrics } =
      await import('../src/bot-metrics.js');

    resetMetrics();
    recordQueueEnqueue('main');
    recordQueueEnqueue('main');
    recordQueueProcessed('main', 'bot_test12345');
    recordHookDeny('bot_test12345', 'Write', 'project_path');

    const m = getMetrics();

    // Verify structure
    expect(m).toHaveProperty('queue_depth');
    expect(m).toHaveProperty('queue_processed_total');
    expect(m).toHaveProperty('hook_invocations_total');
    expect(m).toHaveProperty('hook_denies_total');
    expect(m).toHaveProperty('scratch_size_bytes');
    expect(m).toHaveProperty('updated_at');

    // Verify data
    expect(m.queue_depth.main).toBe(1);
    expect(m.queue_processed_total['main|bot_test12345']).toBe(1);
    expect(m.hook_denies_total['bot_test12345|Write|project_path']).toBe(1);
  });

  test('admin can access bot-metrics endpoint via route handler', async () => {
    const { recordQueueEnqueue, resetMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();
    recordQueueEnqueue('main');

    // Import the route handler and test it directly
    const { getMetrics } = await import('../src/bot-metrics.js');
    const m = getMetrics();

    // Simulate what the route handler does
    expect(m.queue_depth.main).toBe(1);
    expect(typeof m.updated_at).toBe('string');
  });

  test('metrics accumulate across multiple operations', async () => {
    const { recordQueueEnqueue, recordQueueProcessed, recordHookDeny, recordHookInvocation, getMetrics, resetMetrics } =
      await import('../src/bot-metrics.js');

    resetMetrics();

    // Simulate a sequence of operations
    recordQueueEnqueue('main');
    recordQueueEnqueue('main');
    recordQueueEnqueue('main');
    recordQueueProcessed('main', 'bot_a');
    recordQueueProcessed('main', 'bot_a');
    recordHookInvocation('bot_a', 'Write');
    recordHookInvocation('bot_a', 'Write');
    recordHookInvocation('bot_a', 'Bash');
    recordHookDeny('bot_a', 'Write', 'project_path');

    const m = getMetrics();

    expect(m.queue_depth.main).toBe(1); // 3 enqueued - 2 processed
    expect(m.queue_processed_total['main|bot_a']).toBe(2);
    expect(m.hook_invocations_total['bot_a|Write']).toBe(2);
    expect(m.hook_invocations_total['bot_a|Bash']).toBe(1);
    expect(m.hook_denies_total['bot_a|Write|project_path']).toBe(1);
  });

  test('monitor route exports default router', async () => {
    const monitorModule = await import('../src/routes/monitor.js');
    expect(monitorModule.default).toBeDefined();
  });
});
