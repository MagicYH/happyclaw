# Multi-Agent 设计文档 v2

**日期**：2026-04-17
**分支**：feature-multi-agent
**状态**：待实现（v2 — 已纳入 Opus review 反馈）
**基线 SCHEMA_VERSION**：v34（当前线上版本） → v35（本期目标）

---

## 0. 变更说明（相对 v1）

本版本基于 v1 设计文档 `2026-04-17-multi-agent-design.md` 和代码分析 `2026-04-17-im-context-bindings-analysis.md`，逐项修正 Opus review 指出的 P0/P1 问题。

| # | 关注点 | v1 方案 | v2 方案 | 对应 Review |
|---|---|---|---|---|
| 1 | Schema 版本号 | v24 → v25 | **v34 → v35**（以当前线上为准） | P0-1 |
| 2 | `registered_groups` 主键 | 改成 `(jid, bot_id)` 复合主键 | **保持 `jid` PK 不变**，新增独立 `bot_group_bindings` 表承载多对多关系 | P0-2 |
| 3 | Bot 与 `agents` 表关系 | 语焉不详 | **明确不复用**：Bot ≠ SubAgent（见 §2.4 理由） | P0-3 |
| 4 | 群聊 @mention 门控 | 自己写路由判断 | **复用 `activation_mode='when_mentioned'`**，Bot 层仅负责判定"自己是否被 @" | P0-4 |
| 5 | 消息去重 | 新增 `source_message_id` + UNIQUE INDEX | **移除**：`messages` 已有 `(id, chat_jid)` PK，`id` 就是飞书 `message_id`，天然去重 | P0-5 |
| 6 | Session 目录命名 | `{folder}_{botId}` | **嵌套路径 `{folder}/bots/{botId}`**，避免 `_` 冲突 | P1-6 |
| 7 | `botOpenId` 空值 | 空时默认放行 | **多 Bot 下空值视为配置错误，丢弃消息并告警**（单 Bot 兼容路径保留） | P1-7 |
| 8 | CLAUDE.md 加载 | 写入 `~/.claude/CLAUDE.md`（SDK 会覆盖） | **独立挂载点 `/workspace/bot-profile/CLAUDE.md`** + 通过 SDK `customSystemPrompt` 注入 | P1-8 |
| 9 | 上下文注入 | 固定 N=20 条 | **Token 预算制（默认 8K）**，按时间倒序填充，过滤 base64 附件 | P1-9 |
| 10 | IPC 目录隔离 | `data/ipc/{folder}/` | **`data/ipc/{folder}/bots/{botId}/`** 多 Bot 隔离 | P1-10 |
| 11 | 容器日志目录 | `data/groups/{folder}/logs/` | **`data/groups/{folder}/logs/bots/{botId}/`** | P1-11 |
| 12 | 用量统计归属 | 无 bot 维度 | **`usage_records` 新增 `bot_id` 列**（nullable，向后兼容） | P1-12 |
| 13 | 并发模式 | 同 folder 完全串行 | **本期沿用串行执行**（所有 Bot 都走 folder 级串行队列）；保留 `concurrency_mode=writer/advisor` 字段与语义，advisor 的"只写 scratch/tmp、不改项目目录"**统一通过 SDK PreToolUse Hook 强制**（容器/宿主机模式一致）；分级**并发**能力留给下一期 | 用户反馈 + v2 review |

---

## 1. 背景与目标

### 1.1 现状

HappyClaw 当前（v34）每个用户只能配置一组 IM 凭证（per-user `data/config/user-im/{userId}/feishu.json`）。虽然 `registered_groups` 支持多个群组映射到同一 folder，但同一 folder 在同一时刻只有一个 Claude session 在串行执行，且只有一个"Bot 身份"对外说话。

### 1.2 目标

允许单个用户创建并运行**多个飞书 Bot 实例**（独立 App ID/Secret、独立显示名、独立角色提示），同时加入同一个飞书群聊，共享同一个项目 folder 的文件系统和群聊记录，以"多 Agent 协作"的方式完成任务。

### 1.3 核心需求

1. 一个用户可同时运行 N 个飞书 Bot（N ≥ 1）
2. 每个 Bot 有独立的角色 prompt（通过独立 CLAUDE.md 管理）
3. 多个 Bot 可绑定到同一 folder，在同一群内协作
4. 群聊中被 @的 Bot 才响应（复用 `activation_mode='when_mentioned'`）
5. 所有 Bot 共享 folder 的文件系统 + 群聊消息记录
6. **writer/advisor 角色分级（本期串行执行）**：writer 类 Bot 可读写项目目录；advisor 类 Bot 禁止修改项目目录（但可写 scratch / `/tmp`），通过 PreToolUse Hook 统一强制。**本期两类均走 folder 级串行队列**，advisor 并发留给下一期
7. **向后兼容**：现有单 Bot 用户（`bot_id IS NULL` 路径）行为完全不变

### 1.4 非目标（§10 详述）

- Telegram / QQ / 钉钉 多 Bot（架构兼容，本期仅飞书落地）
- **任何 Bot 之间的并发**（本期全串行；advisor 并发、writer worktree 等分级方案留给后续迭代）
- Bot 主动对话 / Bot 之间私聊
- 跨 Bot 的知识共享（每个 Bot session 仍独立）

---

## 2. 核心概念

### 2.1 Bot

一个 **Bot** 是绑定到具体 IM 渠道的一组凭证 + 身份：

| 字段 | 说明 |
|------|------|
| `id` | 内部 UUID（`bot_xxx`） |
| `user_id` | 所属用户 |
| `channel` | `'feishu'` / `'telegram'` / `'qq'` / `'dingtalk'` |
| `name` | 显示名（用于 UI，不一定等于飞书 App 侧设置的名字） |
| `default_folder` | 被拉入新群时自动绑定的 folder（可空） |
| `activation_mode` | **Bot 级默认激活模式**，可被 `bot_group_bindings.activation_mode` 覆盖 |
| 凭证 | 不入库，AES-256-GCM 加密到 `data/config/bots/{botId}/feishu.json` |

**Bot = 一个长期持续运行的 IM 连接 + 一份角色 Profile。**

