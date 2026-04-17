# Multi-Agent 设计文档

**日期**：2026-04-17
**分支**：feature-multi-agent
**状态**：待实现

---

## 1. 背景与目标

### 现状

HappyClaw 目前每个用户只能配置一个飞书 Bot（一个 App ID/App Secret），对应一个主 Agent 实例。多个 IM 群组可以绑定同一个项目 folder，但同一时刻只有一个 Claude session 在运行。

### 目标

允许用户创建多个飞书 Bot，每个 Bot 有独立身份（名称、角色）。多个 Bot 可以同时加入同一个飞书群聊，共享同一个项目的文件系统和群聊记录，协同完成任务。

### 核心需求

1. 每个用户可以创建多个飞书 Bot（独立 App ID/Secret）
2. 每个 Bot 有独立的角色定义（通过 CLAUDE.md 文件配置）
3. 多个 Bot 可以绑定到同一个项目 folder，在同一个飞书群里协作
4. 群内只有被 @mention 的 Bot 才响应消息
5. 所有 Bot 共享项目文件系统和群聊消息记录
6. 同一 folder 内串行执行（不并发），避免文件冲突

---

## 2. 核心概念

### Bot

一个 Bot 是一个独立的飞书应用凭证（App ID + App Secret），同时携带身份信息：

- **名称**：Bot 在飞书里的显示名（即 @名称）
- **角色**：通过 `CLAUDE.md` 文件定义，描述该 Bot 的职责和行为准则
- **渠道**：目前为 `feishu`，架构支持未来扩展到 Telegram/Discord
- **默认项目**：Bot 被拉入新群时自动绑定的 folder

### Agent 实例

一个 Agent 实例 = Bot × 群组 的组合：

- Bot A 在群 G1 → Agent 实例（folder: project-alpha，session: alpha_botA）
- Bot A 在群 G2 → Agent 实例（folder: project-beta，session: beta_botA）
- Bot B 在群 G1 → Agent 实例（folder: project-alpha，session: alpha_botB）

每个实例有独立的 Claude session，但共享 folder 的文件系统。

### 多 Agent 协作模式

```
飞书群 G
├── Bot A（Frontend Engineer）→ project-alpha folder
└── Bot B（Backend Engineer）  → project-alpha folder

用户: @Frontend 写一个登录页
  → 只有 Bot A 响应（Bot B 收到消息但不处理，只入库）

Bot A 完成后：
用户: @Backend 写登录接口
  → 只有 Bot B 响应，且 B 能看到群里 A 刚才说了什么
```

---

## 3. 数据模型

### 3.1 新增 `bots` 表

```sql
CREATE TABLE bots (
  id             TEXT PRIMARY KEY,              -- uuid, e.g. 'bot_abc123'
  user_id        TEXT NOT NULL,                 -- 所属用户
  name           TEXT NOT NULL,                 -- Bot 显示名称（飞书 @名称）
  role           TEXT,                          -- 保留字段（实际角色由 CLAUDE.md 管理）
  channel        TEXT NOT NULL DEFAULT 'feishu',-- 'feishu' | 'telegram' | 'discord'
  default_folder TEXT,                          -- 被拉入新群时自动绑定的项目 folder
  created_at     TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

**凭证存储**：App ID / App Secret 不入库，沿用 AES-256-GCM 加密文件模式：
`data/config/bots/{botId}/feishu.json`，结构与现有 `data/config/user-im/{userId}/feishu.json` 完全一致。

### 3.2 `registered_groups` 新增 `bot_id` 列

```sql
ALTER TABLE registered_groups ADD COLUMN bot_id TEXT;
-- NULL = 使用该用户的默认 IM 连接（全向后兼容）
-- 非 NULL = 使用指定 Bot 的独立连接
```

同一飞书群（`jid`）可以对应多行，每个 Bot 一行：

| jid | name | folder | bot_id |
|-----|------|--------|--------|
| `feishu:oc_yyy` | 研发群 | `project-alpha` | `bot_001` |
| `feishu:oc_yyy` | 研发群 | `project-alpha` | `bot_002` |

### 3.3 `sessions` 表新增 `bot_id` 列

```sql
ALTER TABLE sessions ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';
-- 新 PRIMARY KEY: (group_folder, bot_id, agent_id)
```

| group_folder | bot_id | agent_id | session_id |
|---|---|---|---|
| `project-alpha` | `` | `` | `sess_aaa` ← 旧数据 |
| `project-alpha` | `bot_001` | `` | `sess_bbb` ← Frontend session |
| `project-alpha` | `bot_002` | `` | `sess_ccc` ← Backend session |

### 3.4 `messages` 表新增唯一约束

```sql
-- source_message_id 列（如不存在则新增）
ALTER TABLE messages ADD COLUMN source_message_id TEXT;

