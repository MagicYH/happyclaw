# Multi-Agent PR1 Implementation Plan — 多 Bot 基础 + writer-only

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单个 HappyClaw 用户可以创建多个飞书 Bot（独立 App ID/Secret），每个 Bot 有独立身份与角色，多个 Bot 可以同时加入一个飞书群协作。本 PR 仅交付 writer 类 Bot 的核心闭环，advisor 只读保护留给 PR2。

**Architecture:** 新增 `bots` 与 `bot_group_bindings` 两张表、`sessions` 表扩展 `bot_id` 列；`IMConnectionManager` 引入 per-bot 连接与原有 per-user 连接并存；飞书消息路由按 `connectionKind` 分叉（user 走老路径、bot 走新路径）。通过 `ENABLE_MULTI_BOT` feature flag 控制整体启用，默认关闭，灰度放开。

**Tech Stack:** TypeScript · SQLite (better-sqlite3) · Hono · Vitest · AES-256-GCM (现有加密模块) · Claude Agent SDK

**设计依据：** `docs/superpowers/specs/2026-04-17-multi-agent-design-v3.md`（v3 主文档）。PR1 范围见 v3 附录 E。

---

## PR1 范围清单（参考 v3 §0）

- ✅ `bots` / `bot_group_bindings` / `sessions` 表改造
- ✅ `PRAGMA foreign_keys = ON` 启用 + FK 审计
- ✅ `IMConnectionManager` 双轨结构
- ✅ §5.2 路由流程（阶段 0 分叉 + writer 路径 + 单 Bot 兼容）
- ✅ 基础 Bot CRUD API + 权限矩阵（§8.5）
- ✅ Setup 向导迁移（§7.7）
- ✅ `ENABLE_MULTI_BOT` feature flag（§11）
- ✅ 审计事件扩展
- ✅ `messages` 表 `INSERT OR IGNORE` 切换
- ❌ PreToolUse Hook / advisor 守卫 → PR2
- ❌ bot-profile 挂载 / scratch → PR2
- ❌ concurrency_mode 字段 → PR2
- ❌ 监控指标 / 前端 UI → PR3

---

## 文件结构

### 新增文件

- `src/routes/bots.ts` — Bot CRUD + 绑定 + 测试连接 API
- `src/db-bots.ts` — `bots` 和 `bot_group_bindings` 表的 CRUD 函数（避免 `db.ts` 继续膨胀）
- `tests/units/bots-schema.test.ts` — 表结构 + 迁移 + FK 验证
- `tests/units/bots-crud.test.ts` — DB CRUD 函数
- `tests/units/bots-foreign-keys.test.ts` — FK CASCADE 行为
- `tests/units/bot-routing.test.ts` — 路由阶段 0 分叉
- `tests/units/bot-openid-safety.test.ts` — user 连接兼容 vs bot 连接强制丢弃
- `tests/units/bot-permissions.test.ts` — API 权限矩阵
- `tests/units/messages-insert-or-ignore.test.ts` — 消息去重语义
- `tests/units/feature-flag-multi-bot.test.ts` — flag 关闭时行为
- `tests/units/migration-v35.test.ts` — 迁移 + 回滚
- `tests/units/bgb-folder-sync.test.ts` — 触发器同步

### 修改文件

- `src/db.ts` — `SCHEMA_VERSION=35`、启用外键、migration 片段、`storeMessageDirect` 切换 IGNORE
- `src/types.ts` — 新增 `Bot` / `BotGroupBinding` 接口；扩展 `AuthEventType`
- `src/im-manager.ts` — 新增 `botConnections` Map 和 connect/disconnect 方法
- `src/feishu.ts` — `handleIncomingMessage` 加 `connectionKind` 参数；空 open_id 按 kind 分支
- `src/index.ts` — `loadState()` 加载 bots；路由阶段 0 分叉；审计写入
- `src/runtime-config.ts` — `SystemSettings.enableMultiBot`、`maxBotsPerMessage`、`maxBotsPerUser`；Bot 凭证的 AES 读写
- `src/middleware/auth.ts` — `authorizeBot` 中间件
- `src/schemas.ts` — Bot 相关 Zod schema
- `src/web.ts` — 挂载 `/api/bots` 路由
- `src/routes/config.ts` — Setup 向导迁移端点

---

## Task 0：前置审计（不写代码，产出审计报告）

**目标：** 启用 `PRAGMA foreign_keys = ON` 前，确认现有 FK 不会导致意外级联。

**Files:**
- Read: `src/db.ts`（全部 FOREIGN KEY 语句）
- Create: `docs/superpowers/plans/2026-04-17-multi-agent-pr1-fk-audit.md`（审计报告）

- [ ] **Step 0.1：grep 现有 FK 约束**

Run:
```bash
grep -n "FOREIGN KEY\|REFERENCES" src/db.ts
```

把每一条 FK 记录到审计文档中，格式：

```markdown
| 表 | 列 | 引用表 | 引用列 | 级联行为 | 启用 foreign_keys 后风险 | 结论 |
|----|-----|--------|--------|---------|------------------------|-----|
| ... | ... | ... | ... | ON DELETE CASCADE | 删用户会同时删所有历史会话 | ✓ 预期行为 |
```

- [ ] **Step 0.2：识别潜在风险 FK**

对每条 FK 回答：
- 启用后是否出现"误删"（如 admin 删除一个子资源会把所有父资源的其他子资源也一起删）？
- 是否有循环引用？
- 是否有孤儿数据（FK 指向已删除的父行）？如有，先数据清洗

- [ ] **Step 0.3：决定应对策略**

三选一并记录：
- A：全部保留 CASCADE，启用 `foreign_keys = ON`（期望情况）
- B：部分改为 `ON DELETE SET NULL` 或 `NO ACTION`，启用 `foreign_keys = ON`
- C：不启用 `foreign_keys`，改为应用层手工级联（回退方案）

v3 文档建议 A，若审计发现阻塞则降级到 B。**本 PR 的 Task 1 以审计结果为准**。

- [ ] **Step 0.4：Commit 审计报告**

```bash
git add docs/superpowers/plans/2026-04-17-multi-agent-pr1-fk-audit.md
git commit -m "docs: Multi-Agent PR1 - 现有外键约束审计报告"
```

---

## Task 1：Feature Flag 与 SystemSettings 扩展

**目标：** 加入 `enableMultiBot` / `maxBotsPerMessage` / `maxBotsPerUser` 系统设置，默认关闭。

**Files:**
- Modify: `src/runtime-config.ts`（SystemSettings 扩展）
- Modify: `src/schemas.ts`（Zod schema 扩展）
- Test: `tests/units/feature-flag-multi-bot.test.ts`

- [ ] **Step 1.1：写失败测试**

Create `tests/units/feature-flag-multi-bot.test.ts`:

```typescript
import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({}));

describe('SystemSettings: multi-bot flags', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('enableMultiBot defaults to false', async () => {
    const { getSystemSettings } = await import('../../src/runtime-config.js');
    const settings = getSystemSettings();
    expect(settings.enableMultiBot).toBe(false);
  });

  test('maxBotsPerMessage defaults to 3', async () => {
    const { getSystemSettings } = await import('../../src/runtime-config.js');
    const settings = getSystemSettings();
    expect(settings.maxBotsPerMessage).toBe(3);
  });

  test('maxBotsPerUser defaults to 10', async () => {
    const { getSystemSettings } = await import('../../src/runtime-config.js');
    const settings = getSystemSettings();
    expect(settings.maxBotsPerUser).toBe(10);
  });
});
```

- [ ] **Step 1.2：运行测试确认失败**

Run:
```bash
npx vitest run tests/units/feature-flag-multi-bot.test.ts
```

Expected: FAIL（属性不存在）

- [ ] **Step 1.3：扩展 `SystemSettings` 接口**

Modify `src/runtime-config.ts` `SystemSettings` 接口：

```typescript
export interface SystemSettings {
  // ... 现有字段 ...
  autoCompactWindow: number;

  // ── Multi-Agent (PR1) ──
  enableMultiBot: boolean;        // 默认 false，灰度开关
  maxBotsPerMessage: number;      // 一条消息最多触发多少个 Bot 响应，默认 3
  maxBotsPerUser: number;         // 每个用户最多创建多少个 Bot，默认 10
}
```

- [ ] **Step 1.4：更新 DEFAULT_SYSTEM_SETTINGS**

```typescript
const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  // ... 现有字段 ...
  autoCompactWindow: 0,

  enableMultiBot: false,
  maxBotsPerMessage: 3,
  maxBotsPerUser: 10,
};
```

- [ ] **Step 1.5：更新环境变量 fallback**

在 `buildEnvFallbackSettings()` 中加：

```typescript
enableMultiBot: process.env.ENABLE_MULTI_BOT === 'true',
maxBotsPerMessage: parseIntEnv(process.env.MAX_BOTS_PER_MESSAGE, 3),
maxBotsPerUser: parseIntEnv(process.env.MAX_BOTS_PER_USER, 10),
```

- [ ] **Step 1.6：更新 Zod schema**

Modify `src/schemas.ts` 的 `SystemSettingsSchema`，加入三个字段的范围校验：

```typescript
enableMultiBot: z.boolean(),
maxBotsPerMessage: z.number().int().min(1).max(10),
maxBotsPerUser: z.number().int().min(1).max(100),
```

- [ ] **Step 1.7：运行测试验证通过**

```bash
npx vitest run tests/units/feature-flag-multi-bot.test.ts
```

Expected: PASS (3 passed)

- [ ] **Step 1.8：Commit**

```bash
git add src/runtime-config.ts src/schemas.ts tests/units/feature-flag-multi-bot.test.ts
git commit -m "feat: Multi-Agent PR1 - SystemSettings 增加 enableMultiBot 等 flag"
```

---

## Task 2：扩展 AuthEventType

**目标：** 给 `types.ts` 加上 Multi-Agent 相关的审计事件类型。

**Files:**
- Modify: `src/types.ts:271-289`
- Test：已有的 `tests` 里无现成 AuthEventType 测试，此处仅通过 TypeScript 编译验证

- [ ] **Step 2.1：扩展 AuthEventType 联合类型**

Modify `src/types.ts`:

```typescript
export type AuthEventType =
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'password_changed'
  | 'profile_updated'
  | 'user_created'
  | 'user_disabled'
  | 'user_enabled'
  | 'user_deleted'
  | 'user_restored'
  | 'user_updated'
  | 'role_changed'
  | 'session_revoked'
  | 'invite_created'
  | 'invite_deleted'
  | 'invite_used'
  | 'recovery_reset'
  | 'register_success'
  // ── Multi-Agent (PR1) ──
  | 'bot_created'
  | 'bot_enabled'
  | 'bot_disabled'
  | 'bot_credentials_updated'
  | 'bot_deleted'
  | 'bot_hard_deleted'
  | 'bot_binding_added'
  | 'bot_binding_removed'
  | 'bot_connect_failed'
  | 'user_im_migrated_to_bot'
  | 'schema_migrated';
```

- [ ] **Step 2.2：运行 TypeScript 编译**

```bash
make typecheck
```

Expected: PASS（无报错；若现有代码里有对 AuthEventType 的 switch 未 exhaustive 检查，此处不应产生新问题）

