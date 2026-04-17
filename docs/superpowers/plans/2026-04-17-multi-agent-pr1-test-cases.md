# Multi-Agent PR1 测试用例文档

**范围：** PR1（多 Bot 基础 + writer-only，详见 `2026-04-17-multi-agent-pr1.md`）
**日期：** 2026-04-17
**测试层级：** 单元测试（Unit）+ 集成测试（Integration）+ 端到端测试（E2E）
**目标覆盖率：** ≥80%（按 common 规则）

---

## 1. 测试策略与工具

### 1.1 测试金字塔

```
         ┌──────────────┐
         │  E2E (7+)    │  真实 HTTP + 真实 DB，少量关键用户旅程
         ├──────────────┤
         │ Integration  │  多模块协作（路由+DB+连接）
         │   (12+)      │
         ├──────────────┤
         │     Unit     │  纯函数、单模块，覆盖率主力
         │    (45+)     │
         └──────────────┘
```

### 1.2 工具栈

| 层级 | 工具 | 说明 |
|------|------|------|
| Unit | Vitest 4.1（现有） | `tests/units/*.test.ts` |
| Integration | Vitest + better-sqlite3（真实 SQLite in tmpdir） | `tests/integration/*.test.ts`（新增目录） |
| E2E (API) | Vitest + Hono 内置 `app.request()` | `tests/e2e/*.test.ts`（新增目录），**无需起真实 HTTP 端口** |
| E2E (Web UI) | ❌ 本 PR 无前端，推迟到 PR3 | - |

Hono 的 `app.request()` 允许直接在 Node 进程内调用路由，不需要真实 socket，可用的同时又覆盖了完整的中间件链、鉴权、Zod 校验、DB 交互。这在 PR1 阶段是"最真实的端到端"，又不引入 supertest / Docker 等重型依赖。

### 1.3 隔离机制

所有测试都使用**临时 DATA_DIR**（`fs.mkdtempSync`），每个 `beforeEach` 重新 init 数据库；每个 `afterEach` 清理目录。避免跨测试污染，也避免影响开发环境。

### 1.4 Mock 策略

- **飞书 SDK（`@larksuiteoapi/node-sdk`）**：统一通过 `im-channel.ts` 的工厂函数 mock，不走网络
- **加密模块 / AES**：**不 mock**，测试真实加密读写
- **时间**：如需 `Date.now()` 控制，用 `vi.useFakeTimers()`
- **Feishu 消息推送**：E2E 测试中通过调用 mock channel 的 emit 方法模拟消息到达

---

## 2. 测试覆盖矩阵

| Feature | Unit | Integration | E2E | 合计 |
|---------|------|-------------|-----|------|
| Schema / Migration | UT-01 ~ UT-06 | IT-01 ~ IT-02 | - | 8 |
| Bot CRUD (DB) | UT-07 ~ UT-14 | IT-03 | - | 9 |
| Bot 凭证加密 | UT-15 ~ UT-18 | IT-04 | - | 5 |
| IMConnectionManager | UT-19 ~ UT-23 | IT-05 | - | 6 |
| 路由分叉 | UT-24 ~ UT-28 | IT-06 ~ IT-07 | E2E-03 | 8 |
| Feishu open_id 安全 | UT-29 ~ UT-31 | IT-08 | - | 4 |
| Bot HTTP API | UT-32 ~ UT-35 | IT-09 ~ IT-10 | E2E-01, E2E-02, E2E-05 | 9 |
| 权限矩阵 | UT-36 ~ UT-39 | IT-11 | E2E-04 | 6 |
| Setup 迁移 | UT-40 ~ UT-42 | IT-12 | E2E-06 | 5 |
| 审计事件 | UT-43 | - | E2E-07 | 2 |
| Feature Flag | UT-44 ~ UT-46 | - | E2E-08 | 4 |
| messages IGNORE | UT-47 ~ UT-48 | - | - | 2 |
| 向后兼容 | - | IT-13 ~ IT-14 | E2E-09, E2E-10 | 4 |
| **合计** | **48** | **14** | **10** | **72** |

---

## 3. 单元测试用例（Unit Tests，48 条）

