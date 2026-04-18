import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('migration v35 → v36: bot connection state columns', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm36-'));
    process.env.DATA_DIR = tmpDir;
  });
  afterEach(async () => {
    const { closeDatabase } = await import('../src/db.js');
    closeDatabase();
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('bots table has 4 new columns after migration', async () => {
    const { initDatabase, getDb } = await import('../src/db.js');
    initDatabase(path.join(tmpDir, 'test.db'));
    const cols = getDb().prepare(`PRAGMA table_info(bots)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('connection_state');
    expect(names).toContain('last_connected_at');
    expect(names).toContain('consecutive_failures');
    expect(names).toContain('last_error_code');
  });

  test('existing bots get connection_state="disconnected" default', async () => {
    const { initDatabase, getDb } = await import('../src/db.js');
    initDatabase(path.join(tmpDir, 'test.db'));
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1','alice','x','member','[]','active',?,?)`,
    ).run(now, now);
    getDb().prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_abc12345','u1','feishu','A','when_mentioned','writer','active',?,?)`,
    ).run(now, now);
    const row = getDb().prepare(`SELECT connection_state, consecutive_failures FROM bots WHERE id=?`)
      .get('bot_abc12345') as { connection_state: string; consecutive_failures: number };
    expect(row.connection_state).toBe('disconnected');
    expect(row.consecutive_failures).toBe(0);
  });

  test('SCHEMA_VERSION is 36 after migration', async () => {
    const { initDatabase, getDb } = await import('../src/db.js');
    initDatabase(path.join(tmpDir, 'test.db'));
    const row = getDb().prepare(`SELECT value FROM router_state WHERE key='schema_version'`)
      .get() as { value: string };
    expect(row.value).toBe('36');
  });
});
