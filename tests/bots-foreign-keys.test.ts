import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getDb, closeDatabase } from '../src/db.js';

describe('Foreign keys: bots cascade', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-fk-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // ignore if not open
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deleting user cascades to bots and bot_group_bindings', () => {
    initDatabase(dbPath);
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1', 'tu', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g', 'g', 'f', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_a', 'u1', 'feishu', 'A', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot_a', 'feishu:g', 'f', ?, 1)`,
    ).run(now);

    db.prepare(`DELETE FROM users WHERE id='u1'`).run();

    const botCount = (db.prepare(`SELECT COUNT(*) AS c FROM bots WHERE id='bot_a'`).get() as { c: number }).c;
    const bgbCount = (db.prepare(`SELECT COUNT(*) AS c FROM bot_group_bindings WHERE bot_id='bot_a'`).get() as { c: number }).c;
    expect(botCount).toBe(0);
    expect(bgbCount).toBe(0);
  });

  test('deleting bot cascades to bot_group_bindings', () => {
    initDatabase(dbPath);
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1', 'tu', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g', 'g', 'f', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_a', 'u1', 'feishu', 'A', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot_a', 'feishu:g', 'f', ?, 1)`,
    ).run(now);

    db.prepare(`DELETE FROM bots WHERE id='bot_a'`).run();

    const bgbCount = (db.prepare(`SELECT COUNT(*) AS c FROM bot_group_bindings WHERE bot_id='bot_a'`).get() as { c: number }).c;
    expect(bgbCount).toBe(0);
  });
});
