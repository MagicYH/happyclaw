# Multi-Agent PR1 外键审计报告

**审计日期：** 2026-04-17
**审计人：** Task 0 subagent（自动生成）
**目标文件：** `src/db.ts`
**关联计划：** `docs/superpowers/plans/2026-04-17-multi-agent-pr1.md`

---

## 1. 审计方法论

1. 运行 `grep -n "FOREIGN KEY\|REFERENCES" src/db.ts` 提取所有 FK 定义。
2. 阅读每个 FK 的父/子表完整定义，确认 ON DELETE 子句。
3. 追踪应用层所有删除父行的函数（`deleteUser`、`deleteChatHistory`、`deleteGroupData`、`deleteTask`、`deleteInviteCode`、`billing_plans` 删除等）验证级联语义是否与代码行为匹配。
4. 分析新增表（`bots`、`bot_group_bindings`）的 FK 预期行为。
5. 给出决策及 Task 4 实施建议。

---

## 2. 现有 FK 清单表

共发现 **7 条** 现存 FK（所有均来自 CREATE TABLE 语句，不含 `ensureColumn`）：

| # | 子表 | FK 列 | 父表 | 父列 | ON DELETE 子句 | 当前（无 PRAGMA）行为 | 启用 `foreign_keys = ON` 后行为 |
|---|------|--------|------|------|--------------|---------------------|--------------------------------|
| 1 | `messages` | `chat_jid` | `chats` | `jid` | 无（默认 NO ACTION） | 孤儿消息可存在 | 删 `chats` 行时若 `messages` 存在子行 → **FAIL（FK 违规）** |
| 2 | `task_run_logs` | `task_id` | `scheduled_tasks` | `id` | 无（默认 NO ACTION） | 孤儿日志可存在 | 删 `scheduled_tasks` 行时若 `task_run_logs` 存在子行 → **FAIL（FK 违规）** |
| 3 | `invite_codes` | `created_by` | `users` | `id` | 无（默认 NO ACTION） | 邀请码可指向已删除用户 | 删用户时若存在邀请码 → **FAIL（FK 违规）** |
| 4 | `user_sessions` | `user_id` | `users` | `id` | ON DELETE CASCADE | 无效（PRAGMA 未开） | 删用户行时自动删除所有 `user_sessions` 子行 ✓ 预期 |
| 5 | `user_subscriptions` | `user_id` | `users` | `id` | 无（默认 NO ACTION） | 孤儿订阅可存在 | 删用户时若订阅存在 → **FAIL（FK 违规）** |
| 6 | `user_subscriptions` | `plan_id` | `billing_plans` | `id` | 无（默认 NO ACTION） | 孤儿订阅可存在 | 删套餐时若订阅存在 → **FAIL（FK 违规）**（但代码已预查询 active 订阅） |
| 7 | `user_balances` | `user_id` | `users` | `id` | 无（默认 NO ACTION） | 孤儿余额可存在 | 删用户时若余额行存在 → **FAIL（FK 违规）** |

> **注意：** `group_members`、`user_pinned_groups`、`agents`、`sessions`、`registered_groups`、`scheduled_tasks`（本身）、`auth_audit_log`、`usage_records`、`usage_daily_summary`、`user_quotas`、`balance_transactions`、`monthly_usage`、`daily_usage`、`redeem_codes`、`redeem_code_usage`、`billing_audit_log` 均无 FOREIGN KEY 声明（纯应用层关联）。

---

## 3. 风险分析（逐条）

### FK-1：`messages.chat_jid` → `chats.jid`（NO ACTION）

- **应用层行为：** `deleteChatHistory()` / `deleteGroupData()` / `deleteMessagesForChatJid()` 均先删 `messages`，再删 `chats`，顺序正确。
- **启用后风险：** 若顺序写错（先删 `chats`）会 FAIL，但当前所有代码路径均先删子行，**顺序安全**。
- **潜在孤儿数据：** 不存在（应用层始终先清 messages）。
- **结论：** 低风险。建议补 `ON DELETE CASCADE` 以防未来代码写错顺序，但也可保持 NO ACTION。

### FK-2：`task_run_logs.task_id` → `scheduled_tasks.id`（NO ACTION）

- **应用层行为：** `deleteTask()` 先删 `task_run_logs`，再删 `scheduled_tasks`；`deleteTasksForGroup()` / `deleteGroupData()` 同样先删日志再删任务，顺序正确。
- **启用后风险：** 顺序安全。若直接 DELETE scheduled_tasks 而未清日志会 FAIL，但现有代码路径均覆盖。
- **结论：** 低风险。建议补 `ON DELETE CASCADE`（日志跟任务走）。

### FK-3：`invite_codes.created_by` → `users.id`（NO ACTION）

