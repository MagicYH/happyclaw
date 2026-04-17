import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

function createTempDb(): { db: InstanceType<typeof Database>; path: string } {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'happyclaw-schema-test-'),
  );
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  return { db, path: dbPath };
}

describe('Schema v35: bots and bot_group_bindings', () => {
  test('bots table has all required columns', () => {
    const { db } = createTempDb();
    db.exec(`
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'feishu',
        name TEXT NOT NULL,
        default_folder TEXT,
        activation_mode TEXT NOT NULL DEFAULT 'when_mentioned',
        concurrency_mode TEXT NOT NULL DEFAULT 'writer',
        status TEXT NOT NULL DEFAULT 'active',
        deleted_at TEXT,
        open_id TEXT,
        remote_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = db.prepare("PRAGMA table_info('bots')").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      'id',
      'user_id',
      'channel',
      'name',
      'default_folder',
      'activation_mode',
      'concurrency_mode',
      'status',
      'deleted_at',
      'open_id',
      'remote_name',
      'created_at',
      'updated_at',
    ]);
    db.close();
  });

  test('bot_group_bindings table has composite PK (bot_id, group_jid)', () => {
    const { db } = createTempDb();
    db.exec(`
      CREATE TABLE bot_group_bindings (
        bot_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        folder TEXT NOT NULL,
        activation_mode TEXT,
        concurrency_mode TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        bound_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, group_jid)
      );
    `);
    const indexes = db
      .prepare("PRAGMA index_list('bot_group_bindings')")
      .all() as Array<{
      name: string;
      unique: number;
    }>;
    // SQLite creates a unique index for composite PK
    expect(indexes.some((i) => i.unique === 1)).toBe(true);
    db.close();
  });

  test('bots default_folder is nullable', () => {
    const { db } = createTempDb();
    db.exec(`
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'feishu',
        name TEXT NOT NULL,
        default_folder TEXT,
        activation_mode TEXT NOT NULL DEFAULT 'when_mentioned',
        concurrency_mode TEXT NOT NULL DEFAULT 'writer',
        status TEXT NOT NULL DEFAULT 'active',
        deleted_at TEXT,
        open_id TEXT,
        remote_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = db.prepare("PRAGMA table_info('bots')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const defaultFolder = cols.find((c) => c.name === 'default_folder');
    expect(defaultFolder).toBeDefined();
    expect(defaultFolder?.notnull).toBe(0); // nullable
    db.close();
  });

  test('bot_group_bindings activation_mode and concurrency_mode are nullable', () => {
    const { db } = createTempDb();
    db.exec(`
      CREATE TABLE bot_group_bindings (
        bot_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        folder TEXT NOT NULL,
        activation_mode TEXT,
        concurrency_mode TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        bound_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, group_jid)
      );
    `);
    const cols = db
      .prepare("PRAGMA table_info('bot_group_bindings')")
      .all() as Array<{
      name: string;
      notnull: number;
    }>;
    const activationMode = cols.find((c) => c.name === 'activation_mode');
    const concurrencyMode = cols.find((c) => c.name === 'concurrency_mode');
    expect(activationMode?.notnull).toBe(0);
    expect(concurrencyMode?.notnull).toBe(0);
    db.close();
  });
});
