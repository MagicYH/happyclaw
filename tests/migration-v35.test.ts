import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getDb, closeDatabase } from '../src/db.js';

describe('Migration v35', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mig-'));
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

  test('schema_version advances to 35', () => {
    initDatabase(dbPath);
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM router_state WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('35');
  });

  test('bots and bot_group_bindings tables exist', () => {
    initDatabase(dbPath);
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bots','bot_group_bindings')")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(2);
  });

  test('sessions table has bot_id column with default empty string', () => {
    initDatabase(dbPath);
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const botId = cols.find((c) => c.name === 'bot_id');
    expect(botId).toBeDefined();
    expect(botId?.dflt_value).toBe("''");
  });

  test('PRAGMA foreign_keys returns 1 (enabled)', () => {
    initDatabase(dbPath);
    const db = getDb();
    const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });

  test('sync_bgb_folder_on_rg_update trigger exists', () => {
    initDatabase(dbPath);
    const db = getDb();
    const trg = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='sync_bgb_folder_on_rg_update'")
      .get() as { name: string } | undefined;
    expect(trg?.name).toBe('sync_bgb_folder_on_rg_update');
  });

  test('usage_records has bot_id column', () => {
    initDatabase(dbPath);
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('usage_records')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'bot_id')).toBe(true);
  });

  test('usage_daily_summary has bot_id column', () => {
    initDatabase(dbPath);
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('usage_daily_summary')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'bot_id')).toBe(true);
  });
});