### 3.1 Schema & Migration（UT-01 ~ UT-06）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-01 | `schema_version` 升级到 35 | 空 DB，调用 `initDb()` | - | `SELECT value FROM router_state WHERE key='schema_version'` = `'35'` | 🔴 P0 |
| UT-02 | `bots` 表所有字段存在且类型正确 | 空 DB init | `PRAGMA table_info('bots')` | 13 列按 v3 §3.3 顺序 | 🔴 P0 |
| UT-03 | `bot_group_bindings` 复合主键 | 空 DB init | `PRAGMA index_list('bot_group_bindings')` | 含 unique=1 的复合索引 | 🔴 P0 |
| UT-04 | `sessions.bot_id` 列默认 `''` | 空 DB init | `PRAGMA table_info('sessions')` | `bot_id` 列 default=`''` | 🔴 P0 |
| UT-05 | `PRAGMA foreign_keys` 返回 1 | 空 DB init | `db.prepare('PRAGMA foreign_keys').get()` | `{ foreign_keys: 1 }` | 🔴 P0 |
| UT-06 | `sync_bgb_folder_on_rg_update` 触发器存在 | 空 DB init | `SELECT name FROM sqlite_master WHERE type='trigger'` | 含该触发器 | 🔴 P0 |

### 3.2 外键 CASCADE 行为（UT-07 ~ UT-09，属于 Schema 组）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-07 | 删 user 级联删 bots | 插入 user + bot | `DELETE FROM users WHERE id=?` | `bots` 对应行被删 | 🔴 P0 |
| UT-08 | 删 bot 级联删 bindings | 插入 bot + binding | `DELETE FROM bots WHERE id=?` | `bot_group_bindings` 对应行被删 | 🔴 P0 |
| UT-09 | 删 registered_group 级联删 bindings | 插入 rg + bot + binding | `DELETE FROM registered_groups WHERE jid=?` | `bot_group_bindings` 对应行被删 | 🔴 P0 |

### 3.3 触发器行为（UT-10）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-10 | `registered_groups.folder` 变更级联到 `bot_group_bindings.folder` | 插入 rg + binding | `UPDATE registered_groups SET folder='new' WHERE jid=?` | `bot_group_bindings.folder='new'` | 🔴 P0 |

### 3.4 Bot CRUD（UT-11 ~ UT-18）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-11 | `createBot` 生成合法 id 和默认字段 | 有 user | `createBot({ user_id, name, channel })` | `id` 匹配 `/^bot_[a-zA-Z0-9_-]{8,}$/`，status='active'，concurrency_mode='writer'，deleted_at=null | 🔴 P0 |
| UT-12 | `getBotById` 默认排除软删除 | 已创建 Bot，已软删 | `getBotById(id)` | `null` | 🔴 P0 |
| UT-13 | `getBotById { includeDeleted: true }` 返回软删除的 Bot | 同上 | `getBotById(id, { includeDeleted: true })` | Bot 对象 | 🟠 P1 |
| UT-14 | `listBotsByUser` 按 user_id 过滤 + 排除软删除 | 2 个 user，各 1 个 Bot | `listBotsByUser('u1')` | 只返回 u1 的 Bot | 🔴 P0 |
| UT-15 | `updateBot` patch 字段并更新 `updated_at` | 已创建 Bot | `updateBot(id, { name: 'X' })` | name 已改，`updated_at >= origUpdated` | 🔴 P0 |
| UT-16 | `softDeleteBot` 置 `deleted_at` 和 `status='disabled'` | 已创建 Bot | `softDeleteBot(id)` | 查询该 Bot（includeDeleted）返回 `deleted_at!=null` 且 `status='disabled'` | 🔴 P0 |
| UT-17 | `hardDeleteBot` 删除 Bot 与 sessions | 已创建 Bot + session | `hardDeleteBot(id)` | `bots` 行消失，`sessions WHERE bot_id=id` 为空 | 🟠 P1 |
| UT-18 | `listAllActiveBots` 过滤 status 和 deleted_at | 3 个 Bot（1 active / 1 disabled / 1 softDeleted） | `listAllActiveBots()` | 只返回 1 个（status=active 且 deleted_at=null） | 🔴 P0 |