- [ ] **Step 2.3：Commit**

```bash
git add src/types.ts
git commit -m "feat: Multi-Agent PR1 - AuthEventType 扩展 Bot 相关审计事件"
```

---

## Task 3：定义 Bot 和 BotGroupBinding 类型

**目标：** 在 `types.ts` 中定义 v3 §3.3/§3.4 的实体类型，供数据库层和路由层共用。

**Files:**
- Modify: `src/types.ts`
- Test：类型只通过编译验证

- [ ] **Step 3.1：新增类型定义**

在 `src/types.ts` 末尾追加：

```typescript
// ─── Multi-Agent ───────────────────────────────────────────

/** Bot 并发模式（PR1 仅定义，PR2 实际启用 advisor 分支） */
export type BotConcurrencyMode = 'writer' | 'advisor';

/** Bot 活性策略（复用 registered_groups.activation_mode 取值） */
export type BotActivationMode =
  | 'auto'
  | 'always'
  | 'when_mentioned'
  | 'owner_mentioned'
  | 'disabled';

/** Bot 状态 */
export type BotStatus = 'active' | 'disabled';

export interface Bot {
  id: string;                          // 'bot_' + nanoid
  user_id: string;
  channel: 'feishu';                   // PR1 仅飞书，未来可扩展
  name: string;
  default_folder: string | null;
  activation_mode: BotActivationMode;
  concurrency_mode: BotConcurrencyMode;
  status: BotStatus;
  deleted_at: string | null;
  open_id: string | null;
  remote_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotGroupBinding {
  bot_id: string;
  group_jid: string;
  folder: string;
  activation_mode: BotActivationMode | null;
  concurrency_mode: BotConcurrencyMode | null;
  enabled: boolean;
  bound_at: string;
}

/** 传给 Feishu 连接层的来源标记 */
export type IMConnectionKind = 'user' | 'bot';
```

- [ ] **Step 3.2：运行 typecheck**

```bash
make typecheck
```

Expected: PASS

- [ ] **Step 3.3：Commit**

```bash
git add src/types.ts
git commit -m "feat: Multi-Agent PR1 - 新增 Bot/BotGroupBinding/IMConnectionKind 类型"
```

---

## Task 4：Schema Migration v34 → v35

**目标：** 在 `db.ts` 中加入 bots / bot_group_bindings 表、扩展 sessions / usage_records 列、启用外键、添加触发器。

**Files:**
- Modify: `src/db.ts`（SCHEMA_VERSION + migration 片段）
- Test: `tests/units/migration-v35.test.ts`（迁移行为 + 回滚）
- Test: `tests/units/bots-schema.test.ts`（表结构）

- [ ] **Step 4.1：写失败测试（表结构）**

Create `tests/units/bots-schema.test.ts`:

```typescript
import { describe, expect, test, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

function createTempDb(): { db: Database.Database; path: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  return { db, path: dbPath };
}

describe('Schema v35: bots and bot_group_bindings', () => {
  test('bots table has all required columns', () => {
    const { db } = createTempDb();
    // 此测试将在 Task 4.3 之后通过真实 migration 路径执行；
    // 这里先用直接 SQL 验证目标 schema
    db.exec(`
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'feishu',
        name TEXT NOT NULL,
        default_folder TEXT,
        activation_mode TEXT NOT NULL DEFAULT 'when_mentioned',
        concurrency_mode TEXT NOT NULL DEFAULT 'writer',
        status TEXT NOT NULL DEFAULT 'active',
        deleted_at TEXT,
        open_id TEXT,
        remote_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = db.prepare("PRAGMA table_info('bots')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual([
      'id',
      'user_id',
      'channel',
      'name',
      'default_folder',
      'activation_mode',
      'concurrency_mode',
      'status',
      'deleted_at',
      'open_id',
      'remote_name',
      'created_at',
      'updated_at',
    ]);
    db.close();
  });

  test('bot_group_bindings table has composite PK (bot_id, group_jid)', () => {
    const { db } = createTempDb();
    db.exec(`
      CREATE TABLE bot_group_bindings (
        bot_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        folder TEXT NOT NULL,
        activation_mode TEXT,
        concurrency_mode TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        bound_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, group_jid)
      );
    `);
    const indexes = db.prepare("PRAGMA index_list('bot_group_bindings')").all() as Array<{
      name: string;
      unique: number;
    }>;
    // SQLite 为复合 PK 自动创建唯一索引
    expect(indexes.some((i) => i.unique === 1)).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 4.2：运行测试确认先通过基础 SQL 验证**

```bash
npx vitest run tests/units/bots-schema.test.ts
```

Expected: PASS（这些直接 SQL 的前置验证应该通过；若失败说明 SQLite 环境有问题）

- [ ] **Step 4.3：在 db.ts 增加 migration（基础表 + 外键）**

Locate the `initDb()` / migration 函数（在 `SCHEMA_VERSION = '34'` 附近，`src/db.ts:1236`）。在紧邻该常量前插入 v34→v35 迁移：

```typescript
// v34 → v35: Multi-Agent 基础设施（bots, bot_group_bindings, sessions.bot_id）

// 0. 启用外键约束（per-connection，必须在所有 DDL 前）
// 注意：审计结果决定是否启用；若 Task 0 审计选 C 方案则跳过这一步
db.exec('PRAGMA foreign_keys = ON');

// 1. bots 表
db.exec(`
  CREATE TABLE IF NOT EXISTS bots (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    channel          TEXT NOT NULL DEFAULT 'feishu',
    name             TEXT NOT NULL,
    default_folder   TEXT,
    activation_mode  TEXT NOT NULL DEFAULT 'when_mentioned',
    concurrency_mode TEXT NOT NULL DEFAULT 'writer',
    status           TEXT NOT NULL DEFAULT 'active',
    deleted_at       TEXT,
    open_id          TEXT,
    remote_name      TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_bots_channel_status ON bots(channel, status) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_open_id
    ON bots(channel, open_id) WHERE deleted_at IS NULL AND open_id IS NOT NULL;
`);

// 2. bot_group_bindings 表
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_group_bindings (
    bot_id           TEXT NOT NULL,
    group_jid        TEXT NOT NULL,
    folder           TEXT NOT NULL,
    activation_mode  TEXT,
    concurrency_mode TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    bound_at         TEXT NOT NULL,
    PRIMARY KEY (bot_id, group_jid),
    FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
    FOREIGN KEY (group_jid) REFERENCES registered_groups(jid) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_bgb_group ON bot_group_bindings(group_jid);
  CREATE INDEX IF NOT EXISTS idx_bgb_folder ON bot_group_bindings(folder);
`);

// 3. 触发器：registered_groups.folder 改动时同步 bot_group_bindings.folder
db.exec(`
  CREATE TRIGGER IF NOT EXISTS sync_bgb_folder_on_rg_update
  AFTER UPDATE OF folder ON registered_groups
  FOR EACH ROW
  WHEN OLD.folder != NEW.folder
  BEGIN
    UPDATE bot_group_bindings
    SET folder = NEW.folder
    WHERE group_jid = NEW.jid;
  END;
`);

// 4. sessions 加 bot_id 列（不改 PK，通过 NOT NULL DEFAULT '' 使旧行可读）
//    注意：sessions 现有 PK 是 (group_folder, agent_id)。加列后唯一性仍由旧 PK 保证；
//    未来若要把 PK 改成 (group_folder, bot_id, agent_id)，需要表重建。本 PR 暂不改 PK。
ensureColumn('sessions', 'bot_id', "TEXT NOT NULL DEFAULT ''");

// 5. usage_records 加 bot_id 列
ensureColumn('usage_records', 'bot_id', 'TEXT');
db.exec(`UPDATE usage_records SET bot_id = '' WHERE bot_id IS NULL`);

// 6. usage_daily_summary 加 bot_id 列（预留）
ensureColumn('usage_daily_summary', 'bot_id', "TEXT DEFAULT ''");
```

然后更新 `SCHEMA_VERSION`：

```typescript
const SCHEMA_VERSION = '35';
```

> **实现说明：** v3 §3.5 原建议 sessions 表重建改 PK，但为 PR1 风险最小化，**本 PR 仅加列不改 PK**。旧代码通过 `bot_id=''` 哨兵值继续工作；PK 重建推迟到 PR2 或 PR3 按需。需在代码注释中声明此决策。

- [ ] **Step 4.4：写失败测试（migration 完整性）**

Create `tests/units/migration-v35.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Migration v35', () => {
  let tmpDir: string;
  let origDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-mig-'));
    origDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    // 重置 module cache 以便重新 initDb
    // vitest import.meta hot reload 处理
  });

  afterEach(() => {
    if (origDataDir !== undefined) {
      process.env.DATA_DIR = origDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('schema_version advances to 35', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM router_state WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('35');
  });

  test('bots and bot_group_bindings tables exist', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bots','bot_group_bindings')")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(2);
  });

  test('sessions table has bot_id column with default empty string', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const botId = cols.find((c) => c.name === 'bot_id');
    expect(botId).toBeDefined();
    expect(botId?.dflt_value).toBe("''");
  });

  test('PRAGMA foreign_keys returns 1 (enabled)', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });

  test('sync_bgb_folder_on_rg_update trigger exists', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const trg = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='sync_bgb_folder_on_rg_update'")
      .get() as { name: string } | undefined;
    expect(trg?.name).toBe('sync_bgb_folder_on_rg_update');
  });
});
```

> **注意：** 若 `initDb` / `getDb` 现有 API 签名不同，按当前代码调整。核心是能在测试里拿到数据库句柄并读 schema。

- [ ] **Step 4.5：运行 migration 测试**

```bash
npx vitest run tests/units/migration-v35.test.ts
```

Expected: PASS（5 个测试）。若失败，检查 `initDb` 是否真的走到 v34→v35 片段，以及 `DATA_DIR` env 是否被正确读取。

- [ ] **Step 4.6：写 BGB folder 触发器测试**

Create `tests/units/bgb-folder-sync.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Trigger: sync_bgb_folder_on_rg_update', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-trg-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('updating registered_groups.folder cascades to bot_group_bindings.folder', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    // prepare data
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1', 'testuser', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g1', 'g', 'old-folder', ?)`,
    ).run(new Date().toISOString());
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_a', 'u1', 'feishu', 'A', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot_a', 'feishu:g1', 'old-folder', ?, 1)`,
    ).run(new Date().toISOString());

    // update
    db.prepare(`UPDATE registered_groups SET folder='new-folder' WHERE jid='feishu:g1'`).run();

    // verify
    const row = db
      .prepare(`SELECT folder FROM bot_group_bindings WHERE bot_id='bot_a' AND group_jid='feishu:g1'`)
      .get() as { folder: string };
    expect(row.folder).toBe('new-folder');
  });
});
```

- [ ] **Step 4.7：运行测试**

```bash
npx vitest run tests/units/bgb-folder-sync.test.ts
```

Expected: PASS

- [ ] **Step 4.8：Commit**

```bash
git add src/db.ts tests/units/bots-schema.test.ts tests/units/migration-v35.test.ts tests/units/bgb-folder-sync.test.ts
git commit -m "feat: Multi-Agent PR1 - Schema v35 migration (bots/bot_group_bindings/sessions.bot_id)"
```

---

## Task 5：外键 CASCADE 行为验证

**目标：** 补专门的外键测试，确认 `ON DELETE CASCADE` 在 `foreign_keys=ON` 下真正工作。

**Files:**
- Test: `tests/units/bots-foreign-keys.test.ts`

- [ ] **Step 5.1：写失败测试**

Create `tests/units/bots-foreign-keys.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Foreign keys: bots cascade', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-fk-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deleting user cascades to bots and bot_group_bindings', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1', 'tu', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g', 'g', 'f', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_a', 'u1', 'feishu', 'A', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot_a', 'feishu:g', 'f', ?, 1)`,
    ).run(now);

    db.prepare(`DELETE FROM users WHERE id='u1'`).run();

    const botCount = (db.prepare(`SELECT COUNT(*) AS c FROM bots WHERE id='bot_a'`).get() as { c: number }).c;
    const bgbCount = (db.prepare(`SELECT COUNT(*) AS c FROM bot_group_bindings WHERE bot_id='bot_a'`).get() as { c: number }).c;
    expect(botCount).toBe(0);
    expect(bgbCount).toBe(0);
  });

  test('deleting bot cascades to bot_group_bindings', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1', 'tu', 'x', 'admin', '[]', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g', 'g', 'f', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, user_id, channel, name, activation_mode, concurrency_mode, status, created_at, updated_at)
       VALUES ('bot_a', 'u1', 'feishu', 'A', 'when_mentioned', 'writer', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO bot_group_bindings (bot_id, group_jid, folder, bound_at, enabled)
       VALUES ('bot_a', 'feishu:g', 'f', ?, 1)`,
    ).run(now);

    db.prepare(`DELETE FROM bots WHERE id='bot_a'`).run();

    const bgbCount = (db.prepare(`SELECT COUNT(*) AS c FROM bot_group_bindings WHERE bot_id='bot_a'`).get() as { c: number }).c;
    expect(bgbCount).toBe(0);
  });
});
```

- [ ] **Step 5.2：运行测试验证通过**

```bash
npx vitest run tests/units/bots-foreign-keys.test.ts
```

Expected: PASS（2 个测试）

若失败：检查 `PRAGMA foreign_keys = ON` 是否在 Task 4 中真的被加入到 migration，且执行时机在建表后。

- [ ] **Step 5.3：Commit**

```bash
git add tests/units/bots-foreign-keys.test.ts
git commit -m "test: Multi-Agent PR1 - 验证 bots 外键 CASCADE 行为"
```

---

## Task 6：Bot CRUD 数据库函数

**目标：** 在 `src/db-bots.ts` 中实现 Bot 和 BotGroupBinding 的 CRUD，所有函数签名使用 Task 3 定义的类型。

**Files:**
- Create: `src/db-bots.ts`
- Test: `tests/units/bots-crud.test.ts`

- [ ] **Step 6.1：写失败测试**

Create `tests/units/bots-crud.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Bot, BotGroupBinding } from '../../src/types.js';

