import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initDatabase,
  getDb,
  closeDatabase,
  storeMessageDirect,
} from '../src/db.js';

describe('storeMessageDirect: INSERT OR IGNORE semantics', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-msg-'));
    dbPath = path.join(tmpDir, 'test.db');
    initDatabase(dbPath);
    // Insert a chat record required by the FK constraint
    getDb()
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES ('feishu:chat_a', 'Test Chat', ?)`,
      )
      .run(new Date().toISOString());
  });

  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // ignore if not open
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('duplicate (id, chat_jid) is ignored, first write wins', () => {
    const db = getDb();

    // First write
    storeMessageDirect(
      'msg_1',
      'feishu:chat_a',
      'sender_1',
      'Sender One',
      'Hello',
      new Date('2026-04-17T10:00:00Z').toISOString(),
      false,
    );

    // Second write with same (id, chat_jid) but different content and isFromMe
    storeMessageDirect(
      'msg_1',
      'feishu:chat_a',
      'sender_2',
      'Sender Two',
      'Replaced content',
      new Date('2026-04-17T11:00:00Z').toISOString(),
      true,
    );

    const row = db
      .prepare(
        `SELECT sender, content, is_from_me FROM messages WHERE id='msg_1' AND chat_jid='feishu:chat_a'`,
      )
      .get() as
      | { sender: string; content: string; is_from_me: number }
      | undefined;

    expect(row).toBeDefined();
    // First write should survive — IGNORE semantics
    expect(row!.sender).toBe('sender_1');
    expect(row!.content).toBe('Hello');
    expect(row!.is_from_me).toBe(0);
  });

  test('distinct (id, chat_jid) pairs are both stored', () => {
    const db = getDb();

    storeMessageDirect(
      'msg_1',
      'feishu:chat_a',
      'sender_1',
      'Sender One',
      'First message',
      new Date('2026-04-17T10:00:00Z').toISOString(),
      false,
    );
    storeMessageDirect(
      'msg_2',
      'feishu:chat_a',
      'sender_1',
      'Sender One',
      'Second message',
      new Date('2026-04-17T10:01:00Z').toISOString(),
      false,
    );

    const count = (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM messages WHERE chat_jid='feishu:chat_a'`,
        )
        .get() as { cnt: number }
    ).cnt;
    expect(count).toBe(2);
  });
});