### 3.5 BotGroupBinding CRUD（UT-19 ~ UT-23）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-19 | `upsertBinding` 插入新绑定 | 已有 bot + rg | `upsertBinding({ bot_id, group_jid, folder })` | enabled=true，folder 匹配 | 🔴 P0 |
| UT-20 | `upsertBinding` 幂等（IGNORE 语义） | 已有绑定 folder='f' | `upsertBinding({ ..., folder: 'f2' })` | 仅一行，folder 保留为 'f' | 🔴 P0 |
| UT-21 | `listBindingsByBot` 返回该 Bot 全部绑定 | Bot 有 3 个绑定 | `listBindingsByBot(id)` | length=3 | 🔴 P0 |
| UT-22 | `listBindingsByGroup` 只返回 enabled=1 的 | 2 个 Bot 绑定同群，1 个 enabled / 1 个 disabled | `listBindingsByGroup(jid)` | length=1 | 🔴 P0 |
| UT-23 | `removeBinding` 精确删除 | 2 个绑定 | `removeBinding(botId, jid1)` | 只剩 1 个 | 🔴 P0 |

### 3.6 Bot 凭证加密（UT-24 ~ UT-27）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-24 | `saveBotFeishuConfig` 写入 0600 权限文件 | DATA_DIR 临时目录 | `saveBotFeishuConfig('bot_a', {...})` | 文件存在，mode & 0o777 = 0o600 | 🔴 P0 |
| UT-25 | 文件内容为密文（不含明文 secret） | 同上 | `readFileSync(...)` | 不含明文 `appSecret` | 🔴 P0 |
| UT-26 | `getBotFeishuConfig` 解密返回正确凭证 | 已 save | `getBotFeishuConfig('bot_a')` | `appId/appSecret/enabled` 与 save 入参一致 | 🔴 P0 |
| UT-27 | `getBotFeishuConfig` 未知 Bot 返回 null | 空 DATA_DIR | `getBotFeishuConfig('bot_missing')` | `null` | 🟠 P1 |

### 3.7 IMConnectionManager per-bot（UT-28 ~ UT-31）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-28 | `connectBot` 新增连接到 Map | Mock `createFeishuChannel` | `mgr.connectBot(input)` | `hasBotConnection('bot_a')=true`，`channel.connect` 调用 1 次 | 🔴 P0 |
| UT-29 | `disconnectBot` 断开并移除 | 已 connect | `mgr.disconnectBot('bot_a')` | `hasBotConnection=false`，`channel.stop` 调用 1 次 | 🔴 P0 |
| UT-30 | `reconnectBot` 先 stop 再 connect，携带 `ignoreMessagesBefore` | 已 connect | `mgr.reconnectBot(input)` | `stop/connect` 各 1 次，`connect` 入参含 `ignoreMessagesBefore>0` | 🔴 P0 |
| UT-31 | `disconnectAllBots` 并行关闭所有连接 | 2 个 bot 已连 | `mgr.disconnectAllBots()` | Map 为空，两个 `stop` 均调用 | 🟠 P1 |

### 3.8 Feishu connectionKind & open_id（UT-32 ~ UT-34）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-32 | `shouldProcessWhenBotOpenIdMissing('user')` 返回 true | - | `'user'` | `true` | 🔴 P0 |
| UT-33 | `shouldProcessWhenBotOpenIdMissing('bot')` 返回 false | - | `'bot'` | `false` | 🔴 P0 |
| UT-34 | bot 连接空 open_id 收到消息打 warn 日志 | mock logger | 处理一条群消息（botOpenId=null，kind='bot'） | logger.warn 被调用 1 次，消息丢弃 | 🟠 P1 |

### 3.9 路由分叉（UT-35 ~ UT-39）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-35 | user kind 走 registered_groups | deps 含 rg | `resolveRouteTarget('user', jid, undefined, deps)` | `{ folder, botId: '' }` | 🔴 P0 |
| UT-36 | bot kind 走 bot_group_bindings | deps 含 binding | `resolveRouteTarget('bot', jid, botId, deps)` | `{ folder, botId }` | 🔴 P0 |
| UT-37 | binding 禁用返回 null | binding enabled=false | 同上 | `null` | 🔴 P0 |
| UT-38 | user kind 未注册群组返回 null | deps 无 rg | `resolveRouteTarget('user', jid, undefined, deps)` | `null` | 🔴 P0 |
| UT-39 | bot kind 无 botId 返回 null | - | `resolveRouteTarget('bot', jid, undefined, deps)` | `null` | 🟠 P1 |

