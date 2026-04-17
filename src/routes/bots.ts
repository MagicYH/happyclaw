/**
 * Bot HTTP API (PR1)
 *
 * 12 个端点实现 v3 §8.5 权限矩阵：
 *   GET    /api/bots                   — 列出当前用户的 Bot（admin 可带 ?user_id= 跨用户查询）
 *   POST   /api/bots                   — 创建 Bot
 *   GET    /api/bots/:id               — 查看单个 Bot
 *   PUT    /api/bots/:id               — 更新 Bot 元数据
 *   PUT    /api/bots/:id/credentials   — 更新飞书凭证
 *   POST   /api/bots/:id/enable        — 启用 Bot
 *   POST   /api/bots/:id/disable       — 禁用 Bot
 *   DELETE /api/bots/:id               — 软删除 Bot
 *   GET    /api/bots/:id/bindings      — 查看 Bot 的绑定
 *   POST   /api/bots/:id/bindings      — 添加 / 更新绑定
 *   DELETE /api/bots/:id/bindings/:groupJid — 删除绑定
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware, authorizeBot } from '../middleware/auth.js';
import {
  createBot,
  listBotsByUser,
  updateBot,
  softDeleteBot,
  upsertBinding,
  listBindingsByBot,
  removeBinding,
} from '../db-bots.js';
import { saveBotFeishuConfig, getSystemSettings } from '../runtime-config.js';
import {
  CreateBotSchema,
  UpdateBotSchema,
  UpdateBotCredentialsSchema,
  UpsertBindingSchema,
} from '../schemas.js';
import { logAuthEvent } from '../db.js';
import { logger } from '../logger.js';
import type { AuthUser, Bot } from '../types.js';

// Extend Variables with bot context set by authorizeBot middleware
type BotsVariables = Variables & { bot: Bot };

export const botsRoutes = new Hono<{ Variables: BotsVariables }>();

botsRoutes.use('*', authMiddleware);

// ── feature flag gate ─────────────────────────────────
botsRoutes.use('*', async (c, next) => {
  const settings = getSystemSettings();
  const user = c.get('user') as AuthUser;
  // admin 不受 flag 限制（灰度阶段 1 仅 admin 可访问）
  if (!settings.enableMultiBot && user.role !== 'admin') {
    return c.json({ error: 'multi-bot not enabled' }, 501);
  }
  return next();
});

// ─────────────────────────────────────────────────────
// GET /api/bots
// ─────────────────────────────────────────────────────
botsRoutes.get('/', async (c) => {
  const user = c.get('user') as AuthUser;
  const queryUserId = c.req.query('user_id');
  if (queryUserId && queryUserId !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const targetUserId = queryUserId ?? user.id;
  return c.json({ bots: listBotsByUser(targetUserId) });
});

// ─────────────────────────────────────────────────────
// POST /api/bots
// ─────────────────────────────────────────────────────
botsRoutes.post('/', async (c) => {
  const user = c.get('user') as AuthUser;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const parsed = CreateBotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  // member 强制 user_id=self
  const targetUserId =
    user.role === 'admin' ? (parsed.data.user_id ?? user.id) : user.id;

  // 检查 maxBotsPerUser 上限
  const settings = getSystemSettings();
  const existing = listBotsByUser(targetUserId);
  if (existing.length >= settings.maxBotsPerUser) {
    return c.json(
      { error: `exceeds maxBotsPerUser=${settings.maxBotsPerUser}` },
      400,
    );
  }

  const bot = createBot({
    user_id: targetUserId,
    name: parsed.data.name,
    channel: parsed.data.channel,
    default_folder: parsed.data.default_folder,
    activation_mode: parsed.data.activation_mode as any,
    concurrency_mode: parsed.data.concurrency_mode,
  });

  // 若同时提供凭证则写入
  if (parsed.data.app_id && parsed.data.app_secret) {
    try {
      saveBotFeishuConfig(bot.id, {
        appId: parsed.data.app_id,
        appSecret: parsed.data.app_secret,
        enabled: true,
      });
    } catch (err) {
      logger.warn(
        { err, botId: bot.id },
        'Failed to save initial Feishu credentials',
      );
    }
  }

  logAuthEvent({
    event_type: 'bot_created',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id, target_user_id: targetUserId, name: bot.name },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ bot }, 201);
});

// ─────────────────────────────────────────────────────
// GET /api/bots/:id
// ─────────────────────────────────────────────────────
botsRoutes.get('/:id', authorizeBot, async (c) => {
  const bot = c.get('bot');
  return c.json({ bot });
});

// ─────────────────────────────────────────────────────
// PUT /api/bots/:id
// ─────────────────────────────────────────────────────
botsRoutes.put('/:id', authorizeBot, async (c) => {
  const bot = c.get('bot');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const parsed = UpdateBotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const updated = updateBot(bot.id, parsed.data as any);
  return c.json({ bot: updated });
});

// ─────────────────────────────────────────────────────
// PUT /api/bots/:id/credentials
// ─────────────────────────────────────────────────────
botsRoutes.put('/:id/credentials', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user') as AuthUser;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const parsed = UpdateBotCredentialsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  saveBotFeishuConfig(bot.id, {
    appId: parsed.data.app_id,
    appSecret: parsed.data.app_secret,
    enabled: true,
  });

  logAuthEvent({
    event_type: 'bot_credentials_updated',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────
// POST /api/bots/:id/enable
// ─────────────────────────────────────────────────────
botsRoutes.post('/:id/enable', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user') as AuthUser;
  const updated = updateBot(bot.id, { status: 'active' });

  logAuthEvent({
    event_type: 'bot_enabled',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ bot: updated });
});

// ─────────────────────────────────────────────────────
// POST /api/bots/:id/disable
// ─────────────────────────────────────────────────────
botsRoutes.post('/:id/disable', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user') as AuthUser;
  const updated = updateBot(bot.id, { status: 'disabled' });

  logAuthEvent({
    event_type: 'bot_disabled',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ bot: updated });
});

// ─────────────────────────────────────────────────────
// DELETE /api/bots/:id
// ─────────────────────────────────────────────────────
botsRoutes.delete('/:id', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user') as AuthUser;
  softDeleteBot(bot.id);

  logAuthEvent({
    event_type: 'bot_deleted',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id, mode: 'soft' },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────
// GET /api/bots/:id/bindings
// ─────────────────────────────────────────────────────
botsRoutes.get('/:id/bindings', authorizeBot, async (c) => {
  const bot = c.get('bot');
  return c.json({ bindings: listBindingsByBot(bot.id) });
});

// ─────────────────────────────────────────────────────
// POST /api/bots/:id/bindings
// ─────────────────────────────────────────────────────
botsRoutes.post('/:id/bindings', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user') as AuthUser;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const parsed = UpsertBindingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  const binding = upsertBinding({
    bot_id: bot.id,
    group_jid: parsed.data.group_jid,
    folder: parsed.data.folder,
    activation_mode: parsed.data.activation_mode as any,
  });

  logAuthEvent({
    event_type: 'bot_binding_added',
    username: user.username,
    actor_username: user.username,
    details: {
      bot_id: bot.id,
      group_jid: parsed.data.group_jid,
      folder: parsed.data.folder,
    },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ binding }, 201);
});

// ─────────────────────────────────────────────────────
// DELETE /api/bots/:id/bindings/:groupJid
// ─────────────────────────────────────────────────────
botsRoutes.delete('/:id/bindings/:groupJid', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user') as AuthUser;
  const groupJid = c.req.param('groupJid');
  removeBinding(bot.id, groupJid);

  logAuthEvent({
    event_type: 'bot_binding_removed',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id, group_jid: groupJid },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ success: true });
});