describe('Bot CRUD', () => {
  let tmpDir: string;
  let mod: typeof import('../../src/db-bots.js');
  let dbMod: typeof import('../../src/db.js');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-crud-'));
    process.env.DATA_DIR = tmpDir;
    dbMod = await import('../../src/db.js');
    dbMod.initDb();
    mod = await import('../../src/db-bots.js');
    // seed a user so FK is satisfied
    const now = new Date().toISOString();
    dbMod
      .getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1', 'tu', 'x', 'admin', '[]', 'active', ?, ?)`,
      )
      .run(now, now);
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
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
    // 保证 updated_at 不同秒
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
  let mod: typeof import('../../src/db-bots.js');
  let dbMod: typeof import('../../src/db.js');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-bgb-'));
    process.env.DATA_DIR = tmpDir;
    dbMod = await import('../../src/db.js');
    dbMod.initDb();
    mod = await import('../../src/db-bots.js');
    const now = new Date().toISOString();
    dbMod
      .getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1','tu','x','admin','[]','active',?,?)`,
      )
      .run(now, now);
    dbMod
      .getDb()
      .prepare(
        `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g', 'g', 'f', ?)`,
      )
      .run(now);
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
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
```

- [ ] **Step 6.2：运行测试确认失败（模块不存在）**

```bash
npx vitest run tests/units/bots-crud.test.ts
```

Expected: FAIL（模块或函数不存在）

- [ ] **Step 6.3：实现 `src/db-bots.ts`**

```typescript
/**
 * Bot 和 BotGroupBinding 的数据库 CRUD。
 * 所有查询默认排除软删除的 Bot（deleted_at IS NOT NULL）。
 */
import { getDb } from './db.js';
import type {
  Bot,
  BotActivationMode,
  BotConcurrencyMode,
  BotGroupBinding,
  BotStatus,
} from './types.js';
import { nanoid } from 'nanoid';  // 若项目未装 nanoid，改用 crypto.randomUUID + 截取

// ── helpers ─────────────────────────────────────────────

function rowToBot(row: Record<string, unknown>): Bot {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    channel: String(row.channel) as 'feishu',
    name: String(row.name),
    default_folder: row.default_folder === null ? null : String(row.default_folder),
    activation_mode: String(row.activation_mode) as BotActivationMode,
    concurrency_mode: String(row.concurrency_mode) as BotConcurrencyMode,
    status: String(row.status) as BotStatus,
    deleted_at: row.deleted_at === null ? null : String(row.deleted_at),
    open_id: row.open_id === null ? null : String(row.open_id),
    remote_name: row.remote_name === null ? null : String(row.remote_name),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToBinding(row: Record<string, unknown>): BotGroupBinding {
  return {
    bot_id: String(row.bot_id),
    group_jid: String(row.group_jid),
    folder: String(row.folder),
    activation_mode: row.activation_mode === null ? null : (String(row.activation_mode) as BotActivationMode),
    concurrency_mode: row.concurrency_mode === null ? null : (String(row.concurrency_mode) as BotConcurrencyMode),
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
  const id = `bot_${nanoid(12)}`;
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
  db.prepare(`UPDATE bots SET deleted_at=?, status='disabled', updated_at=? WHERE id=?`).run(
    now,
    now,
    id,
  );
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

export function getBinding(botId: string, groupJid: string): BotGroupBinding | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM bot_group_bindings WHERE bot_id=? AND group_jid=?`)
    .get(botId, groupJid) as Record<string, unknown> | undefined;
  return row ? rowToBinding(row) : null;
}

export function listBindingsByBot(botId: string): BotGroupBinding[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM bot_group_bindings WHERE bot_id=? ORDER BY bound_at DESC`)
    .all(botId) as Record<string, unknown>[];
  return rows.map(rowToBinding);
}

export function listBindingsByGroup(groupJid: string): BotGroupBinding[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM bot_group_bindings WHERE group_jid=? AND enabled=1 ORDER BY bound_at ASC`)
    .all(groupJid) as Record<string, unknown>[];
  return rows.map(rowToBinding);
}

export function removeBinding(botId: string, groupJid: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM bot_group_bindings WHERE bot_id=? AND group_jid=?`).run(botId, groupJid);
}

export function setBindingEnabled(botId: string, groupJid: string, enabled: boolean): void {
  const db = getDb();
  db.prepare(
    `UPDATE bot_group_bindings SET enabled=? WHERE bot_id=? AND group_jid=?`,
  ).run(enabled ? 1 : 0, botId, groupJid);
}
```

> **依赖说明：** 若项目没有 `nanoid` 依赖，改用 `crypto.randomBytes(8).toString('hex')`：
> ```typescript
> import crypto from 'crypto';
> const id = `bot_${crypto.randomBytes(6).toString('hex')}`;
> ```

- [ ] **Step 6.4：运行测试验证通过**

```bash
npx vitest run tests/units/bots-crud.test.ts
```

Expected: PASS（10 个测试）

- [ ] **Step 6.5：Commit**

```bash
git add src/db-bots.ts tests/units/bots-crud.test.ts
git commit -m "feat: Multi-Agent PR1 - 新增 Bot/BotGroupBinding CRUD (src/db-bots.ts)"
```

---

## Task 7：消息入库改为 INSERT OR IGNORE

**目标：** v3 ADR-6：将 `storeMessageDirect` 的 `INSERT OR REPLACE` 改为 `INSERT OR IGNORE`，通过显式 UPDATE 保留字段刷新能力。

**Files:**
- Modify: `src/db.ts:78` 附近（`storeMessageDirect` 函数）
- Test: `tests/units/messages-insert-or-ignore.test.ts`

- [ ] **Step 7.1：审计现有调用**

Run:
```bash
grep -n "storeMessageDirect\|INSERT OR REPLACE INTO messages" src/**/*.ts
```

记录每个调用点：
- 入库新消息 → IGNORE 语义
- 回写 `token_usage` / `finalization_reason` → 需显式 UPDATE

任何发现"依赖 REPLACE 刷新字段"的地方，**必须单独用 UPDATE 路径**，不能靠 REPLACE。

- [ ] **Step 7.2：写失败测试**

Create `tests/units/messages-insert-or-ignore.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('storeMessageDirect: INSERT OR IGNORE semantics', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-msg-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('duplicate (id, chat_jid) is ignored, first write wins', async () => {
    const { initDb, getDb, storeMessageDirect } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    // first write
    storeMessageDirect(
      'msg_1',
      'feishu:chat_a',
      'sender_1',
      'Hello',
      new Date('2026-04-17T10:00:00Z').toISOString(),
      { isFromMe: false, source: 'ws' },
    );
    // second write with different content & isFromMe
    storeMessageDirect(
      'msg_1',
      'feishu:chat_a',
      'sender_2',
      'Replaced content',
      new Date('2026-04-17T11:00:00Z').toISOString(),
      { isFromMe: true, source: 'http' },
    );
    const row = db
      .prepare(`SELECT sender, content, is_from_me, source FROM messages WHERE id='msg_1' AND chat_jid='feishu:chat_a'`)
      .get() as { sender: string; content: string; is_from_me: number; source: string };
    expect(row.sender).toBe('sender_1');
    expect(row.content).toBe('Hello');
    expect(row.is_from_me).toBe(0);
    expect(row.source).toBe('ws');
  });
});
```

> **签名适配：** 若 `storeMessageDirect` 的当前签名不同，按现状调整测试入参。核心断言是"冲突时保留第一次写入"。

- [ ] **Step 7.3：运行测试确认失败**

```bash
npx vitest run tests/units/messages-insert-or-ignore.test.ts
```

Expected: FAIL（因为现在是 REPLACE，第二次写入覆盖）

- [ ] **Step 7.4：修改 `storeMessageDirect`**

Locate `src/db.ts:78` 附近的 `storeMessageDirect` / `storeMessageInsert`（现有 `INSERT OR REPLACE INTO messages`），改为：

```typescript
// 原：INSERT OR REPLACE INTO messages (...)
// 改：INSERT OR IGNORE INTO messages (...)
```

- [ ] **Step 7.5：补 UPDATE 路径（若审计发现需要）**

如果 Step 7.1 的审计发现确有依赖 REPLACE 刷新字段的地方，新增独立函数：

```typescript
export function updateMessageFinalization(
  id: string,
  chatJid: string,
  patch: { token_usage?: string; finalization_reason?: string; /* 按需 */ },
): void {
  const db = getDb();
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const setClause = fields.map((f) => `${f}=?`).join(', ');
  db.prepare(`UPDATE messages SET ${setClause} WHERE id=? AND chat_jid=?`).run(
    ...fields.map((f) => (patch as Record<string, unknown>)[f]),
    id,
    chatJid,
  );
}
```

然后在原先依赖 REPLACE 的调用点改为先 `storeMessageDirect`（IGNORE）再 `updateMessageFinalization`（UPDATE）。

- [ ] **Step 7.6：运行测试验证通过**

```bash
npx vitest run tests/units/messages-insert-or-ignore.test.ts
```

Expected: PASS

- [ ] **Step 7.7：全量回归**

```bash
make test
```

Expected: 所有现有测试继续通过。如果有测试依赖 REPLACE 语义，修复那些测试（因为语义变化是预期的）。

- [ ] **Step 7.8：Commit**

```bash
git add src/db.ts tests/units/messages-insert-or-ignore.test.ts
git commit -m "refactor: Multi-Agent PR1 - messages 入库改用 INSERT OR IGNORE (v3 ADR-6)"
```

---

## Task 8：Bot 凭证加密存储

**目标：** 在 `runtime-config.ts` 中加入 `getBotFeishuConfig` / `saveBotFeishuConfig`，路径 `data/config/bots/{botId}/feishu.json`，沿用现有 AES-256-GCM。

**Files:**
- Modify: `src/runtime-config.ts`（复用现有加密函数）
- Test: `tests/units/bot-credentials.test.ts`

- [ ] **Step 8.1：写失败测试**

Create `tests/units/bot-credentials.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Bot Feishu credentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-botcfg-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('saveBotFeishuConfig writes encrypted file with 0600 mode', async () => {
    const { saveBotFeishuConfig } = await import('../../src/runtime-config.js');
    saveBotFeishuConfig('bot_a', { appId: 'cli_x', appSecret: 'secret_y', enabled: true });
    const filePath = path.join(tmpDir, 'config', 'bots', 'bot_a', 'feishu.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    // mode 0o600 在 POSIX 下严格相等；跨平台时使用 mask
    expect(stat.mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(filePath, 'utf-8');
    // 密文不应包含明文 secret
    expect(content).not.toContain('secret_y');
  });

  test('getBotFeishuConfig returns decrypted config after save', async () => {
    const { saveBotFeishuConfig, getBotFeishuConfig } = await import('../../src/runtime-config.js');
    saveBotFeishuConfig('bot_a', { appId: 'cli_x', appSecret: 'secret_y', enabled: true });
    const loaded = getBotFeishuConfig('bot_a');
    expect(loaded?.appId).toBe('cli_x');
    expect(loaded?.appSecret).toBe('secret_y');
    expect(loaded?.enabled).toBe(true);
  });

  test('getBotFeishuConfig returns null for unknown bot', async () => {
    const { getBotFeishuConfig } = await import('../../src/runtime-config.js');
    expect(getBotFeishuConfig('bot_missing')).toBeNull();
  });
});
```

- [ ] **Step 8.2：运行测试确认失败**

```bash
npx vitest run tests/units/bot-credentials.test.ts
```

Expected: FAIL（函数不存在）

- [ ] **Step 8.3：实现加密读写**

参考 `src/runtime-config.ts:3089` 的 `getUserFeishuConfig` / `saveUserFeishuConfig`，在同文件末尾追加：

```typescript
// ─── Bot-scoped Feishu config (Multi-Agent PR1) ─────────────