### 3.10 Bot HTTP API（UT-40 ~ UT-43，测 handler 纯逻辑，不走 HTTP）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-40 | `authorizeBot` admin 通过 | user=admin | 调用中间件 | `next()` 被调用，`c.set('bot', ...)` | 🔴 P0 |
| UT-41 | `authorizeBot` member 访问自己的 Bot 通过 | user=u1, bot.user_id=u1 | 同上 | `next()` 被调用 | 🔴 P0 |
| UT-42 | `authorizeBot` 跨用户拒绝 | user=u2, bot.user_id=u1 | 同上 | `c.json({ error: 'forbidden' }, 403)`，`next()` 未调用 | 🔴 P0 |
| UT-43 | `authorizeBot` 不存在的 Bot 返回 404 | bot=null | 同上 | `c.json({ error: 'not found' }, 404)` | 🟠 P1 |

### 3.11 Setup 向导迁移（UT-44 ~ UT-46）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-44 | 迁移成功路径 | 已有 user-im 配置 | `migrateUserImToBot('u1', { botName: 'X' })` | 返回新 Bot，凭证在 `config/bots/{id}/` | 🔴 P0 |
| UT-45 | 迁移后删除老 user-im 文件 | 同上 | 迁移后 | `config/user-im/u1/feishu.json` 不存在 | 🔴 P0 |
| UT-46 | 无老配置时抛错 | 无 user-im | `migrateUserImToBot('u1', ...)` | throw `/no user-im config/` | 🟠 P1 |

### 3.12 审计事件（UT-47）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-47 | `AuthEventType` 包含所有新增类型 | typecheck | - | 编译通过 | 🟠 P1 |

### 3.13 Feature Flag（UT-48 ~ UT-50）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-48 | `enableMultiBot` 默认 false | 空 settings | `getSystemSettings()` | `enableMultiBot=false` | 🔴 P0 |
| UT-49 | `maxBotsPerMessage` 默认 3 | 同上 | 同上 | `maxBotsPerMessage=3` | 🟠 P1 |
| UT-50 | `maxBotsPerUser` 默认 10 | 同上 | 同上 | `maxBotsPerUser=10` | 🟠 P1 |

### 3.14 messages INSERT OR IGNORE（UT-51 ~ UT-52）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-51 | 重复 `(id, chat_jid)` 第一次写入胜出 | 第一次写入 sender1/content1 | 第二次写 sender2/content2 | 查询字段 = 第一次入参 | 🔴 P0 |
| UT-52 | 不同 `(id, chat_jid)` 正常 2 行 | - | 两次写不同 chat_jid | 查出 2 行 | 🟠 P1 |

---

## 4. 集成测试用例（Integration Tests，14 条）

集成测试跨多个模块（真实 DB + 真实加密 + mock IM 层），目录 `tests/integration/`。