### 2.2 Agent 实例（运行时概念，不是表）

一个 **Agent 实例** 是 `(folder, botId)` 在运行时的组合：

- 同一 folder 下的多个 Bot → 多个 Agent 实例（多个独立 Claude session）
- 同一 Bot 可在多个 folder 上拥有各自的 Agent 实例
- 本期所有 Agent 实例（无论 writer / advisor）均走 folder 级串行队列；advisor 的角色差异仅体现在 PreToolUse Hook 禁写项目目录（详见 §5.6）

### 2.3 SubAgent（已有概念，不修改）

`agents` 表中已有的 SubAgent（`kind='subagent'|'conversation'`）是 **项目内** 的长期 conversation，**隶属于某个 folder 下的主 session**。它代表"工作区内的独立对话线程"（如一个 code-reviewer 会话），与 IM 渠道 Bot 身份无关。

### 2.4 Bot 与 `agents` 表的关系决策：**不复用**

| 维度 | Bot（新增） | SubAgent（`agents` 表） |
|------|------------|----------------------|
| 物理载体 | IM 连接 + 凭证 | DB 行 + session_id |
| 生命周期 | 长期常驻（进程级） | 按需创建，可归档 |
| 身份来源 | 飞书 App | 工作区内自定义 prompt |
| 跨 folder | 是（一个 Bot 可加入多个 folder） | 否（SubAgent 绑定 folder） |
| 外部可见 | 是（飞书群成员） | 否（仅工作区内） |
| 是否持有凭证 | 是 | 否 |

**决策理由**：

1. **职责不同**：Bot 管理 IM 连接（长连接、心跳、Bot open_id），SubAgent 管理工作区内的对话上下文。强行合并会让 `agents` 表混入 IM 凭证和连接状态，违反单一职责。
2. **基数不同**：Bot 是 per-user 配置（通常 ≤ 10），SubAgent 是 per-folder 运行时对象（可能 100+）。合表后 `agents` 查询的索引策略将变复杂。
3. **删除语义不同**：删除 Bot 要断开连接、清理凭证文件；删除 SubAgent 只是软删除 DB 行。
4. **迁移成本低**：保持两张独立表，现有 SubAgent 代码完全不受影响。

**但是**：Bot 在 Claude session 层面 **复用 `sessions` 表**（见 §3.3），通过新增 `bot_id` 列实现 per-bot session 隔离。这是"身份与会话"的合理复用，不是"身份与 SubAgent"的复用。

---

## 3. 数据模型

### 3.1 SCHEMA_VERSION

```typescript
// src/db.ts
const SCHEMA_VERSION = 35; // 从 v34 升级
```

### 3.2 新增 `bots` 表

```sql
CREATE TABLE IF NOT EXISTS bots (
  id              TEXT PRIMARY KEY,             -- 'bot_' + nanoid
  user_id         TEXT NOT NULL,                -- 所属用户
  channel         TEXT NOT NULL DEFAULT 'feishu',
  name            TEXT NOT NULL,                -- 显示名（UI 用，不影响 IM 侧）
  default_folder  TEXT,                         -- 被拉入新群时自动绑定的 folder
  activation_mode  TEXT NOT NULL DEFAULT 'when_mentioned',  -- Bot 级默认
  concurrency_mode TEXT NOT NULL DEFAULT 'writer',  -- 'writer' | 'advisor'
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'disabled'
  open_id         TEXT,                         -- 该 Bot 在飞书侧的 open_id（连接后自动回填）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id);
CREATE INDEX IF NOT EXISTS idx_bots_channel_status ON bots(channel, status);
```

**设计理由**：
- `open_id` 由连接建立成功后回填，作为"我是谁"的权威来源（解决 P1-7 `botOpenId` 空值问题）
- `activation_mode` 默认 `when_mentioned`（符合多 Bot 语义：群里只响应被 @的 Bot）
- `concurrency_mode` 决定该 Bot 的**写权限语义**（详见 §5.6）：
  - `writer`（默认）：可读写项目目录
  - `advisor`：**不可修改项目目录**（但仍可写 scratch、`/tmp` 等目录），通过 PreToolUse Hook 强制
  - 本期 `writer` / `advisor` 均走 folder 级串行队列；字段保留是为下一期的分级并发能力预留扩展点
- 凭证**不入库**，继续沿用文件 + AES-256-GCM 的模式（与现有 `user-im` 保持一致）

### 3.3 新增 `bot_group_bindings` 表（核心 — 替代修改 `registered_groups.jid`）

```sql
CREATE TABLE IF NOT EXISTS bot_group_bindings (
  bot_id           TEXT NOT NULL,
  group_jid        TEXT NOT NULL,              -- 对应 registered_groups.jid
  folder           TEXT NOT NULL,              -- 冗余缓存，便于路由时避免 JOIN
  activation_mode  TEXT,                       -- 可覆盖 bots.activation_mode；NULL = 继承
  concurrency_mode TEXT,                       -- 可覆盖 bots.concurrency_mode；NULL = 继承
  require_mention  INTEGER,                    -- 兼容字段，NULL = 继承 registered_groups.require_mention
  enabled          INTEGER NOT NULL DEFAULT 1, -- 临时停用某个 Bot 在某群的响应
  bound_at         TEXT NOT NULL,
  PRIMARY KEY (bot_id, group_jid),
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  FOREIGN KEY (group_jid) REFERENCES registered_groups(jid) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bgb_group ON bot_group_bindings(group_jid);
CREATE INDEX IF NOT EXISTS idx_bgb_folder ON bot_group_bindings(folder);
```

**设计理由（对应 P0-2）**：

1. **不改 `registered_groups.jid` PK**：
   - 代码分析文档 §5 已详细列出改 PK 的级联成本（几十个查询函数 + 缓存重构）
   - `jid` 作为 IM 群组的全局唯一标识符，已深入 `getJidsByFolder`、`buildResolveEffectiveChatJid`、`shouldProcessGroupMessage` 等核心路径
   - 保持 `registered_groups` = "群组 → folder/workspace 的单一来源"
