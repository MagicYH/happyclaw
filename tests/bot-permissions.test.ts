import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, getDb, closeDatabase } from '../src/db.js';

let tmpDir: string;

function bootstrap() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-perm-'));
  const dbPath = path.join(tmpDir, 'test.db');
  initDatabase(dbPath);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
     VALUES ('u_alice', 'alice', 'x', 'member', '[]', 'active', ?, ?),
            ('u_bob',   'bob',   'x', 'member', '[]', 'active', ?, ?),
            ('u_admin', 'admin', 'x', 'admin',  '[]', 'active', ?, ?)`,
  ).run(now, now, now, now, now, now);
}

describe('Bot API permissions', () => {
  beforeEach(() => {
    bootstrap();
  });
  afterEach(() => {
    try { closeDatabase(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('member can list only own bots', async () => {
    const { createBot } = await import('../src/db-bots.js');
    createBot({ user_id: 'u_alice', name: 'alice bot', channel: 'feishu' });
    createBot({ user_id: 'u_bob', name: 'bob bot', channel: 'feishu' });
    const { listBotsByUser } = await import('../src/db-bots.js');
    const aliceBots = listBotsByUser('u_alice');
    expect(aliceBots.length).toBe(1);
    expect(aliceBots[0].name).toBe('alice bot');
  });

  test('authorizeBot rejects cross-user access for member', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const aliceBot = createBot({ user_id: 'u_alice', name: 'alice bot', channel: 'feishu' });
    const { authorizeBot } = await import('../src/middleware/auth.js');
    // 模拟 Hono context
    const mockC = {
      get: (key: string) => (key === 'user' ? { id: 'u_bob', role: 'member' } : undefined),
      set: vi.fn(),
      req: { param: (_: string) => aliceBot.id },
      json: vi.fn((body: unknown, status: number) => ({ body, status })),
    };
    const next = vi.fn();
    await authorizeBot(mockC as any, next);
    expect(mockC.json).toHaveBeenCalledWith({ error: 'forbidden' }, 403);
    expect(next).not.toHaveBeenCalled();
  });

  test('authorizeBot admin can access any user bot', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const aliceBot = createBot({ user_id: 'u_alice', name: 'alice bot', channel: 'feishu' });
    const { authorizeBot } = await import('../src/middleware/auth.js');
    const mockC = {
      get: (key: string) => (key === 'user' ? { id: 'u_admin', role: 'admin' } : undefined),
      set: vi.fn(),
      req: { param: (_: string) => aliceBot.id },
      json: vi.fn(),
    };
    const next = vi.fn();
    await authorizeBot(mockC as any, next);
    expect(next).toHaveBeenCalled();
    expect(mockC.set).toHaveBeenCalledWith('bot', expect.objectContaining({ id: aliceBot.id }));
  });
});