| ID | 目标 | 跨越模块 | 步骤 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| IT-01 | 完整 migration 路径（v34 → v35 幂等） | `db.ts`、所有表 | 1. 先模拟 v34 schema（手工 CREATE TABLE 不含新表）<br>2. 调用 `initDb()` 触发迁移<br>3. 再调用一次 `initDb()` 验证幂等 | 第一次迁移成功，第二次无异常，表结构一致 | 🔴 P0 |
| IT-02 | 回滚行为：迁移中断后表状态一致 | `db.ts` | 在迁移中间步骤故意 `throw`，捕获异常后查 schema | schema_version 未推进到 35，不留下半成品表 | 🟠 P1 |
| IT-03 | CreateBot + 凭证 + binding 一次完成 | `db-bots.ts`、`runtime-config.ts` | 1. createBot<br>2. saveBotFeishuConfig<br>3. upsertBinding | 三步都成功，读回一致 | 🔴 P0 |
| IT-04 | 凭证加密文件在 Bot 硬删除后需手工清理（目前预期保留） | `db-bots.ts`、`runtime-config.ts` | 1. 创建 Bot + 保存凭证<br>2. `hardDeleteBot`<br>3. 检查文件 | 文件仍在（PR1 不做级联清理，PR2 补齐） | 🟡 P2（回归用）|
| IT-05 | `IMConnectionManager.connectBot` 读取凭证文件并建立连接 | `im-manager.ts`、`runtime-config.ts`（mock 飞书 channel 工厂） | 1. saveBotFeishuConfig<br>2. `loadBotConnections([bot], deps)` | `connectBot` 被调 1 次，入参含正确 appId | 🔴 P0 |
| IT-06 | Bot 路由：用户发消息 @ Bot → agent 入队 | `resolveRouteTarget` + 真实 DB | 1. 建 Bot + binding<br>2. 调用 resolveRouteTarget('bot', jid, botId, 真实 deps) | 返回正确 folder 和 botId | 🔴 P0 |
| IT-07 | 单 Bot 老路径：user 连接入口走老 resolver | `resolveRouteTarget` + registered_groups | 1. 插入 registered_groups 行<br>2. resolveRouteTarget('user', jid, undefined, 真实 deps) | 返回正确 folder，botId='' | 🔴 P0 |
| IT-08 | open_id 未回填时 bot 连接直接丢弃消息 | `feishu.ts` + `im-manager.ts` | 模拟 bot 连接在 `open_id=null` 时收到消息 | logger.warn 触发，未进入队列 | 🟠 P1 |
| IT-09 | Bot 创建 API（POST /api/bots）完整流程 | 路由 + 中间件 + DB | 1. admin 登录<br>2. `app.request` POST `/api/bots`<br>3. 读 bots 表 | 返回 201，DB 存在该 Bot，审计日志有 `bot_created` | 🔴 P0 |
| IT-10 | 绑定 API（POST /api/bots/:id/bindings） | 路由 + authorizeBot + DB | 1. 建 Bot<br>2. 调用绑定 API | 201，binding 存在 | 🔴 P0 |
| IT-11 | 跨用户绑定他人 Bot 被拒 | `authorizeBot` + 路由 | member B 请求 POST `/api/bots/{A_bot_id}/bindings` | 403 | 🔴 P0 |
| IT-12 | Setup 迁移后 Bot + 凭证 + 无老文件 | `migrateUserImToBot` + DB + 文件系统 | 1. saveUserFeishuConfig<br>2. 调用迁移 API<br>3. 查 Bot 表、凭证文件、老文件 | Bot 存在，凭证可解密，老文件已删 | 🔴 P0 |
| IT-13 | 现有单 Bot 用户升级后 registered_groups 路由零变化 | migration + routing | 1. 准备 v34 DB + user-im 配置<br>2. 跑 v35 migration<br>3. 真实消息路由 | 单 Bot 用户路由结果与 v34 完全一致 | 🔴 P0 |
| IT-14 | `storeMessageDirect` 改为 IGNORE 后，现有重复写入不刷字段 | `db.ts` | 老行为中的重复写入（含 REPLACE 刷新期望）| 第一次写入保持，字段不被第二次覆盖 | 🔴 P0 |

---

## 5. 端到端测试用例（E2E Tests，10 条）

**工具：** Vitest + Hono `app.request()`，在 Node 进程内模拟 HTTP 请求。每个 E2E 测试都走完整的：中间件链 → Zod 校验 → 路由 handler → DB → 审计日志。

### 5.1 用户旅程 E2E

#### E2E-01：Member 完整 Bot 生命周期（Happy Path）

**目标：** Member 用户从零创建 Bot、配置凭证、绑定群、列表、停用、删除的完整流程。

**前置条件：**
- `enableMultiBot=true`
- 已有 member 用户 `alice`，有效 session cookie

**步骤：**

```
1. POST /api/bots { name: 'My Bot', channel: 'feishu', app_id: 'cli_x', app_secret: 'y' }
   → 期望 201，返回 bot.id
2. GET /api/bots
   → 期望 200，列表含该 Bot
3. GET /api/bots/{id}
   → 期望 200，Bot 详情
4. POST /api/bots/{id}/bindings { group_jid: 'feishu:g1', folder: 'home-alice' }
   → 期望 201（注意：必须先准备 registered_groups 里有 feishu:g1）
5. GET /api/bots/{id}/bindings
   → 期望 200，含该 binding
6. PUT /api/bots/{id} { name: 'My Renamed Bot' }
   → 期望 200
7. PUT /api/bots/{id}/credentials { app_id: 'cli_y', app_secret: 'z' }
   → 期望 200，文件已更新
8. POST /api/bots/{id}/disable
   → 期望 200，DB status='disabled'
9. DELETE /api/bots/{id}
   → 期望 200，GET /api/bots 返回列表不含该 Bot（软删除隐藏）
```