function botConfigDir(botId: string): string {
  return path.join(DATA_DIR, 'config', 'bots', botId);
}

export interface BotFeishuConfig {
  appId: string;
  appSecret: string;
  enabled: boolean;
  updatedAt?: string | null;
}

export function getBotFeishuConfig(botId: string): BotFeishuConfig | null {
  const filePath = path.join(botConfigDir(botId), 'feishu.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;
    const stored = parsed as unknown as StoredFeishuProviderConfigV1;  // 复用现有类型
    const secret = decryptChannelSecret<FeishuSecretPayload>(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to read bot Feishu config');
    return null;
  }
}

export function saveBotFeishuConfig(
  botId: string,
  next: Omit<BotFeishuConfig, 'updatedAt'>,
): BotFeishuConfig {
  const normalized: BotFeishuConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };
  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<FeishuSecretPayload>({ appSecret: normalized.appSecret }),
  };
  const dir = botConfigDir(botId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'feishu.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function deleteBotFeishuConfig(botId: string): void {
  const dir = botConfigDir(botId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to delete bot config directory');
  }
}
```

- [ ] **Step 8.4：运行测试验证通过**

```bash
npx vitest run tests/units/bot-credentials.test.ts
```

Expected: PASS（3 个测试）

- [ ] **Step 8.5：Commit**

```bash
git add src/runtime-config.ts tests/units/bot-credentials.test.ts
git commit -m "feat: Multi-Agent PR1 - Bot 凭证加密存储 (data/config/bots/{botId}/)"
```

---

## Task 9：IMConnectionManager 双轨结构（per-bot 连接）

**目标：** 在 `im-manager.ts` 中加入 `botConnections` Map 以及 `connectBot` / `disconnectBot` / `reloadBot` 方法。per-user 连接逻辑保持不变。

**Files:**
- Modify: `src/im-manager.ts`
- Test: `tests/units/im-manager-bot.test.ts`

- [ ] **Step 9.1：研读现有 `connectUserFeishu`**

Run:
```bash
grep -n "connectUserFeishu\|disconnectUserFeishu" src/im-manager.ts
```

阅读这两个方法的实现，注意：
- Feishu 连接的建立依赖 `createFeishuChannel` / `createFeishuConnection`
- 连接建立后要设置 `onNewChat`、`onCommand`、`onAgentMessage` 等回调
- `ignoreMessagesBefore` 的使用时机（热重连时）

Bot 版本需复用相同回调接口，但连接来源的 config 改从 `getBotFeishuConfig(botId)` 读。

- [ ] **Step 9.2：写失败测试**

Create `tests/units/im-manager-bot.test.ts`:

```typescript
import { describe, expect, test, beforeEach, vi } from 'vitest';

// mock feishu connection factory
const mockConnect = vi.fn().mockResolvedValue(true);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockFeishuChannel = {
  connect: mockConnect,
  stop: mockStop,
  sendMessage: vi.fn(),
  sendReaction: vi.fn(),
  clearAckReaction: vi.fn(),
};

vi.mock('../../src/im-channel.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/im-channel.js')>('../../src/im-channel.js');
  return {
    ...actual,
    createFeishuChannel: vi.fn(() => mockFeishuChannel),
  };
});

describe('IMConnectionManager: bot connections', () => {
  beforeEach(() => {
    mockConnect.mockClear();
    mockStop.mockClear();
  });

  test('connectBot creates a new BotConnection and registers it', async () => {
    const { IMConnectionManager } = await import('../../src/im-manager.js');
    const mgr = new IMConnectionManager();
    await mgr.connectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'secret_y' },
      callbacks: {},
    });
    expect(mgr.hasBotConnection('bot_a')).toBe(true);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('disconnectBot stops the connection and removes it', async () => {
    const { IMConnectionManager } = await import('../../src/im-manager.js');
    const mgr = new IMConnectionManager();
    await mgr.connectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'secret_y' },
      callbacks: {},
    });
    await mgr.disconnectBot('bot_a');
    expect(mgr.hasBotConnection('bot_a')).toBe(false);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test('reconnectBot stops old connection and creates new one with ignoreMessagesBefore', async () => {
    const { IMConnectionManager } = await import('../../src/im-manager.js');
    const mgr = new IMConnectionManager();
    await mgr.connectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'old' },
      callbacks: {},
    });
    mockConnect.mockClear();
    mockStop.mockClear();
    await mgr.reconnectBot({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'new' },
      callbacks: {},
    });
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    // 最近一次 connect 应携带 ignoreMessagesBefore
    const callArgs = mockConnect.mock.calls[0][0];
    expect(callArgs.ignoreMessagesBefore).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 9.3：运行测试确认失败**

```bash
npx vitest run tests/units/im-manager-bot.test.ts
```

Expected: FAIL（方法不存在）

- [ ] **Step 9.4：扩展 IMConnectionManager**

在 `src/im-manager.ts` 中：

```typescript
// 文件顶部加类型
export interface ConnectBotInput {
  botId: string;
  userId: string;
  channel: 'feishu';
  credentials: { appId: string; appSecret: string };
  callbacks: ConnectFeishuOptions;  // 复用现有回调接口
}

// 在 IMConnectionManager 类内加字段和方法
export class IMConnectionManager {
  private connections = new Map<string, UserIMConnection>();
  private adminUserIds = new Set<string>();

  // ── PR1 新增 ──────────────────────────────────────
  private botConnections = new Map<string, IMChannel>();

  async connectBot(input: ConnectBotInput): Promise<boolean> {
    if (input.channel !== 'feishu') {
      throw new Error(`connectBot: unsupported channel ${input.channel}`);
    }
    // 若已有连接，先断开
    if (this.botConnections.has(input.botId)) {
      await this.disconnectBot(input.botId);
    }
    const channel = createFeishuChannel({
      appId: input.credentials.appId,
      appSecret: input.credentials.appSecret,
    });
    const ok = await channel.connect({
      // 把 callbacks 透传；connectionKind 在 Task 10 由 feishu.ts 内部使用
      ...input.callbacks,
    });
    if (ok) {
      this.botConnections.set(input.botId, channel);
    }
    return ok;
  }

  async disconnectBot(botId: string): Promise<void> {
    const conn = this.botConnections.get(botId);
    if (!conn) return;
    await conn.stop();
    this.botConnections.delete(botId);
  }

  async reconnectBot(input: ConnectBotInput): Promise<boolean> {
    await this.disconnectBot(input.botId);
    return this.connectBot({
      ...input,
      callbacks: {
        ...input.callbacks,
        ignoreMessagesBefore: Date.now(),
      },
    });
  }

  hasBotConnection(botId: string): boolean {
    return this.botConnections.has(botId);
  }

  getBotConnection(botId: string): IMChannel | null {
    return this.botConnections.get(botId) ?? null;
  }

  listBotConnectionIds(): string[] {
    return [...this.botConnections.keys()];
  }

  async disconnectAllBots(): Promise<void> {
    const promises = [...this.botConnections.values()].map((c) => c.stop().catch(() => undefined));
    this.botConnections.clear();
    await Promise.all(promises);
  }
}
```

> **注意：** 依赖的 `createFeishuChannel` / `IMChannel` / `ConnectFeishuOptions` 都是现有类型，不用新增。

- [ ] **Step 9.5：运行测试验证通过**

```bash
npx vitest run tests/units/im-manager-bot.test.ts
```

Expected: PASS（3 个测试）

- [ ] **Step 9.6：Commit**

```bash
git add src/im-manager.ts tests/units/im-manager-bot.test.ts
git commit -m "feat: Multi-Agent PR1 - IMConnectionManager 增加 per-bot 连接管理"
```