2. **独立 M:N 绑定表**：
   - `bot_group_bindings` 是"哪些 Bot 进了哪些群"的事实表
   - Bot 可加入多群，群可有多 Bot，语义天然 M:N
3. **`folder` 冗余缓存**：
   - 消息路由热路径（`shouldProcessGroupMessage` + Bot 选路）每条消息都要查一次
   - 冗余避免 `bot_group_bindings JOIN registered_groups` 的双表查询
   - 一致性靠应用层：`registered_groups.folder` 改动时级联更新所有 `bot_group_bindings.folder`
4. **`activation_mode` 可覆盖**：
   - 大部分场景 Bot 在所有群使用同一激活策略（继承 `bots.activation_mode`）
   - 少数场景需要 per-group 覆盖（如某群希望该 Bot `always` 响应），用 `bot_group_bindings.activation_mode` 覆盖
   - 读取时：`COALESCE(bgb.activation_mode, b.activation_mode)`
5. **`concurrency_mode` 可覆盖**：同一 Bot 在不同 folder 可以有不同的读写定位（比如在 A 项目是 writer，在 B 项目只做 review），读取时同样用 `COALESCE(bgb.concurrency_mode, b.concurrency_mode)`

### 3.4 `sessions` 表新增 `bot_id` 列（P0-3 附属决策）

```sql
-- sessions 现有 PK: (group_folder, agent_id)
-- 通过表重建升级为 (group_folder, bot_id, agent_id)
```

**Migration（参考 `src/db.ts:734` 已有的表重建模式）**：

```sql
CREATE TABLE sessions_new (
  group_folder TEXT NOT NULL,
  bot_id       TEXT NOT NULL DEFAULT '',   -- '' = 兼容旧单 Bot 路径
  agent_id     TEXT NOT NULL DEFAULT '',
  session_id   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (group_folder, bot_id, agent_id)
);
INSERT INTO sessions_new(group_folder, bot_id, agent_id, session_id, updated_at)
  SELECT group_folder, '', agent_id, session_id, updated_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_bot ON sessions(bot_id) WHERE bot_id != '';
```

**理由**：
- `bot_id=''`（空串，非 NULL）作为"无 Bot 归属"的哨兵值，符合 SQLite 对复合主键的 NULL 处理（NULL ≠ NULL 会导致主键冲突检测失效）
- 现有单 Bot 路径（per-user 连接）继续用 `bot_id=''`，不破坏行为
- 新多 Bot 路径写入真实 `bot_id`，session 天然隔离

### 3.5 `usage_records` 表新增 `bot_id` 列（P1-12）

```sql
ALTER TABLE usage_records ADD COLUMN bot_id TEXT;  -- NULL = 单 Bot 或无 Bot 归属
CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage_records(bot_id) WHERE bot_id IS NOT NULL;
```

**理由**：
- `usage_daily_summary` 暂不改动（避免主键重建），等到真正需要 per-bot 日维度聚合时再迭代
- `user_quotas` 不改动（预留表，未使用）

### 3.6 `messages` 表 **不加** `source_message_id` 唯一索引（P0-5）

**理由**：
- `messages` 现有 PK `(id, chat_jid)` 中 `id` 就是飞书 `message_id`（见 `feishu.ts` 消息入库逻辑）
- 多 Bot 收到同一条群消息时，无论哪个 Bot 的连接先触发入库，`INSERT OR IGNORE` 配合现有 PK 就能去重
- v1 方案的 `source_message_id` 列在当前 schema 是冗余的
- **应用层改动**：所有从 IM 渠道进来的消息 INSERT 必须用 `INSERT OR IGNORE INTO messages ...`（若现状是 `INSERT`，需改）

### 3.7 数据模型关系全图

```
users
  ├── bots (1:N)
  │     ├── bot_group_bindings (1:N) ──── registered_groups (N:1 via group_jid)
  │     └── data/config/bots/{botId}/feishu.json (加密凭证)
  └── registered_groups (1:N, user_id 通过 created_by)
        ├── sessions ((folder, bot_id, agent_id) 复合 PK)
        ├── agents (SubAgent，与 Bot 正交)
        ├── messages (chat_jid = group_jid，(id, chat_jid) PK 天然去重)
        ├── usage_records (新增 bot_id 可空列)
        └── im_context_bindings (不改动，线程级 conversation agent)
```

---

## 4. 连接管理

### 4.1 IMConnectionManager 双轨结构

```typescript
// src/im-manager.ts
class IMConnectionManager {
  // 轨道 A：现有 per-user 连接（向后兼容，单 Bot 场景）
  private userConnections: Map<string /* userId */, UserIMConnection>;

  // 轨道 B：新增 per-bot 连接
  private botConnections: Map<string /* botId */, BotConnection>;
}

interface BotConnection {
  botId: string;
  userId: string;
  channel: 'feishu' | 'telegram' | 'qq' | 'dingtalk';
  instance: IMChannel;        // 复用现有 IMChannel 接口
  botOpenId: string;           // 连接建立后回填到 bots.open_id
  connectedAt: number;
}
```

### 4.2 启动流程（`loadState()`）

```
1. 遍历 users → 加载 user-im 配置 → 建立 userConnections（现有逻辑不变）
2. 遍历 bots WHERE status='active' → 加载 config/bots/{botId}/feishu.json → 建立 botConnections
3. 每个 BotConnection 握手成功后：
   a. 调 feishu Bot Info API 获取 open_id
   b. UPDATE bots SET open_id = ? WHERE id = ?
   c. 订阅消息，消息处理流绑定 bot_id 上下文
```

### 4.3 生命周期

| 事件 | 行为 |
|------|------|
| 创建 Bot（`POST /api/bots`） | 写 `bots` 表 + 写凭证文件，不自动连接 |
| 启用 Bot（`PUT /api/bots/:id` → `status='active'`） | 建立新连接 + 回填 `open_id` |
| 更新凭证（`PUT /api/bots/:id/credentials`） | 原子替换凭证文件 → 断开旧连接 → 建立新连接 → `ignoreMessagesBefore = now` |
| 停用 Bot（`status='disabled'`） | 断开连接；`bot_group_bindings` 保留 |
| 删除 Bot（`DELETE /api/bots/:id`） | 断开连接 + 删凭证文件 + 级联删除 `bot_group_bindings` |
| 优雅关闭 | `disconnectAll()` 先断 userConnections 再断 botConnections |