- **应用层行为：** `deleteUser()` 只做软删除（`UPDATE users SET status='deleted'`），**不物理删除用户行**，因此 FK-3 在正常运营中不会触发 FAIL。
- **硬删除路径：** 代码中无 `DELETE FROM users WHERE id=?`（仅软删）。
- **潜在孤儿数据：** 不存在（用户行不被物理删除）。
- **结论：** 极低风险。保持 NO ACTION 即可。

### FK-4：`user_sessions.user_id` → `users.id`（ON DELETE CASCADE）

- **当前行为：** `deleteUser()` 已在事务中显式 `DELETE FROM user_sessions WHERE user_id = ?`，然后软删用户；`deleteUserSessionsByUserId()` 亦单独清理。
- **启用后行为：** CASCADE 会在物理删用户时自动删会话。由于当前代码走软删，CASCADE 实际上不会被触发，但作为兜底是正确语义。
- **结论：** 无风险，语义正确。✓ 预期行为。

### FK-5：`user_subscriptions.user_id` → `users.id`（NO ACTION）

- **应用层行为：** 代码无物理删用户行逻辑（软删）。订阅删除无专用函数，仅查询。
- **潜在孤儿数据：** 用户软删后订阅行仍存在，属于预期（订阅记录保留用于审计）。
- **启用后风险：** 因用户不物理删除，FK-5 不会在正常路径触发 FAIL。
- **结论：** 低风险。可保持 NO ACTION。

### FK-6：`user_subscriptions.plan_id` → `billing_plans.id`（NO ACTION）

- **应用层行为：** `deleteBillingPlan()` 已检查 active 订阅数，有订阅则拒绝删除（`return false`）。
- **启用后风险：** 应用层已保护，但非 active 订阅的历史记录仍可能存在。若强制删套餐而这些历史记录存在，会 FAIL。
- **结论：** 低风险（应用层有保护）。建议保持 NO ACTION 或改为 `ON DELETE RESTRICT` 语义一致。

### FK-7：`user_balances.user_id` → `users.id`（NO ACTION）

- **应用层行为：** 无物理删用户，余额行会随用户软删保留（用于审计）。
- **启用后风险：** 无（用户不物理删除）。
- **结论：** 极低风险。保持 NO ACTION 即可。

---

## 4. 本 PR 新增 FK 预期行为

### 4.1 `bots.user_id` → `users.id` ON DELETE CASCADE

| 场景 | 行为 |
|------|------|
| 物理删除 `users` 行 | 自动删除该用户所有 bot 行（含软删的）。**但当前代码走软删，此 CASCADE 不会在正常路径触发。** |
| 软删用户（status='deleted'） | 不触发 CASCADE，bot 行保留 |
| 合理性 | 如果未来引入物理清理脚本，CASCADE 确保 bot 不留孤儿数据。语义正确。 |

**结论：** 语义合理，与 `user_sessions` 的 CASCADE 策略一致。✓

### 4.2 `bot_group_bindings.bot_id` → `bots.id` ON DELETE CASCADE

| 场景 | 行为 |
|------|------|
| 删除 bot 行（硬删或通过 CASCADE 从 users） | 自动删除该 bot 的所有 group bindings |
| 合理性 | Bot 不存在则绑定无意义，级联删除正确。 |

**结论：** 语义正确，无风险。✓

### 4.3 `bot_group_bindings.group_jid` → `registered_groups.jid` ON DELETE CASCADE

| 场景 | 行为 |
|------|------|
| 调用 `deleteGroupData(jid, folder)` 删除群组 | 删除 `registered_groups WHERE jid=?`，CASCADE 自动删除该群组的所有 `bot_group_bindings` |
| 合理性 | 群组注销后绑定应一起清理，符合预期。 |
| 当前应用层 `deleteGroupData` | 已手工删 agents / sessions / messages 等，新增 bindings 的清理由 CASCADE 自动处理，**可以省略手工清理代码**。 |

**结论：** 语义正确，且能简化 `deleteGroupData` 代码（无需再手工 DELETE bot_group_bindings）。✓

---

## 5. 最终决策

### 决策：**B — 部分调整后启用 `foreign_keys = ON`**

**核心理由：**

1. FK-1（messages → chats）、FK-2（task_run_logs → scheduled_tasks）当前为 NO ACTION，启用后若代码删除顺序出错会报 FK 违规。虽然现有代码路径顺序正确，但**缺乏数据库层兜底保护**，属于脆弱设计。
2. FK-3、FK-5、FK-7 均依赖"用户不物理删除"假设，短期安全，但长期（如引入 GDPR 清理脚本）会产生 FK 违规。
3. FK-6 已有应用层保护，但仍有历史非 active 订阅孤儿风险。
4. **方案 A（全部 CASCADE）** 不适合，因为 `invite_codes`、`user_subscriptions`、`user_balances` 需要保留用于审计，即使用户"删除"后也不应物理清除。
5. **方案 C（不启用）** 放弃 DB 层防护，不推荐。