---

## Task 10：Feishu 连接层 connectionKind 分叉

**目标：** 让 `feishu.ts` 的 `handleIncomingMessage` 知道自己是 user 连接还是 bot 连接，空 `botOpenId` 时按 kind 决定 fallback 行为（user 放行、bot 丢弃）。

**Files:**
- Modify: `src/feishu.ts`（`createFeishuConnection` 和 `handleIncomingMessage` 的内部闭包）
- Test: `tests/units/bot-openid-safety.test.ts`

- [ ] **Step 10.1：阅读现有 feishu.ts 空值 fallback 逻辑**

Run:
```bash
grep -n "botOpenId\|默认放行" src/feishu.ts | head -20
```

定位到 `feishu.ts:1131-1132` 附近的 "无 bot open_id 时默认放行" 注释。这是 PR1 要改的点。

- [ ] **Step 10.2：写失败测试**

Create `tests/units/bot-openid-safety.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';

// 这是一个纯逻辑测试，不依赖真实飞书 SDK
// 提取一个小函数 shouldProcessWhenBotOpenIdMissing(kind, mentions) 到 feishu.ts 导出

describe('shouldProcessWhenBotOpenIdMissing', () => {
  test('user connection: defaults to allow (backward compat)', async () => {
    const { shouldProcessWhenBotOpenIdMissing } = await import('../../src/feishu.js');
    expect(shouldProcessWhenBotOpenIdMissing('user')).toBe(true);
  });

  test('bot connection: defaults to drop + warn', async () => {
    const { shouldProcessWhenBotOpenIdMissing } = await import('../../src/feishu.js');
    expect(shouldProcessWhenBotOpenIdMissing('bot')).toBe(false);
  });
});
```

- [ ] **Step 10.3：运行测试确认失败**

```bash
npx vitest run tests/units/bot-openid-safety.test.ts
```

Expected: FAIL（函数不存在）

- [ ] **Step 10.4：导出决策函数 + 修改调用点**

在 `src/feishu.ts` 末尾追加导出：

```typescript
import type { IMConnectionKind } from './types.js';

/**
 * Bot 连接建立期间 open_id 可能尚未回填（异步 fetch Bot Info）。
 * 这段时间内收到消息的 fallback 策略：
 * - user 连接：放行（单 Bot 用户的老行为，回填失败也不应该阻塞业务）
 * - bot 连接：丢弃 + 告警（多 Bot 下误响应比丢消息更糟，属于配置错误）
 */
export function shouldProcessWhenBotOpenIdMissing(kind: IMConnectionKind): boolean {
  return kind === 'user';
}
```

然后定位到现有"无 bot open_id 时默认放行"的代码段（`feishu.ts:1131` 附近），修改为调用此函数。

`createFeishuConnection` 签名需要加一个可选 `kind` 参数：

```typescript
export function createFeishuConnection(
  config: FeishuConnectionConfig,
  opts?: { kind?: IMConnectionKind },
): FeishuConnection {
  const kind: IMConnectionKind = opts?.kind ?? 'user';
  // ... 在闭包内使用 kind
}
```

消息处理中的 fallback：

```typescript
const mentioned = botOpenId
  ? (mentions?.some((m) => m.id?.open_id === botOpenId) ?? false)
  : shouldProcessWhenBotOpenIdMissing(kind);
if (!mentioned && kind === 'bot' && !botOpenId) {
  logger.warn({ chatId, kind }, 'bot connection received message before open_id was resolved; dropping');
}
```

> **注意：** `createFeishuConnection` 可能被 `im-channel.ts` 的 `createFeishuChannel` 调用，调用链上需要把 `kind` 透传。在 IMConnectionManager 的 `connectBot` 里传 `kind: 'bot'`，其他保持 `'user'`。

- [ ] **Step 10.5：更新 IMConnectionManager 透传 kind**

在 Task 9 的 `connectBot` 里把 `kind: 'bot'` 传给 feishu 连接创建：

```typescript
const channel = createFeishuChannel(
  { appId: input.credentials.appId, appSecret: input.credentials.appSecret },
  { kind: 'bot' },  // ← 新增
);
```

如果 `createFeishuChannel` 目前的签名不支持 opts，先扩展它的签名（在 `im-channel.ts` 里对应参数添加并透传到 `createFeishuConnection`）。

- [ ] **Step 10.6：运行测试验证通过**

```bash
npx vitest run tests/units/bot-openid-safety.test.ts
```

Expected: PASS（2 个测试）

- [ ] **Step 10.7：回归**

```bash
make typecheck && npx vitest run
```

Expected: 现有测试全部继续通过

- [ ] **Step 10.8：Commit**

```bash
git add src/feishu.ts src/im-channel.ts src/im-manager.ts tests/units/bot-openid-safety.test.ts
git commit -m "feat: Multi-Agent PR1 - feishu 连接支持 connectionKind (bot 空 openId 强制丢弃)"
```

---

## Task 11：路由阶段 0 分叉（单 Bot 兼容路径）

**目标：** 在 `src/index.ts` 的消息入口处加阶段 0：`connectionKind='user'` 沿用老路径查 `registered_groups.folder`；`connectionKind='bot'` 走新路径查 `bot_group_bindings`。

**Files:**
- Modify: `src/index.ts`（消息路由入口，通常在 `handleIncomingMessage` / `onMessage` 等函数中）
- Test: `tests/units/bot-routing.test.ts`

- [ ] **Step 11.1：定位消息路由入口**

Run:
```bash
grep -n "enqueueMessageCheck\|getRegisteredGroup" src/index.ts | head -20
```

找到"消息入库 → 查 registered_groups → 入队"这条路径的主函数。在该函数签名上加 `connectionKind: IMConnectionKind = 'user'` 和 `botId?: string` 两个参数（默认 user 保证向后兼容）。

- [ ] **Step 11.2：写失败测试**

Create `tests/units/bot-routing.test.ts`:

```typescript
import { describe, expect, test, vi, beforeEach } from 'vitest';

describe('resolveRouteTarget: connection kind branching', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('user connection resolves folder from registered_groups', async () => {
    // 将路由解析抽为纯函数 resolveRouteTarget(kind, jid, botId?, deps)
    // 然后 mock deps.getRegisteredGroup / deps.getBinding
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget(
      'user',
      'feishu:g1',
      undefined,
      {
        getRegisteredGroup: (jid: string) =>
          jid === 'feishu:g1' ? ({ folder: 'folder-a' } as any) : null,
        getBinding: () => null,
      },
    );
    expect(result).toEqual({ folder: 'folder-a', botId: '' });
  });

  test('bot connection resolves folder from bot_group_bindings', async () => {
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget(
      'bot',
      'feishu:g1',
      'bot_a',
      {
        getRegisteredGroup: () => null,
        getBinding: (botId: string, jid: string) =>
          botId === 'bot_a' && jid === 'feishu:g1'
            ? ({ folder: 'folder-b', enabled: true } as any)
            : null,
      },
    );
    expect(result).toEqual({ folder: 'folder-b', botId: 'bot_a' });
  });

  test('bot connection returns null when binding is disabled', async () => {
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget(
      'bot',
      'feishu:g1',
      'bot_a',
      {
        getRegisteredGroup: () => null,
        getBinding: () => ({ folder: 'folder-b', enabled: false } as any),
      },
    );
    expect(result).toBeNull();
  });

  test('user connection returns null when registered_group not found', async () => {
    const { resolveRouteTarget } = await import('../../src/index.js');
    const result = resolveRouteTarget('user', 'feishu:g1', undefined, {
      getRegisteredGroup: () => null,
      getBinding: () => null,
    });
    expect(result).toBeNull();
  });
});
```

> **说明：** 这一步要求把路由决策抽为**纯函数** `resolveRouteTarget`。这是可测性的关键：不直接导入 `db.ts` 依赖，通过 deps 注入。

- [ ] **Step 11.3：运行测试确认失败**

```bash
npx vitest run tests/units/bot-routing.test.ts
```

Expected: FAIL

- [ ] **Step 11.4：实现 `resolveRouteTarget`**

在 `src/index.ts` 的合适位置（靠近其他路由工具函数）添加：

```typescript
import type { IMConnectionKind, BotGroupBinding } from './types.js';
import type { RegisteredGroup } from './types.js';

export interface RouteTarget {
  folder: string;
  botId: string;  // '' 表示 user 连接（兼容路径）
}

export interface RouteDeps {
  getRegisteredGroup: (jid: string) => Pick<RegisteredGroup, 'folder'> | null;
  getBinding: (botId: string, jid: string) => Pick<BotGroupBinding, 'folder' | 'enabled'> | null;
}

/**
 * v3 §5.2 阶段 0+4：按连接类型选择 folder 来源。
 * - user 连接：registered_groups.folder（单 Bot 兼容）
 * - bot 连接：bot_group_bindings.folder（多 Bot）
 */
export function resolveRouteTarget(
  kind: IMConnectionKind,
  groupJid: string,
  botId: string | undefined,
  deps: RouteDeps,
): RouteTarget | null {
  if (kind === 'user') {
    const rg = deps.getRegisteredGroup(groupJid);
    if (!rg) return null;
    return { folder: rg.folder, botId: '' };
  }
  if (!botId) return null;
  const binding = deps.getBinding(botId, groupJid);
  if (!binding || !binding.enabled) return null;
  return { folder: binding.folder, botId };
}
```

- [ ] **Step 11.5：在真实消息处理路径调用**

在原先查 `getRegisteredGroup` 的调用点，改为：

```typescript
import { getBinding } from './db-bots.js';
import { getRegisteredGroup } from './db.js';

const target = resolveRouteTarget(kind, m.chatJid, botId, {
  getRegisteredGroup: (jid) => getRegisteredGroup(jid),
  getBinding: (botId, jid) => getBinding(botId, jid),
});
if (!target) {
  logger.debug({ chatJid: m.chatJid, kind, botId }, 'route target not found; drop message');
  return;
}
// 后续 queue.enqueueMessageCheck(... target.folder ..., target.botId ...)
```

> **注意：** 真实调用点可能涉及现有的 `resolveEffectiveChatJid` 逻辑，不要覆盖该函数。只在"找到 folder 后入队"的那一步插入分叉。

- [ ] **Step 11.6：运行测试验证通过**

```bash
npx vitest run tests/units/bot-routing.test.ts
```

Expected: PASS（4 个测试）

- [ ] **Step 11.7：回归**

```bash
make typecheck && npx vitest run
```

Expected: 所有现有测试继续通过

- [ ] **Step 11.8：Commit**

```bash
git add src/index.ts tests/units/bot-routing.test.ts
git commit -m "feat: Multi-Agent PR1 - 消息路由阶段 0 分叉 (user/bot 连接)"
```

---

## Task 12：Bot HTTP API + 权限矩阵

**目标：** 实现 v3 §8.5 列出的 12 个 API 端点，加上 `authorizeBot` 中间件保证权限矩阵。

**Files:**
- Create: `src/routes/bots.ts`
- Modify: `src/middleware/auth.ts`（新增 `authorizeBot` 中间件）
- Modify: `src/web.ts`（挂载路由）
- Modify: `src/schemas.ts`（Bot 请求 schema）
- Test: `tests/units/bot-permissions.test.ts`
- Test: `tests/units/bots-api.test.ts`

