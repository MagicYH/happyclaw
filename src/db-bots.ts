/**
 * Bot 和 BotGroupBinding 的数据库 CRUD。
 * 所有查询默认排除软删除的 Bot（deleted_at IS NOT NULL）。
 *
 * nanoid 未在项目中安装，使用 Node 内置 crypto 生成 ID。
 */
import crypto from 'crypto';
import { getDb } from './db.js';
import type {
  Bot,
  BotActivationMode,
  BotConcurrencyMode,
  BotConnectionState,
  BotGroupBinding,
  BotStatus,
} from './types.js';

// ── helpers ─────────────────────────────────────────────

function generateBotId(): string {
  return `bot_${crypto.randomBytes(6).toString('hex')}`;
}

function rowToBot(row: Record<string, unknown>): Bot {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    channel: String(row.channel) as 'feishu',
    name: String(row.name),
    default_folder:
      row.default_folder === null ? null : String(row.default_folder),
    activation_mode: String(row.activation_mode) as BotActivationMode,
    concurrency_mode: String(row.concurrency_mode) as BotConcurrencyMode,
    status: String(row.status) as BotStatus,
    deleted_at: row.deleted_at === null ? null : String(row.deleted_at),
    open_id: row.open_id === null ? null : String(row.open_id),
    remote_name: row.remote_name === null ? null : String(row.remote_name),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    // PR3: connection state fields
    connection_state: (row.connection_state ?? 'disconnected') as BotConnectionState,
    last_connected_at:
      row.last_connected_at == null ? null : String(row.last_connected_at),
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    last_error_code:
      row.last_error_code == null ? null : String(row.last_error_code),
  };
}

function rowToBinding(row: Record<string, unknown>): BotGroupBinding {
  return {
    bot_id: String(row.bot_id),
    group_jid: String(row.group_jid),
    folder: String(row.folder),
    activation_mode:
      row.activation_mode === null
        ? null
        : (String(row.activation_mode) as BotActivationMode),
    concurrency_mode:
      row.concurrency_mode === null
        ? null
        : (String(row.concurrency_mode) as BotConcurrencyMode),
    enabled: Number(row.enabled) === 1,
    bound_at: String(row.bound_at),
  };
}

// ── Bot CRUD ─────────────────────────────────────────────

export interface CreateBotInput {
  user_id: string;
  name: string;
  channel: 'feishu';
  default_folder?: string;
  activation_mode?: BotActivationMode;
  concurrency_mode?: BotConcurrencyMode;
}

export function createBot(input: CreateBotInput): Bot {
  const db = getDb();
  const id = generateBotId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO bots (id, user_id, channel, name, default_folder,
                       activation_mode, concurrency_mode, status,
                       deleted_at, open_id, remote_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.user_id,
    input.channel,
    input.name,
    input.default_folder ?? null,
    input.activation_mode ?? 'when_mentioned',
    input.concurrency_mode ?? 'writer',
    now,
    now,
  );
  const bot = getBotById(id, { includeDeleted: true });
  if (!bot) throw new Error(`createBot: failed to read back ${id}`);
  return bot;
}

export interface GetBotOpts {
  includeDeleted?: boolean;
}

export function getBotById(id: string, opts: GetBotOpts = {}): Bot | null {
  const db = getDb();
  const row = db
    .prepare(
      opts.includeDeleted
        ? `SELECT * FROM bots WHERE id = ?`
        : `SELECT * FROM bots WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToBot(row) : null;
}

export function listBotsByUser(userId: string, opts: GetBotOpts = {}): Bot[] {
  const db = getDb();
  const rows = db
    .prepare(
      opts.includeDeleted
        ? `SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC`
        : `SELECT * FROM bots WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToBot);
}

export function listAllActiveBots(): Bot[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM bots WHERE deleted_at IS NULL AND status = 'active' ORDER BY created_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToBot);
}

export interface UpdateBotInput {
  name?: string;
  default_folder?: string | null;
  activation_mode?: BotActivationMode;
  concurrency_mode?: BotConcurrencyMode;
  status?: BotStatus;
  open_id?: string | null;
  remote_name?: string | null;
}