**期望结果：**
- 所有步骤返回成功状态码
- 数据库状态与期望一致
- 审计日志含 `bot_created`、`bot_binding_added`、`bot_credentials_updated`、`bot_disabled`、`bot_deleted`

**优先级：** 🔴 P0

---

#### E2E-02：Admin 跨用户管理 Bot

**目标：** admin 可以查看和管理任意 member 的 Bot。

**前置条件：** admin 用户 + member `alice` 已创建 Bot

**步骤：**

```
1. 登录 admin
2. GET /api/bots?user_id=u_alice
   → 期望 200，返回 alice 的 Bot 列表
3. PUT /api/bots/{alice_bot_id} { name: 'Admin Renamed' }
   → 期望 200
4. DELETE /api/bots/{alice_bot_id}
   → 期望 200
```

**期望结果：** admin 所有操作成功，审计日志 `actor_username='admin'`，`username='alice'`

**优先级：** 🔴 P0

---

#### E2E-03：多 Bot 同群路由命中

**目标：** 验证一条 @Bot A 的消息只命中 Bot A 的连接、只入 A 对应的 folder 队列。

**前置条件：**
- 两个 Bot（A、B）分别绑定到 group `feishu:g1`，folder 相同 `home-alice`
- Mock 飞书消息：`mentions = [{ id: { open_id: A.open_id } }]`

**步骤：**

```
1. 准备 2 个 BotConnection（mock channel）
2. 模拟消息推送到 A 的连接：resolveRouteTarget('bot', 'feishu:g1', A.id, deps)
   → 期望 { folder: 'home-alice', botId: A.id }
3. 模拟同一消息推送到 B 的连接，检查 mention 列表不含 B
   → 期望 B 端过滤 → 不进入队列
```

**期望结果：**
- A 正常路由
- B 被过滤（路径：shouldProcessGroupMessage / mention 检查返回 false）
- 同一条 message.id 在 DB 里 INSERT OR IGNORE 只有一行

**优先级：** 🔴 P0

---

#### E2E-04：跨租户权限攻击被拒

**目标：** member `eve` 尝试通过各种方式获取 member `victim` 的 Bot 资源，全部返回 403 / 404。

**前置条件：** eve 和 victim 都是 member；victim 已有一个 Bot `victim_bot`

**步骤（每个步骤独立断言）：**

```
1. eve GET /api/bots?user_id=u_victim  → 期望 403
2. eve GET /api/bots/{victim_bot.id}   → 期望 403
3. eve PUT /api/bots/{victim_bot.id} { name: 'hacked' } → 期望 403
4. eve PUT /api/bots/{victim_bot.id}/credentials { ... } → 期望 403
5. eve POST /api/bots/{victim_bot.id}/enable  → 期望 403
6. eve DELETE /api/bots/{victim_bot.id}  → 期望 403
7. eve GET /api/bots/{victim_bot.id}/bindings  → 期望 403
8. eve POST /api/bots/{victim_bot.id}/bindings { ... } → 期望 403
9. eve POST /api/bots  { name: 'X', channel: 'feishu', user_id: 'u_victim' }
   → 期望 201 但 bot.user_id == 'u_eve'（member 强制 self）
```

**期望结果：** 所有越权尝试被拒；步骤 9 验证 member 无法通过 body 字段篡改归属

**优先级：** 🔴 P0（安全）

---

#### E2E-05：Zod 校验与边界输入

**目标：** 异常入参被 Zod 拦截，返回明确错误。

**步骤：**

```
1. POST /api/bots { name: '' }                     → 400
2. POST /api/bots { name: 'A', channel: 'wechat' } → 400（channel 必须 feishu）
3. POST /api/bots { name: '<script>alert()</script>' } → 400（正则拒绝）
4. POST /api/bots { name: 'a'.repeat(51) }         → 400（长度超限）
5. PUT /api/bots/invalid_id/profile                → 400（botId 格式错误，虽然 PR1 无 profile 端点，留待 PR2，但 id 正则校验应在 authorize 前完成）
6. POST /api/bots（合法 name，但用户已有 maxBotsPerUser 个 Bot） → 400（超上限）
```