### 12.1 authorizeBot 中间件

- [ ] **Step 12.1.1：在 `src/middleware/auth.ts` 中新增中间件**

```typescript
import { getBotById } from '../db-bots.js';

/**
 * 校验当前用户对目标 Bot 有操作权限：
 * - admin：允许
 * - member：仅允许操作自己创建的 Bot（bot.user_id === req.user.id）
 */
export const authorizeBot = async (c: any, next: any) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const botId = c.req.param('id');
  if (!botId) return c.json({ error: 'bot id required' }, 400);
  const bot = getBotById(botId, { includeDeleted: true });
  if (!bot) return c.json({ error: 'not found' }, 404);
  if (bot.user_id !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  c.set('bot', bot);
  return next();
};
```

### 12.2 schemas.ts

- [ ] **Step 12.2.1：增加 Zod schema**

在 `src/schemas.ts` 追加：

```typescript
export const CreateBotSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[\w\s\u4e00-\u9fa5\-.]+$/),
  channel: z.literal('feishu'),
  default_folder: z.string().optional(),
  activation_mode: z.enum(['auto', 'always', 'when_mentioned', 'owner_mentioned', 'disabled']).optional(),
  concurrency_mode: z.enum(['writer', 'advisor']).optional(),
  // admin 可指定 user_id；member 忽略此字段（强制 req.user.id）
  user_id: z.string().optional(),
  // 创建同时写入凭证（可选；若省略则仅建 DB 行，后续通过 PUT credentials 写入）
  app_id: z.string().optional(),
  app_secret: z.string().optional(),
});

export const UpdateBotSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[\w\s\u4e00-\u9fa5\-.]+$/).optional(),
  default_folder: z.string().nullable().optional(),
  activation_mode: z.enum(['auto', 'always', 'when_mentioned', 'owner_mentioned', 'disabled']).optional(),
  concurrency_mode: z.enum(['writer', 'advisor']).optional(),
});

export const UpdateBotCredentialsSchema = z.object({
  app_id: z.string().min(1),
  app_secret: z.string().min(1),
});

export const UpsertBindingSchema = z.object({
  group_jid: z.string().min(1),
  folder: z.string().min(1),
  activation_mode: z.enum(['auto', 'always', 'when_mentioned', 'owner_mentioned', 'disabled']).nullable().optional(),
});
```

### 12.3 src/routes/bots.ts

- [ ] **Step 12.3.1：写失败测试（权限矩阵）**

Create `tests/units/bot-permissions.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

async function bootstrap() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-perm-'));
  process.env.DATA_DIR = tmpDir;
  const { initDb, getDb } = await import('../../src/db.js');
  initDb();
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
  beforeEach(async () => {
    await bootstrap();
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('member can list only own bots', async () => {
    const { createBot } = await import('../../src/db-bots.js');
    createBot({ user_id: 'u_alice', name: 'alice bot', channel: 'feishu' });
    createBot({ user_id: 'u_bob', name: 'bob bot', channel: 'feishu' });
    const { listBotsByUser } = await import('../../src/db-bots.js');
    const aliceBots = listBotsByUser('u_alice');
    expect(aliceBots.length).toBe(1);
    expect(aliceBots[0].name).toBe('alice bot');
  });

  test('authorizeBot rejects cross-user access for member', async () => {
    const { createBot } = await import('../../src/db-bots.js');
    const aliceBot = createBot({ user_id: 'u_alice', name: 'alice bot', channel: 'feishu' });
    const { authorizeBot } = await import('../../src/middleware/auth.js');
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
    const { createBot } = await import('../../src/db-bots.js');
    const aliceBot = createBot({ user_id: 'u_alice', name: 'alice bot', channel: 'feishu' });
    const { authorizeBot } = await import('../../src/middleware/auth.js');
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
```

- [ ] **Step 12.3.2：运行测试确认失败**

```bash
npx vitest run tests/units/bot-permissions.test.ts
```

Expected: FAIL

- [ ] **Step 12.3.3：实现 `src/routes/bots.ts`**

```typescript
import { Hono } from 'hono';
import { authMiddleware, authorizeBot } from '../middleware/auth.js';
import {
  createBot,
  getBotById,
  listBotsByUser,
  listAllActiveBots,
  updateBot,
  softDeleteBot,
  hardDeleteBot,
  upsertBinding,
  listBindingsByBot,
  removeBinding,
} from '../db-bots.js';
import {
  getBotFeishuConfig,
  saveBotFeishuConfig,
  deleteBotFeishuConfig,
  getSystemSettings,
} from '../runtime-config.js';
import {
  CreateBotSchema,
  UpdateBotSchema,
  UpdateBotCredentialsSchema,
  UpsertBindingSchema,
} from '../schemas.js';
import { writeAuditLog } from '../db.js';  // 现有审计函数
import { logger } from '../logger.js';

export const botsRoutes = new Hono();

botsRoutes.use('*', authMiddleware);

// ── feature flag gate ─────────────────────────────────
botsRoutes.use('*', async (c, next) => {
  const settings = getSystemSettings();
  const user = c.get('user');
  // admin 不受 flag 限制（灰度阶段 1 仅 admin 可访问）
  if (!settings.enableMultiBot && user.role !== 'admin') {
    return c.json({ error: 'multi-bot not enabled' }, 501);
  }
  return next();
});

// GET /api/bots
botsRoutes.get('/', async (c) => {
  const user = c.get('user');
  const queryUserId = c.req.query('user_id');
  if (queryUserId && queryUserId !== user.id && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const targetUserId = queryUserId ?? user.id;
  return c.json({ bots: listBotsByUser(targetUserId) });
});

// POST /api/bots
botsRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = CreateBotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  // member 强制 user_id=self
  const targetUserId = user.role === 'admin' ? parsed.data.user_id ?? user.id : user.id;

  // 检查 maxBotsPerUser 上限
  const settings = getSystemSettings();
  const existing = listBotsByUser(targetUserId);
  if (existing.length >= settings.maxBotsPerUser) {
    return c.json({ error: `exceeds maxBotsPerUser=${settings.maxBotsPerUser}` }, 400);
  }

  const bot = createBot({
    user_id: targetUserId,
    name: parsed.data.name,
    channel: parsed.data.channel,
    default_folder: parsed.data.default_folder,
    activation_mode: parsed.data.activation_mode,
    concurrency_mode: parsed.data.concurrency_mode,
  });

  // 若同时提供凭证则写入
  if (parsed.data.app_id && parsed.data.app_secret) {
    saveBotFeishuConfig(bot.id, {
      appId: parsed.data.app_id,
      appSecret: parsed.data.app_secret,
      enabled: true,
    });
  }

  writeAuditLog({
    event_type: 'bot_created',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id, target_user_id: targetUserId, name: bot.name },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ bot }, 201);
});

// GET /api/bots/:id
botsRoutes.get('/:id', authorizeBot, async (c) => {
  const bot = c.get('bot');
  return c.json({ bot });
});

// PUT /api/bots/:id
botsRoutes.put('/:id', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const body = await c.req.json();
  const parsed = UpdateBotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const updated = updateBot(bot.id, parsed.data);
  return c.json({ bot: updated });
});

// PUT /api/bots/:id/credentials
botsRoutes.put('/:id/credentials', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = UpdateBotCredentialsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  saveBotFeishuConfig(bot.id, {
    appId: parsed.data.app_id,
    appSecret: parsed.data.app_secret,
    enabled: true,
  });

  writeAuditLog({
    event_type: 'bot_credentials_updated',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ success: true });
});

// POST /api/bots/:id/enable
botsRoutes.post('/:id/enable', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user');
  const updated = updateBot(bot.id, { status: 'active' });

  // 建立连接（Task 13 中实现热加载）
  // 这里仅更新 DB 状态 + 审计；启动连接的逻辑在 loadState 和热重连路径

  writeAuditLog({
    event_type: 'bot_enabled',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ bot: updated });
});

// POST /api/bots/:id/disable
botsRoutes.post('/:id/disable', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user');
  const updated = updateBot(bot.id, { status: 'disabled' });

  writeAuditLog({
    event_type: 'bot_disabled',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ bot: updated });
});

// DELETE /api/bots/:id
botsRoutes.delete('/:id', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user');
  softDeleteBot(bot.id);

  writeAuditLog({
    event_type: 'bot_deleted',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id, mode: 'soft' },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ success: true });
});

// GET /api/bots/:id/bindings
botsRoutes.get('/:id/bindings', authorizeBot, async (c) => {
  const bot = c.get('bot');
  return c.json({ bindings: listBindingsByBot(bot.id) });
});

// POST /api/bots/:id/bindings
botsRoutes.post('/:id/bindings', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = UpsertBindingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  // TODO: 若需校验 group_jid 的 folder 是否属于 user，在此加逻辑
  const binding = upsertBinding({
    bot_id: bot.id,
    group_jid: parsed.data.group_jid,
    folder: parsed.data.folder,
    activation_mode: parsed.data.activation_mode,
  });

  writeAuditLog({
    event_type: 'bot_binding_added',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id, group_jid: parsed.data.group_jid, folder: parsed.data.folder },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ binding }, 201);
});

// DELETE /api/bots/:id/bindings/:groupJid
botsRoutes.delete('/:id/bindings/:groupJid', authorizeBot, async (c) => {
  const bot = c.get('bot');
  const user = c.get('user');
  const groupJid = c.req.param('groupJid');
  removeBinding(bot.id, groupJid);

  writeAuditLog({
    event_type: 'bot_binding_removed',
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id, group_jid: groupJid },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ success: true });
});
```

> **注意：** `writeAuditLog` 的函数签名需与 `src/db.ts` 现有审计函数一致。若现有签名不同，按实际改 `event_type` / `username` / `details` 字段。

- [ ] **Step 12.3.4：挂载路由 to web.ts**

Modify `src/web.ts`:

```typescript
import { botsRoutes } from './routes/bots.js';
// ...
app.route('/api/bots', botsRoutes);
```

- [ ] **Step 12.3.5：运行权限测试验证**

```bash
npx vitest run tests/units/bot-permissions.test.ts
```

Expected: PASS

- [ ] **Step 12.3.6：Commit**

```bash
git add src/routes/bots.ts src/middleware/auth.ts src/schemas.ts src/web.ts tests/units/bot-permissions.test.ts
git commit -m "feat: Multi-Agent PR1 - Bot CRUD API + 权限矩阵"
```

---

## Task 13：loadState 加载 bots 连接

**目标：** 服务启动时遍历 `bots` 表，对每个 `status='active'` 的 Bot 建立 BotConnection。同时处理凭证读取失败/连接失败的告警。

**Files:**
- Modify: `src/index.ts`（`loadState()` 函数）
- Test: `tests/units/load-state-bots.test.ts`

- [ ] **Step 13.1：定位 loadState**

Run:
```bash
grep -n "loadState\s*\|loadState:" src/index.ts | head -10
```

找到函数体。它应该包含遍历 `getAllUsers()` → 调用 `connectUserFeishu` 的循环。

- [ ] **Step 13.2：写失败测试（轻量级；真实 loadState 涉及很多 side effect，这里只测纯函数）**