### 4.4 `ignoreMessagesBefore` 过滤

与现有 per-user 热重连完全一致：每次建立新连接时，`ignoreMessagesBefore = Date.now()`，过滤掉连接关闭期间平台堆积的消息。

---

## 5. 消息路由

### 5.1 活性门控：复用 `activation_mode`（P0-4）

**关键原则**：`activation_mode` 的五种取值 `auto|always|when_mentioned|owner_mentioned|disabled` 语义已完备，本期 **不新增** 任何活性判断机制。多 Bot 场景下，`when_mentioned` 就是天然的"群里只响应被 @的 Bot"。

### 5.2 完整路由流程

```
Bot X 的连接收到群消息 m
  ↓
[阶段 1 — 消息入库]
  parseMessage(m) → 规范化
  INSERT OR IGNORE INTO messages (id=m.message_id, chat_jid=groupJid, ...)
  ↓ (同一条消息被多个 Bot 收到时，只有第一次真正写入)
  ↓
[阶段 2 — Bot 身份门控 — P1-7 修复]
  X.botOpenId === undefined/null?
    → 单 Bot 模式（老 per-user 连接）：降级为"默认放行"，继续（老行为）
    → 多 Bot 模式（BotConnection）：记录 error 日志 + 丢弃消息（禁止默认放行）
  mentions[] 中是否包含 X.botOpenId?
    → 否 且 activationMode 需要 mention：丢弃（旁观者静默入库已完成）
    → 是 或 activationMode='always'：进入阶段 3
  ↓
[阶段 3 — 激活模式检查 — 复用 shouldProcessGroupMessage]
  effectiveMode = COALESCE(bot_group_bindings.activation_mode,
                           bots.activation_mode,
                           registered_groups.activation_mode,
                           'when_mentioned')
  switch (effectiveMode):
    case 'disabled':    丢弃
    case 'always':      通过
    case 'when_mentioned':  阶段 2 已检查，通过
    case 'owner_mentioned': 通过 + 检查 sender == group.owner
    case 'auto':        回落 require_mention 旧逻辑
  ↓
[阶段 4 — 查绑定解析 folder]
  row = SELECT folder FROM bot_group_bindings
        WHERE bot_id = X.id AND group_jid = chatJid AND enabled = 1
  row IS NULL → 丢弃 + 日志（Bot 被拉入群但未绑定）
  ↓
[阶段 5 — 入队]
  queue.enqueueMessageCheck({ folder: row.folder, botId: X.id, message: m })
  ↓
[阶段 6 — 启动/注入 Agent 实例]
  agent = getOrCreateAgentInstance(folder, botId=X.id)
  → session 取自 sessions(folder, bot_id=X.id, agent_id='')
  → CLAUDE.md 从 data/groups/{folder}/bots/{botId}/CLAUDE.md 注入（§6）
  → 启动 container / host 进程
  ↓
addReaction('OnIt') (per-connection，X 单独触发)
```

### 5.3 多 @mention 处理

一条消息 `@Bot A @Bot B`：

- Bot A 连接：阶段 1 入库（假设先到），阶段 2-6 通过
- Bot B 连接：阶段 1 `INSERT OR IGNORE` 命中冲突 → 跳过 INSERT，但继续阶段 2-6
- A / B 各自独立入队
- 执行顺序与并发性由 §5.6 决定

### 5.6 并发控制与写权限（本期串行）

#### 5.6.1 队列策略：全串行

`group-queue.ts` 的 `serializationKeyResolver` **本期对所有 Bot 返回相同的串行化 key**：

| concurrency_mode | serializationKey | 队列语义 |
|------------------|------------------|---------|
| `writer`（默认） | `folder:{folder}` | 同 folder 严格串行（与旧行为一致） |
| `advisor` | `folder:{folder}` | **同 folder 严格串行**（本期不放开并发，见 §10） |

单 Bot 老路径（`bot_id IS NULL`）按 writer 语义处理，serialization key 仍为 `folder:{folder}`，行为完全不变。

**为什么先全串行**：v2 review 指出 advisor 并发存在"读到过时文件"的语义缺陷——writer 正在改 `src/login.tsx`，此时 advisor 并发 review 读到的是旧版本，结论可能错位。这是**并发语义问题**，不是代码 bug。降级串行消除该风险，把并发留给文档化"advisor snapshot/worktree 机制"成熟后再引入。

#### 5.6.2 写权限边界：通过 PreToolUse Hook 强制

advisor **不是完全只读**，只是禁止修改项目目录。容器内的读写矩阵：

| 路径 | 容器内映射 | writer | advisor |
|------|-----------|--------|---------|
| 项目目录 | `/workspace/group` ← `data/groups/{folder}/` | rw | **禁写（Hook 拦截）** |
| Scratch 目录 | `/workspace/scratch` ← `data/scratch/{folder}/bots/{botId}/` | rw | **rw** |
| Bot 角色 | `/workspace/bot-profile` ← `data/bot-profiles/{botId}/` | **ro** | **ro** |
| 临时目录 | `/tmp` | rw | rw |
| SDK session | `/home/node/.claude/` ← `data/sessions/{folder}/bots/{botId}/.claude/` | rw | rw |

**关键点**：
- 项目目录仍以 `rw` 挂载（不再用 `:ro`），避免与 PreCompact Hook 写入 `conversations/` 归档、SDK 内部缓存等既有写入路径产生 EROFS 冲突
- advisor 有 `/workspace/scratch`（per-bot 持久 scratch，跨会话保留）
- session 目录必须可写（SDK 维护状态），advisor 也不例外

#### 5.6.3 统一的 Hook 强制策略（容器 + 宿主机一致）

不再区分容器模式（`:ro` OS 级）和宿主机模式（Hook）两套强制方式。**两种模式统一使用 Claude Agent SDK 的 PreToolUse Hook**：

