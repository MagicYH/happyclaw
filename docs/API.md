# HappyClaw Web API 参考

> 本文档从 `CLAUDE.md` §7 拆分而来。修改 / 新增 API 端点时请同步更新。
>
> 顶层 `CLAUDE.md` 只保留路由文件入口索引作为 Agent 快速导航锚点；
> 详细端点清单按需 Read 本文档（每请求约节省 ~1K cache_read tokens）。

## 认证

- `GET /api/auth/status` — 系统初始化状态（`initialized`、是否有用户）
- `POST /api/auth/setup` — 创建首个管理员（仅用户表为空时可用）
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`（含 `setupStatus`）
- `POST /api/auth/register` · `PUT /api/auth/profile` · `PUT /api/auth/change-password`

## 群组

- `GET /api/groups` · `POST /api/groups`（创建 Web 会话）
- `PATCH /api/groups/:jid`（重命名） · `DELETE /api/groups/:jid`
- `POST /api/groups/:jid/reset-session`（重建工作区）
- `GET /api/groups/:jid/messages`（分页 + 轮询，支持多 JID 查询）
- `GET|PUT /api/groups/:jid/env`（群组级容器环境变量）

## 文件

- `GET /api/groups/:jid/files` · `POST /api/groups/:jid/files`（上传，50MB 限制）
- `GET /api/groups/:jid/files/download/:path` · `DELETE /api/groups/:jid/files/:path`
- `POST /api/groups/:jid/directories`

## 记忆

- `GET /api/memory/sources` · `GET /api/memory/search`（全文检索）
- `GET|PUT /api/memory/file`

## 配置

- `GET|PUT /api/config/claude` · `PUT /api/config/claude/secrets`
- `GET|PUT /api/config/claude/custom-env`
- `POST /api/config/claude/test`（连通性测试） · `POST /api/config/claude/apply`（应用到所有容器）
- `GET|PUT /api/config/feishu`（**deprecated**，使用 `/api/config/user-im/feishu` 代替）
- `GET|PUT /api/config/telegram` · `POST /api/config/telegram/test`（**deprecated**，使用 `/api/config/user-im/telegram` 代替）
- `GET|PUT /api/config/appearance` · `GET /api/config/appearance/public`（外观配置，public 端点无需认证）
- `GET|PUT /api/config/system` — 系统运行参数（容器超时、并发限制、`autoCompactWindow` 等），需要 `manage_system_config` 权限
- `GET /api/config/user-im/status`（所有渠道连接状态，含 QQ）
- `GET|PUT /api/config/user-im/feishu`（用户级飞书 IM 配置，GET 返回 `connected` 字段）
- `GET|PUT /api/config/user-im/telegram`（用户级 Telegram IM 配置，GET 返回 `connected`、`effectiveProxyUrl`、`proxySource`，PUT 支持 `proxyUrl`/`clearProxyUrl`）
- `POST /api/config/user-im/telegram/test`（Telegram Bot Token 连通性测试，使用 per-user proxyUrl）
- `GET|PUT /api/config/user-im/qq`（用户级 QQ IM 配置，GET 返回 `connected` 字段）
- `POST /api/config/user-im/qq/test`（QQ 凭据连通性测试）
- `POST /api/config/user-im/qq/pairing-code`（生成 QQ 配对码）
- `GET /api/config/user-im/qq/paired-chats`（已配对的 QQ 聊天列表）
- `DELETE /api/config/user-im/qq/paired-chats/:jid`（移除 QQ 配对）
- `GET|PUT /api/config/user-im/dingtalk`（用户级钉钉 IM 配置，GET 返回 `connected` 字段）

## 任务

- `GET /api/tasks` · `POST /api/tasks` · `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id`
- `GET /api/tasks/:id/logs`

## 管理

- `GET /api/admin/users` · `POST /api/admin/users` · `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id` · `POST /api/admin/users/:id/restore`
- `POST /api/admin/invites` · `GET /api/admin/invites` · `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET|PUT /api/admin/settings/registration`

## Sub-Agent

- `GET /api/groups/:jid/agents` · `POST /api/groups/:jid/agents`（创建 Sub-Agent）
- `DELETE /api/groups/:jid/agents/:agentId`

## 目录浏览

- `GET /api/browse/directories`（列出可选目录，受挂载白名单约束）
- `POST /api/browse/directories`（创建自定义工作目录）

## MCP Servers

- `GET /api/mcp-servers` · `POST /api/mcp-servers`（CRUD，per-user）
- `PATCH /api/mcp-servers/:id` · `DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/sync-host`（从宿主机同步 MCP Server 配置）

## 用量统计

- `GET /api/usage/stats?days=7&userId=&model=`（从 `usage_daily_summary` 查询，支持用户/模型筛选）
- `GET /api/usage/models`（去重模型列表）
- `GET /api/usage/users`（有用量数据的用户列表，admin 可见全部）

## 监控

- `GET /api/status` · `GET /api/health`（无需认证）

## Bot 管理（PR1，需 `ENABLE_MULTI_BOT=true`）

> 所有端点需登录认证（Cookie Session）。创建 / 更新 / 删除操作会写入审计日志。
> Bot 从属于创建者（owner），admin 可查询任意用户的 Bot（传 `?user_id=`）。

- `GET /api/bots` — 列出当前用户的 Bot（admin 可传 `?user_id=` 查询指定用户）
- `POST /api/bots` — 创建 Bot（body: `name`、`channel`、`role`、`description?`；返回 201 + Bot 对象）
- `GET /api/bots/:id` — 获取 Bot 详情（仅 owner 或 admin 可访问，否则 403）
- `PUT /api/bots/:id` — 更新 Bot 元数据（`name`、`role`、`description`）
- `PUT /api/bots/:id/credentials` — 更新飞书凭证（`appId`、`appSecret`；凭证 AES-256-GCM 加密写入 `data/config/bots/{id}/feishu.json`）
- `POST /api/bots/:id/enable` — 启用 Bot（建立飞书 WebSocket 长连接）
- `POST /api/bots/:id/disable` — 停用 Bot（断开连接，`status` 置为 `disabled`）
- `DELETE /api/bots/:id` — 软删除 Bot（`deleted_at` 打时间戳，同时断开连接并级联删除 `bot_group_bindings`）
- `GET /api/bots/:id/bindings` — 列出该 Bot 绑定的群组（返回 `bot_group_bindings` 列表）
- `POST /api/bots/:id/bindings` — 添加 Bot 与群的绑定（body: `groupJid`；重复绑定返回 409）
- `DELETE /api/bots/:id/bindings/:groupJid` — 移除 Bot 与指定群的绑定

## Setup 向导（迁移辅助）

- `POST /api/config/setup/migrate-feishu-to-bot` — Setup 向导：将用户现有 per-user 飞书 IM 配置（`data/config/user-im/{userId}/feishu.json`）迁移为一个 Bot 实体，写入 `bots` 表并创建 `bot_group_bindings`（仅在 `ENABLE_MULTI_BOT=true` 时可用）

## WebSocket

- `/ws`（详见 `CLAUDE.md` §3.6 WebSocket 协议）