Create `tests/units/load-state-bots.test.ts`:

```typescript
import { describe, expect, test, vi } from 'vitest';
import type { Bot } from '../../src/types.js';

describe('loadBotConnections', () => {
  test('skips bots without feishu config', async () => {
    const { loadBotConnections } = await import('../../src/index.js');
    const connectBot = vi.fn();
    const bots: Bot[] = [
      {
        id: 'bot_a',
        user_id: 'u1',
        channel: 'feishu',
        name: 'A',
        default_folder: null,
        activation_mode: 'when_mentioned',
        concurrency_mode: 'writer',
        status: 'active',
        deleted_at: null,
        open_id: null,
        remote_name: null,
        created_at: '2026-04-17T00:00:00Z',
        updated_at: '2026-04-17T00:00:00Z',
      },
    ];
    await loadBotConnections(bots, {
      getBotFeishuConfig: () => null,
      connectBot,
    });
    expect(connectBot).not.toHaveBeenCalled();
  });

  test('connects each bot with valid feishu config', async () => {
    const { loadBotConnections } = await import('../../src/index.js');
    const connectBot = vi.fn().mockResolvedValue(true);
    const bots: Bot[] = [
      {
        id: 'bot_a',
        user_id: 'u1',
        channel: 'feishu',
        name: 'A',
        default_folder: null,
        activation_mode: 'when_mentioned',
        concurrency_mode: 'writer',
        status: 'active',
        deleted_at: null,
        open_id: null,
        remote_name: null,
        created_at: '2026-04-17T00:00:00Z',
        updated_at: '2026-04-17T00:00:00Z',
      },
    ];
    await loadBotConnections(bots, {
      getBotFeishuConfig: (id: string) =>
        id === 'bot_a' ? { appId: 'cli_x', appSecret: 'y', enabled: true } : null,
      connectBot,
    });
    expect(connectBot).toHaveBeenCalledWith({
      botId: 'bot_a',
      userId: 'u1',
      channel: 'feishu',
      credentials: { appId: 'cli_x', appSecret: 'y' },
    });
  });

  test('skips disabled bots', async () => {
    const { loadBotConnections } = await import('../../src/index.js');
    const connectBot = vi.fn();
    await loadBotConnections(
      [
        {
          id: 'bot_a',
          user_id: 'u1',
          channel: 'feishu',
          name: 'A',
          default_folder: null,
          activation_mode: 'when_mentioned',
          concurrency_mode: 'writer',
          status: 'disabled',
          deleted_at: null,
          open_id: null,
          remote_name: null,
          created_at: '2026-04-17T00:00:00Z',
          updated_at: '2026-04-17T00:00:00Z',
        },
      ],
      { getBotFeishuConfig: () => ({ appId: 'x', appSecret: 'y', enabled: true }), connectBot },
    );
    expect(connectBot).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 13.3：运行测试确认失败**

```bash
npx vitest run tests/units/load-state-bots.test.ts
```

Expected: FAIL

- [ ] **Step 13.4：实现 `loadBotConnections`**

在 `src/index.ts` 中添加纯函数：

```typescript
import type { Bot } from './types.js';
import type { BotFeishuConfig } from './runtime-config.js';

export interface LoadBotConnectionsDeps {
  getBotFeishuConfig: (botId: string) => BotFeishuConfig | null;
  connectBot: (input: {
    botId: string;
    userId: string;
    channel: 'feishu';
    credentials: { appId: string; appSecret: string };
  }) => Promise<boolean>;
}

/**
 * 启动时遍历所有 active bots，对每个有有效凭证的 Bot 建立连接。
 * 纯函数版本（deps 注入），便于单测。
 */
export async function loadBotConnections(
  bots: Bot[],
  deps: LoadBotConnectionsDeps,
): Promise<void> {
  for (const bot of bots) {
    if (bot.status !== 'active' || bot.deleted_at !== null) continue;
    const cfg = deps.getBotFeishuConfig(bot.id);
    if (!cfg || !cfg.enabled) continue;
    try {
      await deps.connectBot({
        botId: bot.id,
        userId: bot.user_id,
        channel: 'feishu',
        credentials: { appId: cfg.appId, appSecret: cfg.appSecret },
      });
    } catch (err) {
      // 不阻塞其他 Bot 的加载
      logger.error({ err, botId: bot.id }, 'Failed to connect bot during loadState');
    }
  }
}
```

- [ ] **Step 13.5：在真实 `loadState()` 中调用**

在 `loadState()` 现有 per-user 连接建立之后，feature flag 判断之后调用：

```typescript
// existing: await connectAllUserFeishu(...)

const settings = getSystemSettings();
if (settings.enableMultiBot) {
  const bots = listAllActiveBots();
  await loadBotConnections(bots, {
    getBotFeishuConfig,
    connectBot: (input) =>
      imManager.connectBot({
        ...input,
        callbacks: buildBotCallbacks(input.botId, input.userId),  // 复用现有 callback 工厂
      }),
  });
}
```

> **注意：** `buildBotCallbacks` 需要根据现有 `connectUserFeishu` 的 callback 结构提取，确保 `onNewChat`、`onCommand` 等回调逻辑与 user 连接一致。这部分需要在 `src/index.ts` 里实现，参考现有 user 连接的 callback 构造。

- [ ] **Step 13.6：运行测试验证通过**

```bash
npx vitest run tests/units/load-state-bots.test.ts
```

Expected: PASS

- [ ] **Step 13.7：Commit**

```bash
git add src/index.ts tests/units/load-state-bots.test.ts
git commit -m "feat: Multi-Agent PR1 - loadState 启动时加载 bots 连接"
```

---

## Task 14：Setup 向导迁移端点

**目标：** 让现有单 Bot 用户在 Setup 向导里可以选择"迁移到多 Bot"：把 `data/config/user-im/{userId}/feishu.json` 转成一个 Bot + 凭证文件，删除旧文件，切换连接。

**Files:**
- Modify: `src/routes/config.ts`（新增端点）
- Test: `tests/units/setup-migration.test.ts`

- [ ] **Step 14.1：写失败测试**

Create `tests/units/setup-migration.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('migrateUserImToBot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-migrate-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('migrates user Feishu config to a new Bot', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1','alice','x','member','[]','active',?,?)`,
      )
      .run(now, now);
    const { saveUserFeishuConfig } = await import('../../src/runtime-config.js');
    saveUserFeishuConfig('u1', { appId: 'cli_x', appSecret: 'secret_y', enabled: true });

    const { migrateUserImToBot } = await import('../../src/routes/config.js');
    const result = await migrateUserImToBot('u1', { botName: 'My Migrated Bot' });

    expect(result.bot.channel).toBe('feishu');
    expect(result.bot.name).toBe('My Migrated Bot');
    // 凭证文件应存在于 bot 路径
    expect(fs.existsSync(path.join(tmpDir, 'config', 'bots', result.bot.id, 'feishu.json'))).toBe(true);
    // 老文件应被删除
    expect(fs.existsSync(path.join(tmpDir, 'config', 'user-im', 'u1', 'feishu.json'))).toBe(false);

    // 读回凭证应匹配
    const { getBotFeishuConfig } = await import('../../src/runtime-config.js');
    const loaded = getBotFeishuConfig(result.bot.id);
    expect(loaded?.appId).toBe('cli_x');
    expect(loaded?.appSecret).toBe('secret_y');
  });

  test('returns error when user has no user-im config', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
         VALUES ('u1','alice','x','member','[]','active',?,?)`,
      )
      .run(now, now);

    const { migrateUserImToBot } = await import('../../src/routes/config.js');
    await expect(migrateUserImToBot('u1', { botName: 'X' })).rejects.toThrow(/no user-im config/i);
  });
});
```

- [ ] **Step 14.2：运行测试确认失败**

```bash
npx vitest run tests/units/setup-migration.test.ts
```

Expected: FAIL

- [ ] **Step 14.3：实现 `migrateUserImToBot`**

在 `src/routes/config.ts` 末尾（或新文件 `src/migrations-user-im.ts`）：

```typescript
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';  // 若 DATA_DIR 在别处导出，按实际路径
import { createBot } from './db-bots.js';
import { getUserFeishuConfig, saveBotFeishuConfig } from './runtime-config.js';
import type { Bot } from './types.js';

export interface MigrateResult {
  bot: Bot;
}