- agent-runner 启动时根据 `HAPPYCLAW_BOT_MODE=advisor` 注册路径守卫 hook，拦截三类调用：
  1. **`Write` / `Edit` / `NotebookEdit`**：解析目标路径，若位于 `/workspace/group`（容器）或 `data/groups/{folder}/` 下（宿主机）则拒绝；放行 `/workspace/scratch`、`/tmp`、session 目录、bot-profile
  2. **`Bash`**：正则匹配写类命令（`>`、`>>`、`tee`、`mv`、`rm`、`cp`、`sed -i`、`git commit/push/checkout/reset` 等），若目标路径在项目目录内则拒绝
  3. **其他潜在写工具**（如 `str_replace_editor` 的变种）同规则校验
- 被拒绝时返回明确错误信息引导 agent 改写 scratch
- Prompt 兜底：advisor 的 system prompt 明确说明："你以只读方式访问项目目录，可以写 `/tmp` 和 `/workspace/scratch`，不要尝试修改项目文件"

**权衡的诚实声明**：

- PreToolUse Hook + Prompt 是"best-effort"，不是 OS 级隔离
- Agent 通过 subprocess 调用、未被 hook 覆盖的非标准工具路径，理论上仍可能修改项目目录
- 相比 v2 前版（容器 `:ro` 硬保护），本方案放弃了容器模式下的 OS 级强制，换来的是：
  - 避免 `:ro` 与 PreCompact Hook 归档写入的冲突
  - 容器模式 / 宿主机模式行为一致，减少分叉测试成本
  - 实现路径统一，改动点收敛
- 对 admin 主容器（host mode）而言，信任边界本来就是用户自己
- member 主容器（container mode）的风险提升有限——PreToolUse Hook 在绝大多数 agent 行为下有效

#### 5.6.4 落地约束

1. **容器环境变量** `HAPPYCLAW_BOT_MODE=writer|advisor` 传给 agent-runner，用于：Hook 初始化、Prompt 注入、bot-profile CLAUDE.md 模板选择
2. **scratch 目录自动创建**：`container-runner.ts` 启动前 `mkdirSync({ recursive: true })` 确保 `data/scratch/{folder}/bots/{botId}/` 存在
3. **配额**：writer 和 advisor 共享 `MAX_CONCURRENT_CONTAINERS / MAX_CONCURRENT_HOST_PROCESSES` 全局池，per-user 配额也统一计算
4. **Hook 注册位置**：`container/agent-runner/src/index.ts` 在 SDK `query()` 调用前根据 `HAPPYCLAW_BOT_MODE` 按需注入 hook 配置

### 5.4 `botOpenId` 空值安全（P1-7 详细说明）

```typescript
// src/feishu.ts handleIncomingMessage 改造
// 现状：botOpenId 空时默认放行（单 Bot 下不会错，多 Bot 下是灾难）
// 改造后：按连接类型决定
if (chatType === 'group') {
  if (!botOpenId) {
    if (connectionKind === 'bot') {
      // 多 Bot 连接必须有 open_id（启动时 Bot Info API 获取失败才会空）
      logger.error({ botId, chatJid }, 'BotConnection missing open_id — dropping message');
      return;
    }
    // 单 Bot per-user 连接：保留旧默认放行行为（向后兼容）
  } else {
    const isBotMentioned = mentions?.some((m) => m.id?.open_id === botOpenId) ?? false;
    if (!isBotMentioned && shouldProcessGroupMessage(chatJid, senderOpenId) === false) {
      return;  // 激活模式要求 mention 但未被 @
    }
  }
}
```

**理由**：单 Bot 场景下，如果飞书 Bot Info API 临时抽风导致 `botOpenId` 空，保留"默认放行"是合理降级（用户体验 > 严格性）；但多 Bot 场景下默认放行会让所有 Bot 都响应同一条消息，属于严重错误路径，必须硬性拒绝。

### 5.5 自动注册新群组（Bot 被拉入群）

```
onBotAddedToGroup(botId, groupJid, groupName)
  ↓
默认 folder = bots.default_folder
folder IS NULL? → 标记为 pending，等 UI 手动绑定
  ↓
确保 registered_groups(group_jid) 存在（若不存在，用默认模板创建）
INSERT OR IGNORE INTO bot_group_bindings (bot_id, group_jid, folder, bound_at)
  VALUES (botId, groupJid, folder, now)
```

---

## 6. Agent 上下文

### 6.1 CLAUDE.md 双层加载（P1-8 修复）

**问题**：v1 方案把 Bot 角色 CLAUDE.md 放在 `~/.claude/CLAUDE.md`（容器内）。但 Claude Agent SDK 在运行时会写入 `~/.claude/` 目录（session 状态、todo、缓存等），这个路径 **不适合** 放用户维护的配置文件。

**v2 方案**：

```
Host 文件布局
  data/groups/{folder}/
    CLAUDE.md                           # 项目上下文（所有 Bot 共享，现有行为不变）
  data/bot-profiles/{botId}/            # ← Bot 角色（与项目目录分离）
    CLAUDE.md                           # Bot 角色 profile（用户维护）

容器内挂载
  /workspace/group/CLAUDE.md            # 项目上下文（沿用，项目根）
  /workspace/bot-profile/CLAUDE.md      # 只读挂载 data/bot-profiles/{botId}/CLAUDE.md

SDK 配置（agent-runner 启动时）
  query({
    customSystemPrompt: readFileSync('/workspace/bot-profile/CLAUDE.md'),
    // 或者：cwd='/workspace/group'，让 SDK 自动加载项目根 CLAUDE.md
    //      然后把 bot-profile/CLAUDE.md 内容作为 systemPrompt 前缀
    ...
  })
```

**加载顺序**：
1. `customSystemPrompt` — Bot 的角色定义（"你是 Frontend Engineer"）
2. SDK 从 `cwd=/workspace/group` 自动发现的 `CLAUDE.md` — 项目规范
3. 用户级 / 项目级 Skills

**理由**：
- 完全不动 `~/.claude/`，避免与 SDK 写入冲突
- Bot Profile 通过独立挂载点读入，所有权归用户
- `customSystemPrompt` 是 SDK 稳定 API，不依赖文件系统约定

**默认模板**（创建 Bot 时自动写 `data/groups/{folder}/bots/{botId}/CLAUDE.md`）：

