# im_context_bindings & activation_mode 代码分析

## 1. im_context_bindings 表结构

### SQL 定义
**位置**: `src/db.ts:309-321`

```sql
CREATE TABLE IF NOT EXISTS im_context_bindings (
  source_jid TEXT NOT NULL,
  context_type TEXT NOT NULL,
  context_id TEXT NOT NULL,
  workspace_jid TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  root_message_id TEXT,
  title TEXT,
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_jid, context_type, context_id)
);
CREATE INDEX IF NOT EXISTS idx_icb_workspace ON im_context_bindings(workspace_jid);
CREATE INDEX IF NOT EXISTS idx_icb_agent ON im_context_bindings(agent_id);
```

### 语义说明

**主键结构**: `(source_jid, context_type, context_id)` - 复合主键

- **source_jid**: 飞书群组 JID（如 `feishu:oc_xxx`），表示消息来源
- **context_type**: 目前仅支持 `'thread'`，表示绑定上下文类型（留给未来扩展）
- **context_id**: 线程 ID（飞书 thread_id），标识具体线程
- **workspace_jid**: 工作区/项目 JID（如 `web:main` 或 `web:uuid`），消息路由目标
- **agent_id**: conversation agent ID（自动创建，用于 thread-level 会话）
- **root_message_id**: 线程根消息 ID（飞书 message_id）
- **title**: 线程自动标题（从飞书消息摘要生成或用户设置）
- **last_active_at**: 最后活跃时间戳（用于排序展示最近的线程）
- **created_at**: 绑定创建时间
- **updated_at**: 绑定更新时间

### 关系语义

该表实现 **线程级别的 IM 到工作区的映射**:

```
飞书群组 (feishu:oc_xxx) 
  → 单个线程 (thread_id=xxx)
    → workspace_jid (web:main)
      → conversation agent (agent_id=yyy)
```

- 一个群组可以有多个线程，每个线程对应一个 agent
- 每个 (群组, 线程) 对应唯一的 agent（不支持多 bot）
- 删除工作区时级联删除所有绑定 (`deleteImContextBindingsByWorkspace`, `src/db.ts:2499`)

---

## 2. activation_mode 取值与路由逻辑

### 取值定义
**位置**: `src/db.ts:2312-2318`、`src/types.ts:64`

```typescript
export const VALID_ACTIVATION_MODES = new Set([
  'auto',           // 默认：兼容旧行为 require_mention
  'always',         // 群聊无需 @bot，所有消息处理
  'when_mentioned', // 群聊必须 @bot，否则丢弃
  'owner_mentioned',// 群聊必须 @bot，且仅 owner 响应
  'disabled',       // 完全禁用，忽略所有消息
]);
```

### 读取位置

1. **初始化解析** (`src/db.ts:2320-2326`)
   ```typescript
   function parseActivationMode(
     raw: string | null,
   ): 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled' {
     if (raw && VALID_ACTIVATION_MODES.has(raw))
       return raw as ...;
     return 'auto'; // 默认值
   }
   ```

2. **注册群组表** (`src/db.ts:2264`)
   - 存储于 `registered_groups.activation_mode` 列
   - 在 `setRegisteredGroup()` 写入，在 `getRegisteredGroup()` 读出
   - **重要**: 该模式绑定到群组本身，不需要追溯 `target_main_jid`

### 路由影响（消息门控）

**位置**: `src/index.ts:6922-6944` - `shouldProcessGroupMessage()`

```typescript
function shouldProcessGroupMessage(chatJid: string, senderImId?: string): boolean {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return false;

  const mode = group.activation_mode ?? 'auto';

  switch (mode) {
    case 'always':
      return true; // 群聊不需要 @bot，直接处理
    case 'when_mentioned':
      return false; // 返回 false → 必须 @bot（在调用方检查 mention）
    case 'owner_mentioned':
      return false; // 返回 false → 必须 @bot，后续还需检查 sender == owner
    case 'disabled':
      return false; // 忽略所有消息
    case 'auto':
    default:
      return group.require_mention !== true; // 兼容旧 require_mention 字段
  }
}
```

**提前判断**: `src/index.ts:2271-2273`
```typescript
// activation_mode === 'disabled' 时忽略所有消息（DM 和群聊）
if (group.activation_mode === 'disabled') {
  logger.debug({ chatJid }, 'Group activation_mode is disabled, skipping');
```

### Mention 检查（Feishu SDK 层）

**位置**: `src/feishu.ts:1128-1148` - `handleIncomingMessage()` 中