export function updateBot(id: string, patch: UpdateBotInput): Bot {
  const db = getDb();
  const existing = getBotById(id, { includeDeleted: true });
  if (!existing) throw new Error(`updateBot: bot ${id} not found`);
  const next: Bot = {
    ...existing,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE bots SET name=?, default_folder=?, activation_mode=?, concurrency_mode=?,
                     status=?, open_id=?, remote_name=?, updated_at=?
     WHERE id = ?`,
  ).run(
    next.name,
    next.default_folder,
    next.activation_mode,
    next.concurrency_mode,
    next.status,
    next.open_id,
    next.remote_name,
    next.updated_at,
    id,
  );
  return next;
}

export function softDeleteBot(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE bots SET deleted_at=?, status='disabled', updated_at=? WHERE id=?`,
  ).run(now, now, id);
}

export function hardDeleteBot(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM bots WHERE id = ?`).run(id);
  // sessions 通过 bot_id 查询后手工清，foreign key 不覆盖（sessions 没有 FK 到 bots）
  db.prepare(`DELETE FROM sessions WHERE bot_id = ?`).run(id);
}

// ── BotGroupBinding CRUD ─────────────────────────────────

export interface UpsertBindingInput {
  bot_id: string;
  group_jid: string;
  folder: string;
  activation_mode?: BotActivationMode | null;
  concurrency_mode?: BotConcurrencyMode | null;
}

export function upsertBinding(input: UpsertBindingInput): BotGroupBinding {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO bot_group_bindings
       (bot_id, group_jid, folder, activation_mode, concurrency_mode, enabled, bound_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    input.bot_id,
    input.group_jid,
    input.folder,
    input.activation_mode ?? null,
    input.concurrency_mode ?? null,
    now,
  );
  const row = db
    .prepare(`SELECT * FROM bot_group_bindings WHERE bot_id=? AND group_jid=?`)
    .get(input.bot_id, input.group_jid) as Record<string, unknown>;
  return rowToBinding(row);
}

export function getBinding(
  botId: string,
  groupJid: string,
): BotGroupBinding | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM bot_group_bindings WHERE bot_id=? AND group_jid=?`)
    .get(botId, groupJid) as Record<string, unknown> | undefined;
  return row ? rowToBinding(row) : null;
}

export function listBindingsByBot(botId: string): BotGroupBinding[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM bot_group_bindings WHERE bot_id=? ORDER BY bound_at DESC`,
    )
    .all(botId) as Record<string, unknown>[];
  return rows.map(rowToBinding);
}

export function listBindingsByGroup(groupJid: string): BotGroupBinding[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM bot_group_bindings WHERE group_jid=? AND enabled=1 ORDER BY bound_at ASC`,
    )
    .all(groupJid) as Record<string, unknown>[];
  return rows.map(rowToBinding);
}

export function removeBinding(botId: string, groupJid: string): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM bot_group_bindings WHERE bot_id=? AND group_jid=?`,
  ).run(botId, groupJid);
}

export function setBindingEnabled(
  botId: string,
  groupJid: string,
  enabled: boolean,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE bot_group_bindings SET enabled=? WHERE bot_id=? AND group_jid=?`,
  ).run(enabled ? 1 : 0, botId, groupJid);
}

// ── PR3: Bot connection state ─────────────────────────────

export function updateBotConnectionState(
  botId: string,
  patch: {
    state: BotConnectionState;
    lastConnectedAt?: string | null;
    consecutiveFailures?: number;
    lastErrorCode?: string | null;
  },
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE bots
       SET connection_state = ?,
           last_connected_at = COALESCE(?, last_connected_at),
           consecutive_failures = COALESCE(?, consecutive_failures),
           last_error_code = ?,
           updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(
    patch.state,
    patch.lastConnectedAt ?? null,
    patch.consecutiveFailures ?? null,
    patch.lastErrorCode !== undefined ? patch.lastErrorCode : null,
    now,
    botId,
  );
}

export function getBotConnectionState(botId: string): {
  state: BotConnectionState;
  last_connected_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT connection_state AS state, last_connected_at,
              consecutive_failures, last_error_code
         FROM bots WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(botId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    state: (row.state ?? 'disconnected') as BotConnectionState,
    last_connected_at: row.last_connected_at == null ? null : String(row.last_connected_at),
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    last_error_code: row.last_error_code == null ? null : String(row.last_error_code),
  };
}
