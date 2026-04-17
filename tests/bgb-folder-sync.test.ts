import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getDb, closeDatabase } from '../src/db.js';

describe('Trigger: sync_bgb_folder_on_rg_update', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-trg-'));
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

  test('updating registered_groups.folder cascades to bot_group_bindings.folder', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert prerequisite user
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1', 'testuser', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);

    // Insert registered group
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g1', 'g', 'old-folder', ?)`,
    ).run(now);

    // Insert bot (FK: user_id → users.id)
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_a', 'u1', 'feishu', 'A', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);

    // Insert bot_group_binding (FK: bot_id → bots.id, group_jid → registered_groups.jid)
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot_a', 'feishu:g1', 'old-folder', ?, 1)`,
    ).run(now);

    // Update registered_group folder — should trigger sync
    db.prepare(
      `UPDATE registered_groups SET folder='new-folder' WHERE jid='feishu:g1'`,
    ).run();

    // Verify the trigger fired and updated bot_group_bindings.folder
    const row = db
      .prepare(
        `SELECT folder FROM bot_group_bindings WHERE bot_id='bot_a' AND group_jid='feishu:g1'`,
      )
      .get() as { folder: string };
    expect(row.folder).toBe('new-folder');
  });

  test('trigger does not fire when folder is unchanged', () => {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u2', 'testuser2', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g2', 'g2', 'same-folder', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_b', 'u2', 'feishu', 'B', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot_b', 'feishu:g2', 'same-folder', ?, 1)`,
    ).run(now);

    // Update name only — folder stays the same
    db.prepare(
      `UPDATE registered_groups SET name='g2-updated' WHERE jid='feishu:g2'`,
    ).run();

    const row = db
      .prepare(
        `SELECT folder FROM bot_group_bindings WHERE bot_id='bot_b' AND group_jid='feishu:g2'`,
      )
      .get() as { folder: string };
    // folder should remain unchanged
    expect(row.folder).toBe('same-folder');
  });
});