**具体调整（在 Task 4 migration 中执行）：**

| FK | 推荐操作 |
|----|----------|
| FK-1 messages → chats | 改为 `ON DELETE CASCADE`（消息跟聊天室走，语义明确） |
| FK-2 task_run_logs → scheduled_tasks | 改为 `ON DELETE CASCADE`（日志跟任务走，语义明确） |
| FK-3 invite_codes.created_by → users | 保持 NO ACTION（审计字段，允许指向已软删用户） |
| FK-4 user_sessions → users CASCADE | 保持 CASCADE（现有正确设计，维持不变） |
| FK-5 user_subscriptions.user_id → users | 改为 `ON DELETE SET NULL` 或保持 NO ACTION（订阅记录需留存，建议 NO ACTION + 注释） |
| FK-6 user_subscriptions.plan_id → billing_plans | 保持 NO ACTION（应用层已有保护） |
| FK-7 user_balances → users | 保持 NO ACTION（余额行用于审计保留） |

> 对于 FK-5 / FK-7：由于用户从不物理删除，NO ACTION 实际安全。若未来要引入 GDPR 硬删除，应在该时候专项评估。

---

## 6. 给 Task 4 的实施建议

### 6.1 是否启用 PRAGMA

**是，在 migration v35 中启用：**

```typescript
db.exec('PRAGMA foreign_keys = ON');
```

放在所有 DDL（`CREATE TABLE IF NOT EXISTS bots` 等）之前。

> 重要：`PRAGMA foreign_keys` 是 per-connection 设置。必须在 `initDb()` 每次建立连接时都执行，不能只在 migration 里执行一次。建议在 `initDb()` 最顶部（WAL 设置之后）固定加入，使其对所有连接生效。

### 6.2 需要 ALTER 的 FK（无法直接 ALTER，需表重建）

SQLite 不支持 `ALTER TABLE ... ADD FOREIGN KEY`，只能通过**表重建**修改约束。

**需重建的表（如选择 B 方案修改 FK-1、FK-2）：**

#### messages 表（FK-1 → ON DELETE CASCADE）

```sql
-- 在 migration v35 事务中执行
CREATE TABLE messages_new (
  id TEXT,
  chat_jid TEXT,
  ...所有现有列...,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE  -- 关键修改
);
INSERT INTO messages_new SELECT * FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
-- 重建 index
CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);
```

#### task_run_logs 表（FK-2 → ON DELETE CASCADE）

```sql
CREATE TABLE task_run_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE  -- 关键修改
);
INSERT INTO task_run_logs_new SELECT * FROM task_run_logs;
DROP TABLE task_run_logs;
ALTER TABLE task_run_logs_new RENAME TO task_run_logs;
CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
```

> **注意：** 表重建必须包裹在 `db.transaction()` 中。重建期间 `foreign_keys` 应在 `PRAGMA foreign_keys = OFF` 状态下执行 DDL（SQLite 官方建议），完成后再开启。

### 6.3 `initDb()` 固定语句顺序

```typescript
export function initDb(dbPath: string): void {
  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');  // ← 新增，必须在每次连接时执行
  // ... 其余 CREATE TABLE IF NOT EXISTS ...
}
```

### 6.4 `deleteGroupData` 可简化

启用 `bot_group_bindings.group_jid` CASCADE 后，`deleteGroupData()` 无需手工删 `bot_group_bindings`（CASCADE 自动处理）。建议在 Task 4 完成后检查并更新注释。

### 6.5 数据清洗（启用前执行）

在启用 `foreign_keys = ON` 之前，应先检查是否存在孤儿数据（启用后孤儿数据不能被查询删除）：

```sql
-- 检查孤儿 messages（chat_jid 不在 chats 中）
SELECT COUNT(*) FROM messages WHERE chat_jid NOT IN (SELECT jid FROM chats);

-- 检查孤儿 task_run_logs
SELECT COUNT(*) FROM task_run_logs WHERE task_id NOT IN (SELECT id FROM scheduled_tasks);

-- 检查孤儿 user_sessions（理论上不存在，但确认）
SELECT COUNT(*) FROM user_sessions WHERE user_id NOT IN (SELECT id FROM users);
```

若有孤儿数据，先清理再启用 PRAGMA。

---

## 附录：审计命令记录

```bash
# 执行命令
grep -n "FOREIGN KEY\|REFERENCES" src/db.ts

# 输出（7 条 FK）
249:      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
283:      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
361:      FOREIGN KEY (created_by) REFERENCES users(id)
372:      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
486:      FOREIGN KEY (user_id) REFERENCES users(id),
487:      FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
498:      FOREIGN KEY (user_id) REFERENCES users(id)
```
