# Multi-Bot 回滚运行手册

> **适用场景**：`ENABLE_MULTI_BOT=true` 放量后发现严重问题（连接风暴、Hook 误杀、
> 数据异常、审计日志出现大量 `bot_connection_failed`），需要紧急回滚到单 Bot 模式。

---

## 何时需要回滚

触发回滚的典型信号：

| 信号 | 观察位置 | 严重程度 |
|------|---------|---------|
| `bot_connection_failed` 短时间内大量出现 | `GET /api/admin/audit-log?event_type=bot_connection_failed` | 高 |
| `scratch_quota_exceeded` 反复触发 | 审计日志 + `/api/monitor/bot-metrics` | 中 |
| `hook_denies_total` 异常飙升（>100/min） | `GET /api/monitor/bot-metrics` → `hook_denies_total` | 中 |
| `/bots` 页面无法加载或 Bot 连接状态持续 `error` | 浏览器 Network 面板 | 高 |
| 内存或 CPU 异常（连接风暴） | `docker stats` / `make status` | 紧急 |

---

## 1. 即时回滚（目标 < 5 分钟）

### 方式 A：通过系统设置页（推荐，零停机）

1. 以 admin 身份登录 → **系统设置** → **高级** → 找到 `ENABLE_MULTI_BOT`
2. 将开关关闭 → 点击 **保存**
3. 效果立即生效：新的 Bot IM 连接不再建立；现有连接由 `disconnectAll()` 自动断开

**预期输出（浏览器控制台 / 审计日志）：**

```
bot_connection_status: { state: "disconnected", ... }   ← WebSocket 推送
```

### 方式 B：环境变量 + 重启（彻底隔离）

```bash
# 1. 停止服务（前台运行时 Ctrl+C；后台运行时：）
lsof -ti:3000 -sTCP:LISTEN | xargs kill   # 仅杀监听进程

# 2. 修改环境变量（.env 文件或 export）
export ENABLE_MULTI_BOT=false
# 或：在 .env 中设置 ENABLE_MULTI_BOT=false

# 3. 重启服务（保留 data/ 目录）
make start

# 4. 验证服务健康
curl -s http://localhost:3000/api/health | jq
# 期望输出：{ "ok": true, ... }
```

**注意**：`lsof -ti:PORT | xargs kill` 会杀掉所有连接该端口的进程（包括 OrbStack/Docker
网络代理），务必加 `-sTCP:LISTEN` 过滤。

---

## 2. 回滚后状态

### 数据保留情况

| 数据 | 回滚后状态 | 说明 |
|------|-----------|------|
| `bots` 表记录 | **保留** | 数据不删除，可随时重新启用 |
| `bot_group_bindings` 记录 | **保留** | 绑定关系保留，恢复 flag 后自动生效 |
| `data/config/bots/{id}/` | **保留** | 飞书凭证加密文件不删除 |
| `data/bot-profiles/{id}/` | **保留** | Bot 角色 CLAUDE.md 保留 |
| `data/scratch/{folder}/bots/{id}/` | **保留** | scratch 工作区保留（GC 按 30 天策略） |
| Bot IM 连接（WebSocket 长连接） | **断开** | `disconnectAll()` 自动断开所有 Bot 连接 |

### user-im 连接

老 `user-im` 连接（`data/config/user-im/{userId}/feishu.json`）**完全不受影响**：

- 飞书/Telegram/QQ/钉钉 per-user 连接在 `loadState()` 中独立管理
- 回滚不触碰 `data/config/user-im/` 目录
- 如果 user-im 连接在重启前是活跃的，重启后会自动恢复

### `/bots` 页面可见性

| 角色 | ENABLE_MULTI_BOT=false | 说明 |
|------|----------------------|------|
| `admin` | 可见（灰度阶段 1） | 供观察和应急操作 |
| `member` | **不可见**（501） | 对普通用户完全屏蔽 |

---

## 3. 短期修复（2 小时内）

