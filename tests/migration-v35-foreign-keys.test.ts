import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getDb, closeDatabase } from '../src/db.js';

describe('Migration v35: Foreign Keys', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-fk-v35-'));
    dbPath = path.join(tmpDir, 'test.db');
    initDatabase(dbPath);
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // ignore if not open
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('PRAGMA foreign_keys is 1 (enabled)', () => {
    const db = getDb();
    const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });

  test('messages.chat_jid FK has ON DELETE CASCADE', () => {
    const db = getDb();
    // SQLite stores FK info in sqlite_master. We verify by checking that
    // deleting a chat cascades to messages (behavior test).
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO chats (jid, name, last_message_time) VALUES ('test-chat', 'Test', ?)`).run(now);
    db.prepare(
      `INSERT INTO messages (id, chat_jid, timestamp, is_from_me) VALUES ('msg1', 'test-chat', ?, 0)`,
    ).run(now);

    // Verify message exists
    const before = db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE chat_jid='test-chat'`).get() as { cnt: number };
    expect(before.cnt).toBe(1);

    // Delete the chat — should cascade to messages
    db.prepare(`DELETE FROM chats WHERE jid='test-chat'`).run();

    const after = db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE chat_jid='test-chat'`).get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test('task_run_logs.task_id FK has ON DELETE CASCADE', () => {
    const db = getDb();
    const now = new Date().toISOString();
    // Insert a scheduled task
    db.prepare(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at)
       VALUES ('task1', 'main', 'web:main', 'test prompt', 'once', '2099-01-01T00:00:00Z', 'active', ?)`,
    ).run(now);
    // Insert a run log
    db.prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status) VALUES ('task1', ?, 100, 'success')`,
    ).run(now);

    // Verify log exists
    const before = db.prepare(`SELECT COUNT(*) AS cnt FROM task_run_logs WHERE task_id='task1'`).get() as { cnt: number };
    expect(before.cnt).toBe(1);

    // Delete the task — should cascade to task_run_logs
    db.prepare(`DELETE FROM scheduled_tasks WHERE id='task1'`).run();

    const after = db.prepare(`SELECT COUNT(*) AS cnt FROM task_run_logs WHERE task_id='task1'`).get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test('bots.user_id FK has ON DELETE CASCADE', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u-fk', 'fkuser', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot-fk', 'u-fk', 'feishu', 'FKBot', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);

    const before = db.prepare(`SELECT COUNT(*) AS cnt FROM bots WHERE id='bot-fk'`).get() as { cnt: number };
    expect(before.cnt).toBe(1);

    db.prepare(`DELETE FROM users WHERE id='u-fk'`).run();

    const after = db.prepare(`SELECT COUNT(*) AS cnt FROM bots WHERE id='bot-fk'`).get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test('bot_group_bindings.bot_id FK has ON DELETE CASCADE', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u-bgb', 'bgbuser', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:bgb-g', 'g', 'f', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot-bgb', 'u-bgb', 'feishu', 'BGBBot', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot-bgb', 'feishu:bgb-g', 'f', ?, 1)`,
    ).run(now);

    // Delete the bot — cascade to bot_group_bindings
    db.prepare(`DELETE FROM bots WHERE id='bot-bgb'`).run();

    const after = db.prepare(`SELECT COUNT(*) AS cnt FROM bot_group_bindings WHERE bot_id='bot-bgb'`).get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test('user_sessions FK still cascades on user delete (existing behavior preserved)', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u-sess', 'sessuser', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at)
       VALUES ('sess1', 'u-sess', ?, ?, ?)`,
    ).run(now, future, now);

    db.prepare(`DELETE FROM users WHERE id='u-sess'`).run();

    const after = db.prepare(`SELECT COUNT(*) AS cnt FROM user_sessions WHERE user_id='u-sess'`).get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  test('invite_codes.created_by FK is NO ACTION (user soft-delete safe)', () => {
    // invite_codes.created_by references users.id with NO ACTION.
    // Since users are only soft-deleted (status='deleted'), this FK should never trigger.
    // This test verifies we can still query invite_codes after a user is soft-deleted.
    const db = getDb();
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u-inv', 'invuser', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO invite_codes (code, created_by, role, permissions, max_uses, used_count, expires_at, created_at)
       VALUES ('INV001', 'u-inv', 'member', '[]', 1, 0, ?, ?)`,
    ).run(future, now);

    // Soft-delete user (no physical DELETE)
    db.prepare(`UPDATE users SET status='deleted', deleted_at=? WHERE id='u-inv'`).run(now);

    // invite_code should still be queryable
    const code = db.prepare(`SELECT code FROM invite_codes WHERE code='INV001'`).get() as { code: string } | undefined;
    expect(code?.code).toBe('INV001');
  });
});