-- 防止多 Bot 连接重复写入同一条群消息
CREATE UNIQUE INDEX idx_messages_source_id
  ON messages(chat_jid, source_message_id);
```

所有消息 INSERT 改为 `INSERT OR IGNORE`，同一条飞书消息只入库一次。

### 3.5 Schema 版本

`SCHEMA_VERSION` 升至 v25，`loadState()` 自动执行上述 migration。

---

## 4. 连接管理

### 4.1 IMConnectionManager 双轨结构

```typescript
class IMConnectionManager {
  // 现有：per-user 连接（保持不变，向后兼容）
  private userConnections: Map<string, UserIMConnection>;

  // 新增：per-bot 连接
  private botConnections: Map<string, IMChannel>;
}
```

系统启动时：
1. 遍历所有用户 → 加载 `user-im/{userId}/feishu.json` → 建 `userConnections`（现有逻辑不变）
2. 遍历 `bots` 表 → 加载 `config/bots/{botId}/feishu.json` → 建 `botConnections`

### 4.2 Bot 凭证热管理

与现有 user IM 热重连逻辑完全对称：

- `PUT /api/bots/:id/credentials` → 保存加密凭证 → 断开旧连接 → 建立新连接
- `ignoreMessagesBefore` 设为当前时间戳，避免处理堆积消息

---

## 5. 消息路由

### 5.1 @mention 路由逻辑

```
Bot X 的 WebSocket 连接收到飞书群消息
  ↓
检查 mentions[] 是否包含 Bot X 的 open_id
  ├── 否 → 执行 INSERT OR IGNORE 入库（旁观者模式）
  │         → 结束，不触发 agent
  └── 是 → 执行 INSERT OR IGNORE 入库
             ↓
             查 registered_groups WHERE jid=chatJid AND bot_id=X.id
             ↓
             取出 folder
             ↓
             进入 folder 的串行队列
             ↓
             启动 agent（携带 botId，用于 session 隔离和 CLAUDE.md 加载）
             ↓
             addReaction(messageId, 'OnIt')  ← 已有逻辑，自动触发
```

### 5.2 多 @mention 处理

一条消息 @Bot A @Bot B：

- Bot A 的连接：发现自己被 @，入库 + 加 reaction + 入队
- Bot B 的连接：发现自己被 @，`INSERT OR IGNORE`（消息已存在，忽略重复）+ 加 reaction + 入队

两者入同一 folder 的串行队列，按到达顺序执行。消息入库仅发生一次（唯一约束保证）。

### 5.3 自动注册新群组

Bot X 被拉入新群（`onBotAddedToGroup` 回调）：

1. 查询 Bot X 的默认项目 folder（`bots` 表的 `default_folder` 字段）
2. 创建 `registered_groups` 记录，`bot_id = X.id`，`folder = default_folder`
3. 如果 `default_folder` 为空，群组进入"待绑定"状态，等待管理员在 UI 中手动配置

---

## 6. Agent 上下文

### 6.1 角色文件（CLAUDE.md 双层加载）

每个 `(folder, botId)` 组合有独立的 session 目录：

```
data/sessions/{folder}_{botId}/.claude/CLAUDE.md  ← Bot 的角色定义（用户手动维护）
data/groups/{folder}/CLAUDE.md                     ← 项目上下文（现有）
```

Claude Code 的加载顺序：
1. `~/.claude/CLAUDE.md`（容器内 = Bot 的角色 CLAUDE.md）→ 定义 Bot 是谁、负责什么
2. 项目根目录 `CLAUDE.md` → 定义项目规范、背景

Bot 创建时，`data/sessions/{folder}_{botId}/.claude/CLAUDE.md` 自动生成默认模板：

```markdown
# 角色定义

你是一名 AI 助手，负责协助完成项目中的相关任务。

## 职责范围
- （在此描述你负责的工作）