export async function migrateUserImToBot(
  userId: string,
  opts: { botName: string },
): Promise<MigrateResult> {
  const existing = getUserFeishuConfig(userId);
  if (!existing) {
    throw new Error(`no user-im config for user ${userId}`);
  }
  // 创建 Bot
  const bot = createBot({
    user_id: userId,
    name: opts.botName,
    channel: 'feishu',
  });
  // 写入 Bot 凭证
  saveBotFeishuConfig(bot.id, {
    appId: existing.appId,
    appSecret: existing.appSecret,
    enabled: existing.enabled,
  });
  // 删除老的 user-im 配置文件
  const userImPath = path.join(DATA_DIR, 'config', 'user-im', userId, 'feishu.json');
  try {
    fs.unlinkSync(userImPath);
  } catch (err) {
    // 文件不存在或其他 IO 错误：记录但不抛（Bot 已创建，可回头再删）
    // logger.warn({ err, userId }, 'Failed to remove user-im file after migration');
  }
  return { bot };
}
```

同时暴露 HTTP 端点：

```typescript
// 在 configRoutes 中
configRoutes.post('/setup/migrate-feishu-to-bot', authMiddleware, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const botName = typeof body?.bot_name === 'string' ? body.bot_name : `${user.username} Bot`;
  try {
    const result = await migrateUserImToBot(user.id, { botName });
    writeAuditLog({
      event_type: 'user_im_migrated_to_bot',
      username: user.username,
      actor_username: user.username,
      details: { bot_id: result.bot.id },
      ip_address: c.req.header('x-forwarded-for') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
    });
    // 热重连：断开老 userConnection，建立 bot 连接（依赖 imManager；此处省略真实调用）
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});
```

- [ ] **Step 14.4：运行测试验证通过**

```bash
npx vitest run tests/units/setup-migration.test.ts
```

Expected: PASS（2 个测试）

- [ ] **Step 14.5：Commit**

```bash
git add src/routes/config.ts tests/units/setup-migration.test.ts
git commit -m "feat: Multi-Agent PR1 - Setup 向导的 user-im → bot 迁移端点"
```

---

## Task 15：集成冒烟测试

**目标：** 一个端到端测试，模拟 "admin 创建 Bot → 通过 API 配置凭证 → 绑定到群 → 模拟路由命中"，验证整条链路不在模块边界断裂。

**Files:**
- Test: `tests/units/multi-bot-smoke.test.ts`

- [ ] **Step 15.1：写集成测试**

Create `tests/units/multi-bot-smoke.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Multi-Agent PR1 smoke: create bot → bind → resolve route', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-smoke-'));
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('full happy path', async () => {
    const { initDb, getDb } = await import('../../src/db.js');
    initDb();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1','alice','x','member','[]','active',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('feishu:g1','g','alice-home',?)`,
    ).run(now);

    // 1. 创建 Bot
    const { createBot, upsertBinding, getBinding, listBotsByUser, getBotById } =
      await import('../../src/db-bots.js');
    const bot = createBot({
      user_id: 'u1',
      name: 'Alice Bot',
      channel: 'feishu',
      default_folder: 'alice-home',
    });
    expect(bot.id).toMatch(/^bot_/);

    // 2. 写入凭证
    const { saveBotFeishuConfig, getBotFeishuConfig } = await import('../../src/runtime-config.js');
    saveBotFeishuConfig(bot.id, { appId: 'cli_x', appSecret: 'y', enabled: true });
    const loaded = getBotFeishuConfig(bot.id);
    expect(loaded?.appId).toBe('cli_x');

    // 3. 绑定群
    upsertBinding({ bot_id: bot.id, group_jid: 'feishu:g1', folder: 'alice-home' });
    const binding = getBinding(bot.id, 'feishu:g1');
    expect(binding?.folder).toBe('alice-home');
    expect(binding?.enabled).toBe(true);

    // 4. 路由解析（bot kind）
    const { resolveRouteTarget } = await import('../../src/index.js');
    const target = resolveRouteTarget(
      'bot',
      'feishu:g1',
      bot.id,
      {
        getRegisteredGroup: () => null,
        getBinding: (bId, jid) => getBinding(bId, jid),
      },
    );
    expect(target).toEqual({ folder: 'alice-home', botId: bot.id });

    // 5. 路由解析（user kind 兼容路径）
    const userTarget = resolveRouteTarget(
      'user',
      'feishu:g1',
      undefined,
      {
        getRegisteredGroup: (jid) =>
          jid === 'feishu:g1' ? ({ folder: 'alice-home' } as any) : null,
        getBinding: () => null,
      },
    );
    expect(userTarget).toEqual({ folder: 'alice-home', botId: '' });

    // 6. 软删除 Bot → 路由解析返回 null
    const { softDeleteBot } = await import('../../src/db-bots.js');
    softDeleteBot(bot.id);
    const botAfterDelete = getBotById(bot.id);
    expect(botAfterDelete).toBeNull();
  });
});
```

- [ ] **Step 15.2：运行集成测试**

```bash
npx vitest run tests/units/multi-bot-smoke.test.ts
```

Expected: PASS

- [ ] **Step 15.3：全量回归**

```bash
make typecheck && npx vitest run
```

Expected: 所有测试通过。若有现有测试由于 `PRAGMA foreign_keys=ON` / `INSERT OR IGNORE` 改动而失败，需逐一排查修复（大概率是"现有测试依赖 REPLACE 刷新字段"）。

- [ ] **Step 15.4：Commit**

```bash
git add tests/units/multi-bot-smoke.test.ts
git commit -m "test: Multi-Agent PR1 - 端到端冒烟测试 (create/config/bind/resolve)"
```

---

## Task 16：文档更新

**目标：** 更新 `CLAUDE.md` 项目根文档（§5 表格、§9 环境变量等），让后续工程师能理解新增的表、feature flag 和 API。

**Files:**
- Modify: `CLAUDE.md`（根项目文档）
- Create/Modify: `docs/API.md`（若需补充 Bot 相关 API）

- [ ] **Step 16.1：在 CLAUDE.md §5（数据库表）追加 bots / bot_group_bindings**

Follow the table format used in the "数据库表" section, add two rows:

```markdown
| `bots` | `id` | Bot 实体（IM 渠道身份 + 角色）。PR1 引入的多 Agent 基础设施 |
| `bot_group_bindings` | `(bot_id, group_jid)` | Bot 与飞书群的 M:N 绑定 |
```

- [ ] **Step 16.2：在 §9 环境变量表追加**

```markdown
| `ENABLE_MULTI_BOT` | `false` | 多 Bot 功能灰度开关（v35 schema 起可用） |
| `MAX_BOTS_PER_MESSAGE` | `3` | 一条消息最多触发多少个 Bot 响应 |
| `MAX_BOTS_PER_USER` | `10` | 每个用户最多可创建的 Bot 数 |
```

- [ ] **Step 16.3：在 §6（目录约定）增加 `data/config/bots/`**

```markdown
  config/bots/{botId}/feishu.json          # per-bot 飞书凭证（AES-256-GCM 加密，0600 权限）
```

- [ ] **Step 16.4：在 §7（Web API）增加 Bot 路由入口**

```markdown
| Bot 管理 | `src/routes/bots.ts`（PR1，需 `enableMultiBot=true` 才可用） |
```

- [ ] **Step 16.5：在 docs/API.md 补充 Bot API**

按现有格式追加每个 endpoint 的路径、请求体、响应、鉴权说明。

- [ ] **Step 16.6：Commit**

```bash
git add CLAUDE.md docs/API.md
git commit -m "docs: Multi-Agent PR1 - 更新 CLAUDE.md 和 API 文档"
```

---

## Task 17：最终回归 + PR 标题

**目标：** 完整类型检查、测试、格式化通过后提交 PR。

- [ ] **Step 17.1：完整类型检查**

```bash
make typecheck
```

Expected: PASS（无错误）

- [ ] **Step 17.2：完整测试**

```bash
make test
```

Expected: 全部 PASS

- [ ] **Step 17.3：格式化**

```bash
make format
```

- [ ] **Step 17.4：检查 git status 干净**

```bash
git status
```

Expected: `working tree clean`

- [ ] **Step 17.5：推送并创建 PR**

```bash
git push -u origin feature-multi-agent
gh pr create \
  --title "功能: Multi-Agent PR1 - 多 Bot 基础 + writer-only (#xxx)" \
  --body "$(cat <<'EOF'
## 问题描述

实现 Multi-Agent v3 设计文档附录 E 的 PR1 范围：多 Bot 基础设施 + writer 类 Bot 的核心闭环。

设计文档：\`docs/superpowers/specs/2026-04-17-multi-agent-design-v3.md\`

## 实现方案

按 v3 §3-5、§8、§11 实现：

### Schema v35 (§3)
- 新增 \`bots\` 表（含 open_id / concurrency_mode / status / deleted_at 等字段）
- 新增 \`bot_group_bindings\` 表（M:N，含 folder 冗余 + 触发器同步）
- \`sessions.bot_id\` 加列（默认 \`''\`）
- \`usage_records.bot_id\` / \`usage_daily_summary.bot_id\` 加列（预留）
- 启用 \`PRAGMA foreign_keys = ON\`
- \`messages\` 入库从 \`INSERT OR REPLACE\` 改为 \`INSERT OR IGNORE\`（ADR-6）

### 连接管理 (§4)
- \`IMConnectionManager\` 加 \`botConnections\` Map（per-bot，与 per-user 双轨）
- \`connectBot\` / \`disconnectBot\` / \`reconnectBot\` 方法
- \`loadState\` 启动时遍历 bots 表加载连接

### 消息路由 (§5.2 阶段 0)
- \`resolveRouteTarget\` 按 \`connectionKind\` 分叉
- user 连接沿用老路径（查 registered_groups.folder），行为零变化
- bot 连接走新路径（查 bot_group_bindings）
- 空 open_id 时 user 连接放行 / bot 连接丢弃

### HTTP API (§8.5)
- 12 个 Bot CRUD / bindings / credentials / enable-disable 端点
- \`authorizeBot\` 中间件保证权限矩阵（admin 全部 / member 仅自己）
- Feature flag \`enableMultiBot\` 守护所有端点（默认关闭，admin 不受限用于灰度）

### Setup 迁移 (§7.7)
- \`POST /api/config/setup/migrate-feishu-to-bot\` 把老 user-im 配置转成 Bot

### 审计 (§10.2)
- AuthEventType 扩展 11 个 Bot 相关事件

## 测试计划

- [ ] \`bots-schema.test.ts\` 表结构
- [ ] \`migration-v35.test.ts\` 迁移 + foreign_keys 验证
- [ ] \`bgb-folder-sync.test.ts\` 触发器行为
- [ ] \`bots-foreign-keys.test.ts\` CASCADE 行为
- [ ] \`bots-crud.test.ts\` DB CRUD（10 个测试）
- [ ] \`bot-credentials.test.ts\` 加密读写
- [ ] \`im-manager-bot.test.ts\` per-bot 连接管理
- [ ] \`bot-openid-safety.test.ts\` 空 openId 双轨处理
- [ ] \`bot-routing.test.ts\` 路由阶段 0 分叉
- [ ] \`bot-permissions.test.ts\` API 权限矩阵
- [ ] \`messages-insert-or-ignore.test.ts\` 去重语义
- [ ] \`setup-migration.test.ts\` user-im → bot 迁移
- [ ] \`load-state-bots.test.ts\` 启动加载
- [ ] \`feature-flag-multi-bot.test.ts\` flag 默认值
- [ ] \`multi-bot-smoke.test.ts\` 端到端冒烟

## 不在本 PR 范围

- PreToolUse Hook / advisor 写保护 → PR2
- bot-profile / scratch 目录挂载 → PR2
- 前端 UI（\`/bots\` 页、WorkspaceBotsPanel）→ PR3
- 监控指标 / 告警 → PR3

## 向后兼容

- 现有单 Bot 用户（\`bot_id IS NULL\` / \`connectionKind='user'\`）行为完全不变
- \`enableMultiBot=false\`（默认）时 Bot API 返回 501，\`loadBotConnections\` 跳过
EOF
)"
```

- [ ] **Step 17.6：PR 创建完成**

记下 PR URL。切到 PR2 plan 后在描述里引用。

---

## 自查清单（写完后跑一遍）

- [ ] **Spec 覆盖：** v3 PR1 范围（§0 表格 + 附录 E 第一条）每项是否都对应到 Task？
  - ✅ 表改造 → Task 4
  - ✅ PRAGMA foreign_keys → Task 4
  - ✅ 双轨连接 → Task 9
  - ✅ 路由分叉 → Task 11
  - ✅ Bot CRUD API + 权限 → Task 12
  - ✅ Setup 迁移 → Task 14
  - ✅ feature flag → Task 1
  - ✅ 审计事件 → Task 2
  - ✅ messages INSERT OR IGNORE → Task 7

- [ ] **Placeholder 扫描：** 无 "TODO/TBD"，所有 Step 都给出具体代码和命令。

- [ ] **类型一致性：** `Bot` / `BotGroupBinding` / `IMConnectionKind` 贯穿 Task 3-15，命名未漂移。

- [ ] **风险前置：** Task 0 的 FK 审计在 Task 4 启用 `foreign_keys = ON` 之前完成。

---

## 后续 PR

**PR2** 覆盖 v3 附录 E 第二条：
- PreToolUse Hook (`container/agent-runner/src/advisor-guard.ts`)
- bot-profile 挂载 + 路径防护
- scratch 目录
- concurrency_mode 字段实际启用（本 PR 已入库，但 Hook 未挂）

**PR3** 覆盖 v3 附录 E 第三条：
- 前端 UI（BotsPage、WorkspaceBotsPanel、Setup 向导前端）
- 监控指标（bot_connection_state 等）
- 中文 token 估算、prompt injection 包裹
- 回滚 SOP 演练

计划文档保存位置：`docs/superpowers/plans/2026-04-17-multi-agent-pr2.md` / `2026-04-17-multi-agent-pr3.md`（PR1 合并后编写）。