```markdown
# {BotName} 角色定义

你是 "{BotName}"，负责在本项目中……

## 职责范围
- (请补充)

## 协作准则
- 回复前先查看群聊近期记录，了解其他 Bot 和用户的讨论
- 明确自己的工作边界，不越权执行其他角色的任务
- 完成后用简洁的总结告知群内其他成员
```

### 6.2 Session 目录命名（P1-6 修复）

**问题**：v1 用 `{folder}_{botId}` 分隔。如果 folder 或 botId 本身含 `_`（例如 `home-user_123` / `bot_abc`），拼接后 `home-user_123_bot_abc` 无法唯一反解，存在冲突风险。

**v2 方案**：嵌套路径

```
data/sessions/{folder}/.claude/                        # 无 Bot（单 Bot 老路径）
data/sessions/{folder}/bots/{botId}/.claude/           # 多 Bot 场景
```

**容器内挂载**：

```
-v data/sessions/{folder}/bots/{botId}/.claude:/home/node/.claude:rw
```

**理由**：
- 路径嵌套天然无歧义，文件系统层面就隔离
- 旧单 Bot 路径 `data/sessions/{folder}/.claude/` 继续可用（bot_id='' 时走老路径）
- 未来若要清理某个 Bot 的所有 session，`rm -rf data/sessions/*/bots/{botId}/` 即可

### 6.3 群聊记录上下文注入（P1-9 修复 — Token 预算制）

**问题**：v1 固定 N=20 条。当消息含长代码、base64 图片附件时容易爆 token；消息都很短时又浪费上下文。

**v2 方案**：Token 预算制

```typescript
interface ContextInjectOptions {
  groupJid: string;
  botId: string;
  tokenBudget: number;       // 默认 8000（可通过系统设置覆盖）
  excludeSelf?: boolean;     // 是否排除当前 Bot 自己的发言，默认 false
}

async function buildGroupChatContext(opts: ContextInjectOptions): Promise<string> {
  const messages = await getRecentMessages(opts.groupJid, { limit: 200 });
  // limit=200 是硬上限，防止超长群聊 OOM；实际按 token 预算截断
  const chunks: string[] = [];
  let used = 0;
  for (const m of messages.reverse()) {      // 从最旧往最新
    const sanitized = stripBase64Attachments(m);
    const rendered = formatMessage(sanitized);  // "用户 (10:01): ..."
    const tokens = estimateTokens(rendered);    // 简单 4 字符=1 token 近似
    if (used + tokens > opts.tokenBudget) break;
    chunks.push(rendered);
    used += tokens;
  }
  return chunks.join('\n');
}

function stripBase64Attachments(m: Message): Message {
  if (!m.attachments) return m;
  const filtered = m.attachments.map((a) => {
    if (a.type === 'image' && a.data?.startsWith('data:')) {
      return { ...a, data: undefined, placeholder: `[图片: ${a.filename ?? 'unknown'}]` };
    }
    return a;
  });
  return { ...m, attachments: filtered };
}
```

**注入时机**：Agent 实例启动时（`container-runner.ts`），作为 `ContainerInput.initialContext` 的一部分，拼接在本次用户消息之前。

**默认预算**：8K tokens（可通过系统设置 `groupContextTokenBudget` 调整）。

**理由**：
- Token 预算比消息条数更能反映真实上下文占用
- 过滤 base64 避免把几百 KB 图片数据塞进 prompt（Vision 场景应通过显式 attachments 机制，而不是历史记录）
- 硬上限 200 条防止极端情况下数据库扫描过多

### 6.4 共享文件系统

同一 folder 下所有 Bot 的 Agent 实例挂载相同的项目目录（`data/groups/{folder}/` → `/workspace/group`，**统一 `rw` 挂载**）：

- **writer 模式**：项目目录可读写，folder 级串行队列保证同一时刻只有一个 Bot 在写
- **advisor 模式**：项目目录物理上仍是 `rw` 挂载（避免与现有 Hook 归档写入冲突），但通过 **SDK PreToolUse Hook** 拦截所有项目目录的写操作；advisor 可以自由写入 `/workspace/scratch`、`/tmp` 和 session 目录

详见 §5.6 并发控制与写权限（含完整读写矩阵和统一 Hook 策略）。

### 6.5 Session 隔离

`sessions (folder, bot_id, agent_id)` 三元组主键保证每个 Bot 有独立的 Claude session。其他 Bot 的对话通过 §6.3 的群聊记录注入，不污染本 Bot 的 session history，避免无限膨胀。

---

## 7. 目录隔离

### 7.1 IPC 目录 per-bot 切分（P1-10）

```
data/ipc/{folder}/                        # 现状（单 Bot 沿用）
  input/                                   # _close sentinel / 消息注入
  messages/
  tasks/

data/ipc/{folder}/bots/{botId}/          # 多 Bot 新增
  input/
  messages/
  tasks/
```

**容器挂载**：

```
# 无 bot_id（老路径）
-v data/ipc/{folder}:/workspace/ipc

# 有 bot_id
-v data/ipc/{folder}/bots/{botId}:/workspace/ipc
```

**理由**：
- `_close` sentinel 是全局信号，多 Bot 下如果共用 IPC 目录，一个 Bot 的关闭会波及所有 Bot
- `messages/*.json`（Agent 主动发送）、`tasks/*.json`（任务管理）需要明确归属
- 嵌套路径让"按 Bot 清理"变得简单

### 7.2 日志目录 per-bot 切分（P1-11）

```
data/groups/{folder}/logs/                      # 单 Bot 沿用
data/groups/{folder}/logs/bots/{botId}/        # 多 Bot 新增
```

**理由**：
- 多 Bot 同一 folder 如果共用 `logs/`，stdout/stderr 会互相覆盖，排查困难
- per-bot 日志也是计费 / 用量核算的重要信号

### 7.3 Downloads 目录（保持不变）

`data/groups/{folder}/downloads/{channel}/` 按日期 + channel 分层已足够隔离，不按 Bot 再切。文件下载由 writer agent 主动操作（advisor 禁写项目目录，但仍可把下载结果存到 scratch）；folder 级串行队列保证无并发冲突。