## 协作准则
- 响应前先查看群聊近期记录，了解上下文
- 与其他 Agent 协作时，明确自己的工作边界
```

用户按需修改此文件即可，无需通过 UI 填写 prompt。

### 6.2 共享文件系统

同一 folder 下所有 Bot agent 实例挂载完全相同的工作目录：

- `data/groups/{folder}/` → `/workspace/group`（所有 Bot 共享读写）
- 串行队列保证同一时刻只有一个 agent 在写

### 6.3 共享群聊记录（旁观者模式）

所有消息（无论是否 @该 Bot）都以 `INSERT OR IGNORE` 存入 `messages` 表，`chat_jid` 为群组 JID。

Agent 被调用时，agent-runner 查询该群最近 N 条消息，格式化后注入上下文：

```
[群聊近期记录]
用户 (10:01): @Frontend 帮我写一个登录页
Frontend: 已完成，代码在 src/pages/Login.tsx，包含表单验证

[当前消息]
用户 (10:05): @Backend 帮我写登录接口，对接上面的登录页
```

N 默认值：20 条，可通过系统配置调整。

### 6.4 Session 隔离

每个 `(folder, botId)` 维护独立的 Claude session（`sessions` 表联合主键区分）。Bot 的 session 只包含该 Bot 自己的对话历史；其他 Bot 的发言通过 6.3 的群聊记录注入，不污染 session 本身，避免 session 无限膨胀。

---

## 7. UI 变化

### 7.1 新增 Bots 管理页（`/bots`）

参考 Skills / MCP Servers 页面模式，侧边栏新增 **Bots** 入口。

**列表视图**：Bot 名称、渠道、连接状态（已连接/断开）、绑定群组数
**操作**：创建、编辑、删除、测试连接

**创建/编辑 Bot**：
- 名称
- 渠道（飞书，可扩展）
- App ID / App Secret
- 默认项目 folder（下拉选已注册的 folder）
- 「编辑角色文件」按钮 → 打开 CLAUDE.md 文本编辑器

### 7.2 群组 Panel 新增 Bot 标签页

ChatView 右侧 Panel 新增 **WorkspaceBotsPanel**，与 GroupMembersPanel 并列：

```
群内 Bots
┌──────────────────────────────────────────────┐
│ Frontend  飞书  [已连接] [编辑角色] [移除]    │
│ Backend   飞书  [已连接] [编辑角色] [移除]    │
│ [+ 添加 Bot 到本群]                          │
└──────────────────────────────────────────────┘
```

「添加 Bot」→ 从已创建的 Bots 中选择，确认后创建 `registered_groups` 记录（`bot_id` 非 null）。

### 7.3 表情回复（无需修改）

`feishu.ts` 现有的 `addReaction(messageId, 'OnIt')` 逻辑在 mention 过滤通过后触发，per-connection 独立执行。多 Bot 场景下，每个被 @的 Bot 独立发送 reaction，天然支持。

### 7.4 Setup 向导调整

`/setup/channels` 的「配置飞书」改为「配置第一个飞书 Bot」，引导用户创建第一个 Bot 实例。首次访问时将现有 `user-im/{userId}/feishu.json` 配置展示为可迁移选项（不强制迁移，用户自主选择）。

---

## 8. 向后兼容

### 完全兼容，纯增量设计

| 场景 | 行为 |
|------|------|
| 现有单 Bot 用户 | 完全不受影响，`bot_id=null` 路径不变 |
| 现有 session 目录 | `data/sessions/{folder}/.claude/` 继续使用 |
| 现有 registered_groups | `bot_id=null`，沿用 per-user 连接路由 |
| 现有消息记录 | `source_message_id=null`，唯一索引对 null 不生效（SQLite 特性：NULL != NULL） |

### Session 目录约定

| 场景 | Session 目录 |
|------|-------------|
| 单 Bot（现有） | `data/sessions/{folder}/.claude/` |
| 多 Bot 中的某个 Bot | `data/sessions/{folder}_{botId}/.claude/` |

---

## 9. 不在本期范围内

- Telegram / Discord 多 Bot（架构支持，但本期只实现飞书）
- Agent 主动发起对话（目前只响应 @mention）
- Bot 之间的直接私聊（当前只支持群聊协作）
- 并发执行（本期串行，后续可按需放开）
- Bot 级别的用量统计拆分