```typescript
// 群聊 Mention 过滤：require_mention / owner_mentioned 模式下过滤
if (chatType === 'group' && shouldProcessGroupMessage) {
  const isBotMentioned = botOpenId
    ? (mentions?.some((m) => m.id?.open_id === botOpenId) ?? false)
    : true; // 无 bot open_id 时默认放行（安全降级）
  
  if (!isBotMentioned && !shouldProcessGroupMessage(chatJid, senderOpenId)) {
    logger.debug({ chatJid, messageId },
      'Dropped group message: mention required but bot not mentioned');
    return; // 丢弃消息
  }
  
  // owner_mentioned 模式：bot 被 @mention 但发送者不是 owner 时丢弃
  if (isBotMentioned && isGroupOwnerMessage && 
      !isGroupOwnerMessage(chatJid, senderOpenId)) {
    logger.debug({ chatJid, messageId, senderOpenId },
      'Dropped group message: owner_mentioned mode, sender is not owner');
    return;
  }
}
```

### 实际消息路由流程

```
消息到达
  ↓
activation_mode == 'disabled'? → 丢弃 ✓
  ↓
activation_mode == 'always'? → 放行 ✓
  ↓
activation_mode == 'when_mentioned'? → 检查 @bot
  ↓
activation_mode == 'owner_mentioned'? → 检查 @bot + 检查 owner
  ↓
activation_mode == 'auto'? → 查看 require_mention 字段
```

---

## 3. target_agent_id 语义

### 定义与用途

**位置**: `src/types.ts:60`、`src/db.ts:2260`、`src/db.ts:668`

```typescript
target_agent_id?: string; // IM 消息路由到指定 conversation agent
```

**语义**: IM 群组绑定到工作区内一个特定的 conversation agent（长期对话）

### 与 bot_id 的区别

| 维度 | target_agent_id | 新建 bot_id |
|------|-----------------|------------|
| **作用** | 将 IM 群组消息路由到工作区内的一个会话 agent | （假设）表示一个飞书 Bot 实例（独立 AppID/Secret） |
| **绑定粒度** | **一对一**: 一个群组 → 一个 agent | **一对多**: 一个 Bot → 多个群组 |
| **创建时机** | 用户显式绑定（通过 `/bind_agent` 或 UI） | Bot 初始化时创建 |
| **关系模型** | 单向：群组持有 agent ID | 可双向：Bot 需管理绑定关系表 |
| **范围** | 工作区级别（web:xxx） | 全局级别（飞书 app level） |
| **多 Bot 支持** | **不支持** - 一个群组只能绑定一个 agent | **需要新表** 来支持 |

**当前代码中的 target_agent_id 路由逻辑** (`src/index.ts:6761-6768`):

```typescript
// Agent binding takes priority
if (group.target_agent_id) {
  const agent = getAgent(group.target_agent_id);
  if (!agent) return null;
  const effectiveJid = `${agent.chat_jid}#agent:${group.target_agent_id}`;
  return { effectiveJid, agentId: group.target_agent_id };
}
```

---

## 4. im_context_bindings 可扩展性评估

### 当前设计的局限性

1. **不支持多 Bot 同群**
   - 复合主键 `(source_jid, context_type, context_id)` 中，`source_jid` 固定为一个群组
   - 一个群组只能有一个 workspace_jid + 一个 agent_id
   - 无 bot_id 字段，无法区分多个 Bot 的贡献

2. **线程级绑定，非 Bot 级绑定**
   - 表的设计是"一个飞书线程 → 一个 agent"
   - **不是** "一个 Bot → N 个群组"

3. **agent_id 不可复用**
   - 每个线程创建独立的 agent（`src/index.ts:6663-6686`)
   - 如果多个 Bot 进入同一群组，无法共享 agent 或在 agent 层面区分 Bot

### 能否扩展支持多 Bot

**结论**: **不推荐** 在 im_context_bindings 上扩展

**理由**:

1. **概念不匹配**
   - im_context_bindings 是"线程 → agent"映射，强调会话持久化
   - 多 Bot 场景需要"Bot → 群组"映射，强调 Bot 身份管理

2. **扩展成本高**
   - 若加 bot_id 字段，主键变成 `(source_jid, context_type, context_id, bot_id)`
   - 会导致级联改动：
     - `getImContextBinding()` 需新增 bot_id 参数
     - `upsertImContextBinding()` 需处理 bot_id
     - 所有调用方需适配 4 元组主键
   - `registered_groups.jid` 作为群组 → workspace 的映射，与 bot 无关，难以在此层面集成 bot 概念

3. **业务流程不同**
   - 当前: 群组 ← (user) → workspace main + optional threads
   - 多 Bot: 群组 ← (bot-1, bot-2, ...) → workspace main
   - 需要新的"bot 注册"、"bot 权限"、"bot 消息分派"逻辑

### 证据：现有的专业化设计

- `registered_groups.target_agent_id`: 群组 → agent（一对一）
- `registered_groups.target_main_jid`: 群组 → workspace（一对一）
- `im_context_bindings`: 线程 → agent（一对多线程，每线程一 agent）

**都没有 bot 维度**，说明设计者有意避免在这些表中混入 Bot 身份概念。

---

## 5. registered_groups.jid 主键分析

### 定义

**位置**: `src/db.ts:300-308`

```sql
CREATE TABLE IF NOT EXISTS registered_groups (
  jid TEXT PRIMARY KEY,
  ...
);
```

**答案**: **是**，`jid` 是 PRIMARY KEY（单列）

**JID 格式**:
- 飞书群: `feishu:oc_xxx` (chat_id)
- 飞书私聊: `feishu:ou_yyy` (open_id)
- Web 工作区: `web:main`, `web:uuid`

### 改成 (jid, bot_id) 复合主键的影响

#### 1. 数据库迁移成本
**位置**: `src/db.ts:726-783` - 已有迁移示例

需要执行 ALTER TABLE 迁移：

```sql
-- 创建新表
CREATE TABLE registered_groups_new (
  jid TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  ... 其他列 ...
  PRIMARY KEY (jid, bot_id)
);