```bash
# 1. 查看最近的 bot 相关审计事件
curl -s -b "session=<token>" \
  'http://localhost:3000/api/admin/audit-log?limit=50' | \
  jq '[.[] | select(.event_type | startswith("bot_"))]'

# 2. 查看当前监控指标
curl -s -b "session=<token>" \
  'http://localhost:3000/api/monitor/bot-metrics' | jq

# 3. 看 hook_denies_total 聚类
curl -s -b "session=<token>" \
  'http://localhost:3000/api/monitor/bot-metrics' | \
  jq '.hook_denies_total | to_entries | sort_by(-.value) | .[0:10]'

# 4. 定位问题日志（按 bot_id 聚类）
grep "bot_id" data/logs/*.log | grep -i "error\|warn" | tail -50
```

修复流程：

1. 定位根因（连接凭证错误 / Hook 配置过严 / scratch 体积超限）
2. 修 patch → `make build`
3. 对单个测试账号打开 flag：`PUT /api/admin/settings` 调整 `enableMultiBot`（admin 专用）
4. 验证无异常后再全量放开

---

## 4. 长期回滚（> 4 小时，不推荐）

> 通常情况下修 patch 比降级 schema 更安全。只有在数据严重损坏时才考虑 schema 降级。

**Schema v36 → v35 降级步骤：**

```bash
# 1. 备份数据
make backup
# 产物：happyclaw-backup-{date}.tar.gz

# 2. 停止服务
lsof -ti:3000 -sTCP:LISTEN | xargs kill

# 3. 手动删除 v36 新增列（SQLite 不支持 DROP COLUMN，需重建表）
sqlite3 data/db/messages.db <<'EOF'
CREATE TABLE bots_v35 AS
  SELECT id, user_id, channel, name, description, role,
         activation_mode, concurrency_mode, open_id, status,
         created_at, updated_at, deleted_at
  FROM bots;
DROP TABLE bots;
ALTER TABLE bots_v35 RENAME TO bots;
PRAGMA user_version = 35;
EOF

# 4. 重启并验证
ENABLE_MULTI_BOT=false make start
curl -s http://localhost:3000/api/health
```

> 降级后如需恢复，直接重启（schema migration 会自动重新追加 v36 列）。

---

## 5. 从回滚恢复

当问题修复后，重新启用 Multi-Bot 功能：

```bash
# 方式 A：系统设置页
# 系统设置 → 高级 → ENABLE_MULTI_BOT → 开启 → 保存

# 方式 B：环境变量
export ENABLE_MULTI_BOT=true
make start
```

**恢复后验证清单：**

```bash
# 1. 全量后端测试
make test
# 期望：全 PASS

# 2. 服务健康检查
curl -s http://localhost:3000/api/health | jq
# 期望：{ "ok": true }

# 3. Bot 连接状态（admin 界面）
# 浏览器 → /bots → 各 Bot 状态应为 connected（若凭证有效）

# 4. 监控指标无异常
curl -s -b "session=<token>" \
  'http://localhost:3000/api/monitor/bot-metrics' | \
  jq '{queue_depth, hook_denies_total}'

# 5. user-im 消息正常到达
# 在飞书/Telegram 发送测试消息，确认 Agent 有回复

# 6. 审计日志无新增 bot_connection_failed
curl -s -b "session=<token>" \
  'http://localhost:3000/api/admin/audit-log?event_type=bot_connection_failed&limit=10' | \
  jq '. | length'
# 期望：0（近期无新增）
```

---

## 6. 快速参考

| 操作 | 命令/路径 |
|------|---------|
| 关闭 Multi-Bot | 系统设置 → 高级 → ENABLE_MULTI_BOT=false |
| 重启服务 | `lsof -ti:3000 -sTCP:LISTEN \| xargs kill && make start` |
| 健康检查 | `curl http://localhost:3000/api/health` |
| 查看监控指标 | `GET /api/monitor/bot-metrics` |
| 查看审计日志 | `GET /api/admin/audit-log?event_type=bot_connection_failed` |
| 备份数据 | `make backup` |
| 恢复备份 | `make restore FILE=happyclaw-backup-{date}.tar.gz` |
| 全量测试 | `make test` |