### 7.4 Scratch 目录（advisor 的可写空间，存储在项目目录外）

```
data/scratch/{folder}/bots/{botId}/    # 与 data/groups/ 平级，物理隔离项目目录
```

**容器挂载**：

```
-v data/scratch/{folder}/bots/{botId}:/workspace/scratch:rw
```

**设计理由 — 为什么放在项目目录外**：
- 避免 scratch 物理落在项目工作区内污染 git 树（与 `logs/`、`conversations/` 同理，但 scratch 内容往往更零散，不适合放在项目目录下）
- 独立的 `data/scratch/` 路径和 `data/sessions/`、`data/ipc/`、`data/bot-profiles/` 的分离约定一致
- 未来如果重新引入项目目录 `:ro` 硬保护，scratch 在外部挂载不受影响

**用途**：
- advisor 的 review 笔记、分析报告、中间产物（跨会话持久保留）
- writer 也可以用作临时工作区（避免脏文件污染 git）
- 不像 `/tmp` 进程退出就丢

**创建时机**：`container-runner.ts` 启动前 `mkdirSync({ recursive: true })`。

**清理策略**：不自动清理，通过 UI 手动清；监控 scratch 总体积避免失控。

**目录全景**：

```
data/
├── groups/{folder}/         ← 项目工作区（rw 挂载到 /workspace/group）
│   ├── CLAUDE.md
│   ├── src/
│   ├── logs/bots/{botId}/   ← 容器日志（系统路径，file-manager 保护）
│   └── downloads/...
├── bot-profiles/{botId}/            ← Bot 角色定义（ro 挂载到 /workspace/bot-profile）
│   └── CLAUDE.md
├── scratch/{folder}/bots/{botId}/   ← scratch 目录（rw 挂载到 /workspace/scratch）
├── ipc/{folder}/bots/{botId}/       ← IPC 通道
└── sessions/{folder}/bots/{botId}/  ← Claude session
```

---

## 8. UI 变化

### 8.1 新增 `/bots` 管理页

侧边栏新增 **Bots** 入口（位置在 "Skills" 和 "MCP Servers" 之间）。

**列表视图**：

| 列 | 说明 |
|----|------|
| 名称 | `bots.name` |
| 渠道 | `bots.channel` + icon |
| 连接状态 | 实时 WS 推送（connected / disconnected / error） |
| 默认 folder | `bots.default_folder` |
| 激活模式 | `bots.activation_mode` |
| 绑定群组数 | `SELECT COUNT(*) FROM bot_group_bindings WHERE bot_id=?` |
| 操作 | 编辑 / 停用 / 删除 / 测试连接 / 编辑角色 |

**创建/编辑 Bot 表单**：
- 名称、渠道、App ID、App Secret（仅创建时；更新走独立"更新凭证"入口）
- 默认 folder（下拉 `registered_groups` 的 folder）
- 默认激活模式（下拉 5 个选项）
- 「编辑角色 profile」按钮 → 打开 markdown 编辑器（对应 `data/groups/{folder}/bots/{botId}/CLAUDE.md`，需选中一个 folder 作为 Profile 归属）

### 8.2 WorkspaceBotsPanel（ChatView 右侧）

```
群内 Bots
┌─────────────────────────────────────────────────┐
│ Frontend   飞书  [已连接] [when_mentioned] …    │
│ Backend    飞书  [已连接] [always]          …    │
│ [+ 添加 Bot 到本群]                              │
└─────────────────────────────────────────────────┘
```

"添加 Bot"→ 弹出 Modal，列出该用户 `bots` 表中**未绑定到当前群**的 Bot，勾选后 INSERT `bot_group_bindings`。

### 8.3 Setup 向导调整

`/setup/channels` 中"配置飞书"标题改为"配置第一个飞书 Bot"，后端逻辑：
- 保存时：若用户无 `bots` 记录，创建一个 `bots` 行（`name='默认助手'`），凭证写到 `data/config/bots/{botId}/feishu.json`
- 若用户已有 `user-im/{userId}/feishu.json`（老数据），UI 展示"你已有一个旧版飞书配置，是否迁移？"（不强制）

### 8.4 表情回复（无修改）

`feishu.ts` 的 `addReaction(messageId, 'OnIt')` 在 per-connection 内执行。多 Bot 场景下每个被 @的 Bot 独立发送 reaction，飞书平台天然支持多个 reaction 聚合展示。

---

## 9. 向后兼容

### 9.1 完全兼容（纯增量）

| 场景 | v2 行为 |
|------|-------|
| 现有单 Bot 用户（user-im 配置） | 完全不受影响：走 `userConnections`，`bot_id=''` session，老 IPC/logs 路径 |
| 现有 `registered_groups` 记录 | 无改动，无需迁移数据 |
| 现有 `sessions` 记录 | 表重建时自动 `bot_id=''` 填充，老 session_id 继续可用 |
| 现有 `messages` | 无列变更，无需迁移 |
| 现有 `usage_records` | 新增列 `bot_id` 默认 NULL，老查询不受影响 |
| 现有 `im_context_bindings` | 完全不改动（线程级持久化独立于 Bot 维度） |

### 9.2 Migration 步骤（按 `src/db.ts` 现有风格）

```typescript
// SCHEMA_VERSION = 35
if (currentVersion < 35) {
  db.transaction(() => {
    // 1. 创建 bots 表
    db.exec(`CREATE TABLE IF NOT EXISTS bots (...)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id)`);

    // 2. 创建 bot_group_bindings 表
    db.exec(`CREATE TABLE IF NOT EXISTS bot_group_bindings (...)`);

    // 3. sessions 表重建（参考 src/db.ts:734 的 registered_groups 重建模式）
    db.exec(`CREATE TABLE sessions_new (...)`);
    db.exec(`INSERT INTO sessions_new(...) SELECT ..., '' AS bot_id, ... FROM sessions`);
    db.exec(`DROP TABLE sessions`);
    db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);

    // 4. usage_records 新增列
    ensureColumn('usage_records', 'bot_id', 'TEXT');

    // 5. 写版本号
    setSchemaVersion(35);
  })();
}
```