**期望结果：** 所有非法入参返回 400，error 字段包含 Zod issues 或明确信息

**优先级：** 🔴 P0

---

#### E2E-06：Setup 向导迁移端到端

**目标：** 现有单 Bot 用户通过 UI 迁移到多 Bot 架构。

**前置条件：**
- 用户 alice 已有 `data/config/user-im/u_alice/feishu.json`
- `enableMultiBot=true`

**步骤：**

```
1. 登录 alice
2. POST /api/config/setup/migrate-feishu-to-bot { bot_name: 'Alice Migrated' }
   → 期望 200，返回新 Bot
3. GET /api/bots
   → 期望含 1 个新 Bot
4. GET /api/config/user-im/feishu
   → 期望 404 或 config.exists=false
5. 文件系统检查：
   - data/config/bots/{bot_id}/feishu.json 存在
   - data/config/user-im/u_alice/feishu.json 不存在
6. 审计日志含 `user_im_migrated_to_bot`
```

**期望结果：** 迁移原子性（Bot 创建 + 老文件删除），无双连接并存

**优先级：** 🔴 P0

---

#### E2E-07：审计日志完整性

**目标：** 所有敏感操作都写入 `auth_audit_log`，字段完整。

**步骤：**

```
1. 创建 Bot → 检查有 bot_created 事件
2. 更新凭证 → bot_credentials_updated
3. 启用 / 停用 → bot_enabled / bot_disabled
4. 添加 / 删除绑定 → bot_binding_added / bot_binding_removed
5. 软删除 → bot_deleted
6. 迁移 → user_im_migrated_to_bot
```

每条审计记录断言：
- `event_type` 正确
- `username` 是被操作用户
- `actor_username` 是执行者
- `details` JSON 含 `bot_id`
- `ip_address`、`user_agent` 非空（取自 header）
- `created_at` 是有效 ISO 时间戳

**优先级：** 🟠 P1（合规性）

---

#### E2E-08：Feature Flag 关闭时行为

**目标：** `enableMultiBot=false` 时，Bot API 返回 501，但 admin 不受限（灰度阶段 1）。

**步骤：**

```
1. 设置 enableMultiBot=false
2. member alice 请求：
   - GET /api/bots       → 期望 501
   - POST /api/bots {...} → 期望 501
3. admin 请求：
   - GET /api/bots       → 期望 200（admin 不受限，可进行灰度）
4. 关闭 flag 后，现有已创建 Bot 不会被连接（loadState 跳过）：
   - 重启后查 `imManager.listBotConnectionIds()` → 空数组
```

**期望结果：** flag 严格守护 member 访问；admin 可用于灰度

**优先级：** 🔴 P0（灰度回滚能力）

---

### 5.2 向后兼容 E2E

#### E2E-09：现有单 Bot 用户升级全路径

**目标：** 已有用户完整升级 v34 → v35 后，所有原有 API 和 IM 连接行为 100% 不变。

**前置条件：** 准备一份 v34 DB dump（含 users / registered_groups / user-im 配置 / sessions 数据）

**步骤：**

```
1. 加载 v34 DB 到临时目录
2. 启动服务（触发 migration）
3. 访问现有 API：
   - GET /api/config/user-im/feishu    → 返回原配置
   - GET /api/groups                   → 原数据
   - GET /api/messages                 → 原消息列表
4. 模拟飞书消息：
   - resolveRouteTarget('user', jid, undefined, deps) → 返回原 folder
5. 检查 schema_version = '35'
6. 检查未创建任何 Bot（bots 表为空）
7. 检查 PRAGMA foreign_keys=1 启用后现有 FK 未导致数据丢失
```

**期望结果：** 对老用户是完全透明升级

**优先级：** 🔴 P0（向后兼容）

---

#### E2E-10：多连接并存（user + bot）

**目标：** 用户同时有老 `user-im` 连接和新 Bot 连接（未迁移场景）时，两条路径独立运作互不干扰。

**前置条件：** alice 有 user-im/feishu.json + 1 个新创建的 Bot

**步骤：**

```
1. loadState 启动后：
   - userConnections.has('u_alice') = true
   - botConnections.has(bot_a.id) = true
2. 向 user 连接 mock 一条消息 → 走老路径 resolveRouteTarget('user', ...)
3. 向 bot 连接 mock 一条消息 → 走新路径 resolveRouteTarget('bot', ..., bot_a.id, ...)
4. 两条消息分别入各自的 folder 队列（queue enqueue 调用 2 次）
```

