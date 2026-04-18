import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, closeDatabase } from '../src/db.js';

describe('scratch-gc', () => {
  let tmpDir: string;
  let dbPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
    process.env.DATA_DIR = tmpDir;
    dbPath = path.join(tmpDir, 'test.db');
    initDatabase(dbPath);
  });
  afterEach(() => {
    closeDatabase();
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deletes scratch dir untouched > 30 days', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_old12345');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f.md'), 'x');
    const old = Date.now() - 31 * 24 * 3600 * 1000;
    fs.utimesSync(dir, new Date(old), new Date(old));
    fs.utimesSync(path.join(dir, 'f.md'), new Date(old), new Date(old));

    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({ retentionDays: 30 });
    expect(report.deleted).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('keeps dir touched within retention window', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_fresh1234');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f.md'), 'x');
    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({ retentionDays: 30 });
    expect(report.deleted).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('updates bot-metrics with du size', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_quota1234');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'f.md'), Buffer.alloc(1024 * 100)); // 100KB
    const { runScratchGc } = await import('../src/scratch-gc.js');
    const { getMetrics, resetMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();
    await runScratchGc({ retentionDays: 30 });
    expect(getMetrics().scratch_size_bytes['main|bot_quota1234']).toBeGreaterThanOrEqual(100 * 1024);
  });

  test('1GB+ triggers scratch_quota_exceeded audit', async () => {
    const dir = path.join(tmpDir, 'scratch', 'main', 'bots', 'bot_big12345');
    fs.mkdirSync(dir, { recursive: true });
    // 模拟：不真写 1GB，改为在 runScratchGc 传 mock size
    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({
      retentionDays: 30,
      sizeOverride: (_f, _b) => 2 * 1024 * 1024 * 1024, // 2GB
    });
    expect(report.quotaExceeded).toBe(1);
  });

  test('empty scratch root returns zero-count report', async () => {
    const { runScratchGc } = await import('../src/scratch-gc.js');
    const report = await runScratchGc({ retentionDays: 30 });
    expect(report.scanned).toBe(0);
    expect(report.deleted).toBe(0);
    expect(report.kept).toBe(0);
    expect(report.errors).toBe(0);
  });

  test('shouldRunNow returns true at hour 3 with no prior run', async () => {
    const { shouldRunNow } = await import('../src/scratch-gc.js');
    // 构造一个凌晨 3 点的时间戳
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    expect(shouldRunNow(null, now.getTime())).toBe(true);
  });

  test('shouldRunNow returns false when hour is not 3', async () => {
    const { shouldRunNow } = await import('../src/scratch-gc.js');
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    expect(shouldRunNow(null, now.getTime())).toBe(false);
  });

  test('shouldRunNow returns false if already ran within 23h', async () => {
    const { shouldRunNow } = await import('../src/scratch-gc.js');
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    const lastRun = now.getTime() - 2 * 3600 * 1000; // 2 hours ago (same day)
    expect(shouldRunNow(lastRun, now.getTime())).toBe(false);
  });
});