全部在单事务内完成，失败整体回滚。

### 9.3 文件系统兼容

启动时 **不做** 大规模文件迁移。只在：
- 创建新 Bot 时 → 创建 `data/config/bots/{botId}/` 和 `data/groups/{folder}/bots/{botId}/`
- 启动 Agent 实例时 → 若 `bot_id != ''` 使用新路径；否则沿用老路径

### 9.4 API 兼容

| 现有 API | v2 行为 |
|---------|--------|
| `PUT /api/config/user-im/feishu` | 保留（deprecated 标签），继续写 `user-im/{userId}/feishu.json` |
| `GET /api/groups` | 返回不变（不暴露 bot 维度） |
| `GET /api/groups/:jid/bots` | **新增**：返回绑定到该群的 Bot 列表 |
| `POST /api/bots` / `GET /api/bots` / `PUT /api/bots/:id` / `DELETE /api/bots/:id` | **新增** |
| `POST /api/bots/:id/bindings` / `DELETE /api/bots/:id/bindings/:jid` | **新增** |

---

## 10. 不在本期范围

- **Telegram / QQ / 钉钉 多 Bot**：架构支持（`bots.channel` 字段已预留），但本期仅实现飞书的完整闭环
- **Bot 之间的直接私聊 / Bot 主动发起对话**：超出多 Bot 协作的基本场景，后续通过 MCP 工具扩展
- **任何 Bot 之间的并发**：本期全串行；advisor 并发（需要文件快照/worktree 机制避免读到过时内容）和 writer 并发（需要更复杂的锁协议或 git worktree 隔离）都留给后续迭代
- **advisor 写保护的绕过防御**：PreToolUse Hook + Prompt 是 best-effort，通过 subprocess、未被 hook 覆盖的工具路径绕过守卫的加固（seccomp profile、subprocess 拦截、chroot 等）不在本期范围
- **OS 级只读挂载**：v2 早期设计的 `/workspace/group:ro` 方案在迭代中被移除——与 PreCompact Hook 的归档写入冲突会导致 advisor 启动失败，改用统一 Hook 方式；后续若需要 OS 级硬保护，需重新设计归档/缓存路径分离
- **`usage_daily_summary` 的 bot 维度聚合**：主键重建成本高，先让 `usage_records.bot_id` 可查即可，聚合后续迭代
- **Bot 共享 session / 跨 Bot 记忆同步**：每个 Bot 仍然独立 session，通过群聊记录注入感知对方；显式的 Bot 间记忆共享（如共用一个知识图谱）不在本期
- **飞书以外渠道的 @mention 识别**：Telegram 的 @username 处理、QQ 的 @ 语义差异等，渠道适配层后续补齐

---

## 附录 A：关键路径修改清单

| 文件 | 改动点 |
|------|-------|
| `src/db.ts` | SCHEMA_VERSION=35；新增 bots/bot_group_bindings 表；sessions 表重建；usage_records 加列；新增 CRUD 函数 |
| `src/types.ts` | 新增 `Bot`、`BotGroupBinding` 接口 |
| `src/im-manager.ts` | 新增 `botConnections` Map 和相关 connect/disconnect 方法 |
| `src/feishu.ts` | `handleIncomingMessage` 增加 `connectionKind: 'user' \| 'bot'` 参数；`botOpenId` 空值处理按 connectionKind 分支 |
| `src/index.ts` | `loadState()` 加载 bots；`shouldProcessGroupMessage` 叠加 `bot_group_bindings.activation_mode` 覆盖 |
| `src/container-runner.ts` | 挂载 `/workspace/bot-profile`；挂载 `/workspace/scratch`；IPC/logs 路径按 bot_id 切分；`customSystemPrompt` 注入；注入 `HAPPYCLAW_BOT_MODE` 环境变量；**项目目录统一 `rw` 挂载**（无 `:ro` 分支） |
| `src/group-queue.ts` | `serializationKeyResolver` 对 writer / advisor 均返回 `folder:{folder}`；旧路径（`bot_id=''`）视为 writer，语义不变 |
| `container/agent-runner/src/index.ts` | 读取 `HAPPYCLAW_BOT_MODE`；advisor 模式注册 PreToolUse Hook 做路径守卫（容器/宿主机模式一致） |
| `container/agent-runner/src/advisor-guard.ts` | **新增**：PreToolUse Hook 实现，拦截 Write/Edit/NotebookEdit/Bash 的项目目录写入，放行 scratch/tmp/session/bot-profile |
| `src/routes/bots.ts` | **新增**：Bot CRUD + 绑定 CRUD + 测试连接 |
| `src/routes/groups.ts` | `GET /api/groups/:jid/bots` 新增 |
| `web/src/pages/BotsPage.tsx` | **新增** |
| `web/src/components/WorkspaceBotsPanel.tsx` | **新增** |
| `web/src/stores/bots.ts` | **新增** Zustand store |
| `tests/units/bot-routing.test.ts` | **新增**：多 @mention、botOpenId 空值、activation_mode 覆盖等路由测试 |

## 附录 B：测试覆盖要求

按 `tests/units/` 约定，至少新增：

- `bots-schema.test.ts` — 建表/迁移/回填 `bot_id=''`
- `bot-routing.test.ts` — 单/多 @mention、disabled/always/when_mentioned 门控
- `bot-openid-safety.test.ts` — user 连接空值放行 vs bot 连接空值丢弃
- `bot-session-isolation.test.ts` — 同 folder 两个 Bot session_id 不同
- `context-token-budget.test.ts` — token 预算截断、base64 过滤
- `bot-ipc-isolation.test.ts` — `_close` sentinel 不互相影响
- `serialization-key.test.ts` — writer / advisor / 空 bot_id 均映射到 `folder:{folder}`，同 folder 串行入队
- `advisor-guard.test.ts` — PreToolUse Hook 拦截 Write/Edit/NotebookEdit 到项目目录、Bash `>`/`mv`/`rm`/`git commit` 到项目目录；放行 `/workspace/scratch`、`/tmp`、session 目录、bot-profile

所有新增测试需在 Phase 2/3 重构前后保持绿。
