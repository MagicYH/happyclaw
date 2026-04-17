import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getDb, closeDatabase } from '../src/db.js';
import type { Bot, BotGroupBinding } from '../src/types.js';
import * as mod from '../src/db-bots.js';

describe('Bot CRUD', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-crud-'));
    dbPath = path.join(tmpDir, 'test.db');
    initDatabase(dbPath);
    // seed a user so FK is satisfied
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1', 'tu', 'x', 'admin', '[]', 'active', ?, ?)`,
      )
      .run(now, now);
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // ignore if not open
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('createBot returns Bot with generated id', () => {
    const bot = mod.createBot({
      user_id: 'u1',
      name: 'My Bot',
      channel: 'feishu',
    });
    expect(bot.id).toMatch(/^bot_[a-zA-Z0-9_-]{8,}$/);
    expect(bot.status).toBe('active');
    expect(bot.concurrency_mode).toBe('writer');
    expect(bot.activation_mode).toBe('when_mentioned');
    expect(bot.deleted_at).toBeNull();
  });

  test('getBotById returns Bot when id exists', () => {
    const created = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    const found = mod.getBotById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe('A');
  });

  test('getBotById ignores soft-deleted by default', () => {
    const created = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    mod.softDeleteBot(created.id);
    expect(mod.getBotById(created.id)).toBeNull();
    expect(mod.getBotById(created.id, { includeDeleted: true })?.id).toBe(created.id);
  });

  test('listBotsByUser filters by user_id and excludes deleted', () => {
    mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    const b = mod.createBot({ user_id: 'u1', name: 'B', channel: 'feishu' });
    mod.softDeleteBot(b.id);
    const list = mod.listBotsByUser('u1');
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('A');
  });

  test('updateBot updates fields and bumps updated_at', () => {
    const created = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    const origUpdated = created.updated_at;
    const updated = mod.updateBot(created.id, { name: 'A renamed', default_folder: 'main' });
    expect(updated.name).toBe('A renamed');
    expect(updated.default_folder).toBe('main');
    expect(updated.updated_at >= origUpdated).toBe(true);
  });

  test('hardDeleteBot removes row (and bindings via CASCADE)', () => {
    const created = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    mod.hardDeleteBot(created.id);
    expect(mod.getBotById(created.id, { includeDeleted: true })).toBeNull();
  });
});

describe('BotGroupBinding CRUD', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-bgb-'));
    dbPath = path.join(tmpDir, 'test.db');
    initDatabase(dbPath);
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1','tu','x','admin','[]','active',?,?)`,
      )
      .run(now, now);
    getDb()
      .prepare(
        `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g', 'g', 'f', ?)`,
      )
      .run(now);
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // ignore if not open
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('upsertBinding inserts when new', () => {
    const bot = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    const binding = mod.upsertBinding({ bot_id: bot.id, group_jid: 'feishu:g', folder: 'f' });
    expect(binding.enabled).toBe(true);
    expect(binding.folder).toBe('f');
  });

  test('upsertBinding is idempotent (INSERT OR IGNORE semantics)', () => {
    const bot = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    mod.upsertBinding({ bot_id: bot.id, group_jid: 'feishu:g', folder: 'f' });
    mod.upsertBinding({ bot_id: bot.id, group_jid: 'feishu:g', folder: 'f2' });
    const bindings = mod.listBindingsByBot(bot.id);
    expect(bindings.length).toBe(1);
    // 幂等保留第一次（IGNORE 语义）
    expect(bindings[0].folder).toBe('f');
  });

  test('listBindingsByGroup returns all bots bound to a group', () => {
    const b1 = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    const b2 = mod.createBot({ user_id: 'u1', name: 'B', channel: 'feishu' });
    mod.upsertBinding({ bot_id: b1.id, group_jid: 'feishu:g', folder: 'f' });
    mod.upsertBinding({ bot_id: b2.id, group_jid: 'feishu:g', folder: 'f' });
    const list = mod.listBindingsByGroup('feishu:g');
    expect(list.length).toBe(2);
  });

  test('removeBinding deletes single binding', () => {
    const bot = mod.createBot({ user_id: 'u1', name: 'A', channel: 'feishu' });
    mod.upsertBinding({ bot_id: bot.id, group_jid: 'feishu:g', folder: 'f' });
    mod.removeBinding(bot.id, 'feishu:g');
    expect(mod.listBindingsByBot(bot.id).length).toBe(0);
  });
});