**期望结果：** 两条路径零干扰，新旧数据独立

**优先级：** 🟠 P1

---

## 6. 回归测试清单

在 PR1 合并前，必须通过以下**现有测试**全部继续通过（零回归）：

| 类别 | 测试文件 | 重点关注 |
|------|---------|---------|
| IM Command | `tests/im-command-utils.test.ts` | Slash 命令逻辑不受路由分叉影响 |
| Message History | `tests/history-image-prune.test.ts` | 消息入库改 IGNORE 后历史清理不变 |
| DingTalk Card | `tests/dingtalk-streaming-card.test.ts` | 其他 IM 渠道无回归 |
| Session | `tests/session-history.test.ts` | `sessions.bot_id` 加列不破坏现有查询 |

**执行方式：** `make test`，期望 100% 通过。

---

## 7. 非功能性测试（可选，优先级 🟡 P2）

本组不是 PR1 的强制通过项，但建议在 PR2 前补齐。

| ID | 目标 | 测试方法 |
|----|------|---------|
| NF-01 | 100 个 Bot 并发路由性能 | 创建 100 个 Bot 绑定同 group，模拟消息路由，P99 < 50ms |
| NF-02 | DB migration 大数据量 | 预填 10 万条 messages + 1 万 sessions，跑 v35 migration，耗时 < 30s |
| NF-03 | 凭证文件泄露场景 | 故意把 `config/bots/*/feishu.json` 文件权限改成 0644，验证启动时告警 |
| NF-04 | 路径遍历攻击（虽然 PR1 无 profile API，但验证 botId 校验正则） | 测 `authorizeBot` 对 `../` / `..%2f` 等恶意 botId 的 404 响应 |

---

## 8. 测试执行计划

### 8.1 PR1 开发期（每个 Task 完成后）

```bash
# 单元测试（快速反馈）
npx vitest run tests/units/

# 集成测试
npx vitest run tests/integration/

# 端到端
npx vitest run tests/e2e/

# 类型检查
make typecheck
```

### 8.2 PR 提交前

```bash
make test  # 全量
```

要求：**全绿 + 覆盖率报告 ≥ 80%**

### 8.3 CI 集成

`make test` 作为 CI 默认 job；新增 E2E 测试需进入 CI 的 job 列表（vitest 的 `tests/e2e/` 目录会被默认扫描，无需额外配置）。

---

## 9. 优先级汇总

| 优先级 | Unit | Integration | E2E | 合计 | 说明 |
|--------|------|-------------|-----|------|------|
| 🔴 P0 | 37 | 11 | 7 | **55** | 必须全通过才能合 PR |
| 🟠 P1 | 11 | 3 | 3 | **17** | 应该通过；允许 1-2 条 flaky 进 quarantine |
| 🟡 P2 | 0 | 0 | 4 (NF) | **4** | 非功能，PR1 非强制 |
| **合计** | 48 | 14 | 14 | **76** | |

---

## 10. 风险与未覆盖

### 已知不测（超出 PR1 范围）

- advisor 写保护（PreToolUse Hook）→ PR2
- bot-profile 编辑 API 路径遍历 → PR2
- scratch 目录 → PR2
- 前端 UI 流程 → PR3
- 监控指标端到端 → PR3
- Bash subprocess 绕过 Hook（本 PR 不涉及）

### 测试未完全覆盖的风险

| 风险点 | 原因 | 缓解 |
|--------|------|------|
| 真实飞书 WebSocket 行为 | 测试全部 mock channel | PR1 合并后做一次**手工灰度**：admin 自己创建 Bot 加群验证 |
| `foreign_keys = ON` 启用后现有 FK 意外级联 | Task 0 FK 审计是纸面文档 | 审计报告需有另一位工程师交叉 review |
| 多 Bot 高并发场景 | 本 PR 测试是顺序的 | 见 NF-01，留 PR2 前补 |
| Migration 事务原子性 | 模拟"故意失败"的测试依赖 DB driver 行为 | IT-02 已覆盖基础场景，生产可先在 staging 跑一次 |

---

**文档结束**