-- 迁移数据（每行添加默认 bot_id）
INSERT INTO registered_groups_new 
  SELECT *, 'default_bot' FROM registered_groups;

-- 交换表
DROP TABLE registered_groups;
ALTER TABLE registered_groups_new RENAME TO registered_groups;
```

#### 2. 查询逻辑改动范围

| 函数 | 位置 | 改动 |
|------|------|------|
| `getRegisteredGroup()` | `src/db.ts:2328` | 从 WHERE jid=? 改为 WHERE jid=? AND bot_id=? |
| `setRegisteredGroup()` | `src/db.ts:2338` | 新增 VALUES 中的 bot_id 参数 |
| `deleteRegisteredGroup()` | `src/db.ts:2371` | 需要指定 bot_id 才能精确删除 |
| `getJidsByFolder()` | `src/db.ts:2376` | 返回结果变成 (jid, bot_id) 对 |

#### 3. 上层业务逻辑改动范围

**广泛影响** - 所有需要访问 registered_groups 的地方：

1. **src/index.ts** (主应用逻辑)
   - `registeredGroups` 缓存对象改为二维 Map: `Map<jid, Map<botId, RegisteredGroup>>`
   - `buildResolveEffectiveChatJid()` 需传递 bot_id 上下文
   - `shouldProcessGroupMessage()` 需知道当前 bot_id
   - `isGroupOwnerMessage()` 需知道当前 bot_id

2. **src/routes/groups.ts** (群组管理 API)
   - GET /api/groups 返回格式改变（或隐藏 bot_id）
   - POST /api/groups/{jid}/bind 需参数化 bot_id

3. **src/routes/config.ts** (配置 API)
   - 绑定 API (`POST /api/config/im-bindings`) 需增加 bot_id 路由参数
   - 消息过滤逻辑需区分 bot_id

4. **Message Router** (`src/feishu.ts` 等)
   - `handleIncomingMessage()` 需识别哪个 bot 收到消息
   - 需要额外的 bot_id 注入机制（目前单 bot 全局 `botOpenId`）

#### 4. 现有代码中处理多 JID 的例子

**位置**: `src/db.ts:2375-2381` - 如何处理一对多关系

```typescript
export function getJidsByFolder(folder: string): string[] {
  const rows = db
    .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
    .all(folder) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}
```

这个函数返回 **N 个 jid**（一个 folder 对应多个群组）。
若改成 (jid, bot_id) 主键，返回值需改成 `Array<{ jid: string; bot_id: string }>`。

#### 5. 实际影响示意

**当前单 Bot 情景** (`src/index.ts:7004`)：
```typescript
const resolveEffectiveChatJid = buildResolveEffectiveChatJid();
// 这个闭包中的 registeredGroups 缓存是全局的，所有消息共用
```

**多 Bot 改进后** 需要改成：
```typescript
// 每个 bot 需要自己的闭包和缓存
const resolveEffectiveChatJid = buildResolveEffectiveChatJid(botId);
// 或者在消息处理流中注入 botId 标记
```

---

## 6. 结论与建议

### 最终建议: **新建独立 bots 表**

#### 结论

**不应复用** `im_context_bindings` 或在 `registered_groups.jid` 上扩展。

#### 理由

1. **概念分离**
   - `im_context_bindings`: 线程 → agent（会话持久化）
   - `registered_groups`: 群组 → workspace（绑定目标）
   - **bots** 表: Bot 实例 → 群组（Bot 身份与权限）
   
   三者解决三个不同的问题，混合会导致概念混乱。

2. **设计简洁**
   - 新 bots 表结构清晰：
     ```sql
     CREATE TABLE bots (
       id TEXT PRIMARY KEY,          -- UUID or appId
       app_id TEXT NOT NULL UNIQUE,  -- 飞书 App ID
       app_secret TEXT NOT NULL,     -- 飞书 App Secret (encrypted in DB)
       user_id TEXT NOT NULL,        -- Bot owner
       name TEXT NOT NULL,
       status TEXT DEFAULT 'active',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       FOREIGN KEY (user_id) REFERENCES users(id)
     );
     
     -- Bot → Group binding
     CREATE TABLE bot_group_bindings (
       bot_id TEXT NOT NULL,
       group_jid TEXT NOT NULL,
       bound_at TEXT NOT NULL,
       PRIMARY KEY (bot_id, group_jid),
       FOREIGN KEY (bot_id) REFERENCES bots(id),
       FOREIGN KEY (group_jid) REFERENCES registered_groups(jid)
     );
     ```

3. **改动最小化**
   - 无需修改 `registered_groups` 主键
   - `im_context_bindings` 保持不变（仍用于线程持久化）
   - 新增 bot 消息路由逻辑与现有逻辑正交

4. **多 Bot 流程清晰**
   ```
   飞书 Webhook 消息
     ↓ 解析 open_api_app_id
     ↓ 查询 bots 表 → 找到 bot_id
     ↓ 查询 bot_group_bindings → 确认此 bot 在此群组
     ↓ 查询 registered_groups(group_jid) → 获取 target_main_jid
     ↓ 通过 resolveEffectiveChatJid() 路由到 agent/workspace
     ✓ 处理消息
   ```

5. **已有先例**
   - 当前代码已有多表协作的成功案例：
     - `registered_groups.jid` + `im_context_bindings.source_jid` 的两层绑定
     - `agents` 表与 `registered_groups` 的关联

#### 不推荐改 registered_groups.jid 的原因

1. **迁移复杂** - 影响范围极广（几十个 SQL 函数和业务逻辑）
2. **破坏现有设计** - jid 作为群组标识符已深入应用各处
3. **语义冲突** - 群组与 Bot 是两个独立维度，不应合并
4. **向后兼容性差** - 现有 API 和数据都基于 jid 单列主键

#### 推荐的实现路径

1. **阶段 1**: 新增 bots + bot_group_bindings 表（无破坏）
2. **阶段 2**: 更新 Feishu 连接层（imManager）以支持多 bot 识别
3. **阶段 3**: 更新消息路由逻辑，在 shouldProcessGroupMessage 等处注入 bot_id 上下文
4. **阶段 4**: 前端 API 暴露 bot 管理、群组绑定关系

---

## 参考资料

| 文件 | 行号 | 内容 |
|------|------|------|
| src/db.ts | 309-321 | im_context_bindings 表定义 |
| src/db.ts | 300-308 | registered_groups 表定义 |
| src/db.ts | 2312-2318 | VALID_ACTIVATION_MODES 定义 |
| src/db.ts | 2320-2326 | parseActivationMode 函数 |
| src/db.ts | 2247-2273 | RegisteredGroupRow 类型 |
| src/db.ts | 2428-2519 | im_context_bindings 数据库操作函数 |
| src/index.ts | 6922-6944 | shouldProcessGroupMessage 函数 |
| src/index.ts | 6948-6958 | isGroupOwnerMessage 函数 |
| src/index.ts | 6752-6813 | buildResolveEffectiveChatJid 函数 |
| src/index.ts | 6650-6744 | resolveOrCreateThreadAgent 函数 |
| src/feishu.ts | 1128-1148 | 群聊 Mention 过滤逻辑 |
| src/types.ts | 49-73 | RegisteredGroup 接口 |
| src/types.ts | 329-340 | ImContextBinding 接口 |
| src/types.ts | 64 | activation_mode 类型定义 |
| src/routes/config.ts | 2565-2696 | IM 绑定 API 端点 |
| src/routes/groups.ts | 158 | activation_mode 在 API 响应中的用法 |

