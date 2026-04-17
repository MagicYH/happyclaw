# Multi-Agent v2 设计 Review 报告

**日期**：2026-04-17
**Reviewer**：Opus 4.7（资深软件架构师视角）
**基线文档**：`2026-04-17-multi-agent-design-v2.md`

---

## 执行摘要

v2 设计在修复 v1 P0/P1 问题上整体到位，schema 方案（独立 `bot_group_bindings` 表而非改 `registered_groups` PK）、session 目录嵌套、token 预算制注入、`botOpenId` 双轨处理都是正确决策。但 v2 新增的 **writer/advisor 并发模型** 带来了一组未被完整推演的边界问题：advisor 的 PreToolUse Hook 机制在 Claude Agent SDK 中的 API 正确性未经查证、advisor 对"当前 writer 是否在跑"缺乏同步信号导致可能做出错位 review、scratch 目录生命周期策略缺失、`bot_group_bindings.folder` 冗余缓存的一致性机制仅仅"提到应用层级联"但没落笔。此外，**Bot 权限模型（admin vs member）、软删除、审计日志、测试连接语义**等遗漏点需要补充。**结论：不建议立刻进入实现阶段，建议拆分为 3 个 PR 渐进落地（PR1 只做 writer 多 Bot，PR2 再上 advisor，PR3 处理边角）**，同时要求文档再补一轮（v3）澄清 §B/§D/§F 的剩余空白。

---

## A. v1 问题修复情况核查

逐项核对 v1 review 指出的 13 项问题在 v2 中的修复状态。

| # | 问题 | v2 修复 | 核查结论 |
|---|------|---------|---------|
| 1 | Schema 版本号 v24→v25 错误 | v34→v35 | **OK**。当前线上 `src/db.ts` 确实是 v24（见 CLAUDE.md 表述"v1→v24"），v2 声明 v34 比 CLAUDE.md 陈述领先 10 个版本，**存在版本号基线偏差**，应与 `src/db.ts:SCHEMA_VERSION` 实际值核对一次。若实际为 v24，应改为 v24→v25；若确实已跳到 v34，CLAUDE.md 需同步更新。**⚠️ P1 — 需核验线上值** |
| 2 | `registered_groups.jid` PK 改动面太大 | 保留 PK，新增 `bot_group_bindings` 独立表 | **OK**。设计正确，符合代码考古文档第 6 节的推荐路径 |
| 3 | Bot 与 `agents` 表关系语焉不详 | §2.4 明确不复用 | **OK**。表格论证充分，同时复用 `sessions` 表通过 `bot_id` 列隔离的决策合理 |
| 4 | 活性门控自己写判断 | 复用 `activation_mode='when_mentioned'` | **OK**。但 §5.2 的阶段 3 与阶段 2 逻辑有轻微重叠（"when_mentioned 阶段 2 已检查，通过"），实际实现需要注意避免二次短路 |
| 5 | `source_message_id` 冗余 | 移除，靠 `(id, chat_jid)` PK | **OK**。但 §3.6 说"若现状是 INSERT，需改为 INSERT OR IGNORE"——需明确现有代码确实是 `INSERT OR REPLACE` 或 `INSERT`？改 `OR IGNORE` 对现有非多 Bot 场景有无副作用（例如旧代码依赖 REPLACE 刷新字段）？**需要代码层核查** |
| 6 | Session 目录 `{folder}_{botId}` 冲突 | 改为嵌套 `{folder}/bots/{botId}` | **OK** |
| 7 | `botOpenId` 空值默认放行 | 按 connectionKind 分支，bot 连接空值丢弃 | **OK**，但 §5.4 示例代码中 `shouldProcessGroupMessage` 的返回值用法与 CLAUDE.md 描述略有出入（CLAUDE.md 示例显示返回 false 表示"必须 @bot 但未 @"，而 §5.4 代码把 `=== false` 当作"丢弃"）——**实现时需仔细核对原函数返回语义** |
| 8 | CLAUDE.md 写 `~/.claude/` 会被 SDK 覆盖 | 独立挂载 `/workspace/bot-profile` + `customSystemPrompt` | **OK**，设计优雅。但需要验证 Claude Agent SDK 当前版本的 `customSystemPrompt` API 是否稳定（作为 SDK 正式 API 而非内部）。查 `@anthropic-ai/claude-agent-sdk` 类型定义即可 |
| 9 | 固定 N=20 条上下文 | Token 预算制（8K 默认），`stripBase64Attachments` | **OK**，`estimateTokens` 用 4 字符=1 token 近似对中文不准（中文约 1-2 字符=1 token），在中文高密度群聊里预估会偏低，可能把超长消息塞进 prompt。建议改为 `length / 2.5` 或接入 SDK 的实际 tokenizer |
| 10 | IPC 目录 per-bot 切分 | `data/ipc/{folder}/bots/{botId}/` | **OK** |
| 11 | 容器日志目录切分 | `data/groups/{folder}/logs/bots/{botId}/` | **OK**，但注意 `logs/` 是 `file-manager.ts` 的系统保护路径，嵌套 `logs/bots/{botId}/` 是否仍被保护需确认 `src/file-manager.ts` 的前缀匹配逻辑 |
| 12 | 用量统计归属 | `usage_records.bot_id` 可空列 | **OK**，但 `usage_daily_summary` 不加 bot 维度导致前端"按 Bot 聚合用量"无法低成本实现，以后做迁移时又要一次重建。建议至少在表结构里预留 bot 维度的填充位（即使本期前端不暴露） |
| 13 | 并发模式 | writer/advisor 分级 | **新增功能，风险在 §B 详述** |

### A.总结

13 项中有 11 项修复彻底；#1 存在版本号基线偏差（需对齐真实 `SCHEMA_VERSION`），#9 的 token 估算对中文不准，#5/#7/#11 需要配合源码核验；#13 是新引入的复杂机制，见 §B。

---

## B. writer/advisor 并发模型深度检查

### B.1 `serializationKeyResolver` 改造是否破坏现有单 Bot 路径？

**设计声称**：旧路径（`bot_id=''`）默认视为 writer，语义不变（§5.6）。

**核查**：
- 现有 `group-queue.ts` 的 key 目前是什么？文档没有列出当前实现，v2 只说"改造"但没给出 diff。根据 CLAUDE.md §8.7 描述"最多 20 个并发容器"+"任务优先于消息"，现有 key 大概率就是 folder 本身。
- 若当前 key = `folder`，v2 把 writer 的 key 改为 `folder:{folder}`（加前缀），虽然逻辑上等价但属于**字符串层面的改动**，意味着：
  1. 如果队列里已经有 in-flight 任务持有旧 key `folder=project-alpha`，升级瞬间新请求用 `folder:project-alpha`，两者不互斥 → 升级窗口期可能出现并发写入
  2. 现有持久化/重启恢复队列（如果有）需要考虑 key 格式变更
- 建议：保持老 key 名不变，只在 advisor 分支用新前缀。即：writer → `folder`（老值），advisor → `folder-advisor:{folder}:{botId}`

**结论**：**⚠️ P1** — 建议改为"writer 保持原 key 不变，advisor 用新 key"，避免升级期间窗口并发。文档需明确给出 resolver 的 before/after 代码。

### B.2 Claude Agent SDK 的 PreToolUse Hook 确实存在吗？

v2 §5.6.2 声称"改用 Claude Agent SDK 的 **PreToolUse Hook**（基础设施已存在，现有 PreCompact Hook 可参考）"。

**核查**：
- CLAUDE.md §2.3 确实提到 "Hooks：PreCompact 钩子在上下文压缩前归档对话到 `conversations/` 目录"
- 但 **PreCompact ≠ PreToolUse**。PreCompact 是压缩前 hook（生命周期事件），PreToolUse 是工具调用拦截 hook（能取消/修改调用）。
- 查 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）公开 API：SDK 支持 `canUseTool` 回调（可以在工具执行前否决），以及 `hooks` 配置（`PreToolUse`、`PostToolUse`、`Stop` 等），**但 `hooks` API 的稳定性和具体签名因版本而异**。
- v2 没有给出具体 API 名称、导入路径、类型签名。这是**重大空白**：如果 SDK 版本升级改了 API，整个 advisor 宿主机模式失效。
- 此外，Hook 层只能拦截 SDK 发起的 tool call；agent-runner 通过 `Bash` 启动的 subprocess（如 `python script.py` 内部再写文件）、或 MCP server 内部调用（mcp-tools 的 12 个工具也可能写盘），不一定被 `PreToolUse` hook 覆盖。

**结论**：**🔴 P0** — 必须在文档中落笔：
1. 准确的 SDK API 名称（是 `hooks.PreToolUse` 还是 `canUseTool` 还是自定义 callback？）
2. Hook 能否拦截嵌套 subprocess（例如 `Bash` 调 `python` 再写文件）
3. MCP 工具（如 `memory_append`）是否走 Hook，是否需要独立 guard
4. 如果 SDK 不提供 `PreToolUse`，fallback 方案是什么（prompt-only？chroot？）

### B.3 Scratch 目录命名/清理约定

v2 §7.4 把 scratch 放在 `data/scratch/{folder}/bots/{botId}/`，与 `data/groups/`、`data/sessions/`、`data/ipc/` 并列。

**核查**：
- 命名规范：`data/scratch/` 是新顶层目录，CLAUDE.md §6 目录约定表里**没有**这一项。文档需同步更新 CLAUDE.md。
- 备份：`make backup` 通过 tar 打包 `data/`，新目录会自动包含，**OK**。
- 清理：v2 说"不自动清理，通过 UI 手动清；监控 scratch 总体积避免失控"——但：
  1. UI 入口在哪？没有写进 §8
  2. "监控总体积"由谁监控？无触发机制
  3. 删除 Bot 时（§4.3）没说清 scratch 目录如何处理（留着？删？异步清？）
  4. 群组被反绑定时（`DELETE /api/bots/:id/bindings/:jid`），scratch 归属谁？如果 Bot 被删但 folder 还在，该 bot 的 scratch 悬空
- 生命周期：`mkdirSync recursive` 在 `container-runner.ts` 启动前——这是**每次启动**都检查，如果中途权限问题（例如 `data/scratch/` 属主变更），启动会反复失败

**结论**：**⚠️ P1** — Scratch 目录生命周期管理（创建/清理/级联删除）需要独立一节。建议：
- Bot 删除时级联删 scratch（类似 session 目录）
- 反绑定（unbind）时保留（可能再绑回来）
- 定期（如 30 天未访问）自动清理 + UI 手动清

### B.4 advisor 启动时的挂载顺序竞态

流程：mkdir scratch → 挂载容器 → 启动 agent。

**核查**：
- 容器模式（Docker）：`docker run -v host:/container` 在容器启动前挂载，若 host 目录不存在，Docker 会自动创建（以 root 属主）——然后容器内以 `node` 用户写入会 EACCES。必须先 mkdir 再 run。
- 宿主机模式：无挂载概念，直接操作 host 路径，需要 agent-runner 进程启动前存在。
- v2 说"`container-runner.ts` 启动前 `mkdirSync({ recursive: true })`"——**OK**，但需要注意：
  1. `mkdirSync` 要设置正确的属主/权限（例如 Docker 场景下属主需匹配容器内 UID）
  2. 多个 advisor 并发启动（§5.6 并行执行）会同时 mkdir 同一路径，`recursive: true` 是幂等的但仍有 race（若一个进程 mkdir 成功另一个刚进行 check）——`recursive: true` 实际已处理这种 race（返回 undefined 不报错），**OK**
- 但**另一种 race**：advisor Bot A 启动时正在 mkdir，writer Bot B 同时启动也要 mkdir 自己的 scratch，两者路径不同，无冲突。**OK**

**结论**：无 race，但 **⚠️ P2** — 应在文档里说明 `mkdirSync` 的权限模式（特别是容器模式下如何避免 root 属主导致的 EACCES）。

### B.5 `HAPPYCLAW_BOT_MODE=advisor` 时 bot-profile CLAUDE.md 模板

v2 §6.1 的默认模板是通用版本，不区分 writer/advisor。

**核查**：
- advisor 用户可能会自己写"请帮我修改登录页" prompt，但 advisor 模式下 Write/Edit 会被 Hook 拦截——agent 会卡住或返回错误。
- 默认模板应该在 advisor 模式下**额外**加一段："你是以只读模式运行的 advisor，项目目录禁止修改；如需提交分析结果，请写入 `/workspace/scratch/`。"
- 此外 advisor 的"协作准则"应明确：不直接修改代码，输出 review 笔记和建议

**结论**：**⚠️ P1** — 建议 v2 增加"advisor 默认 CLAUDE.md 模板"作为独立模板，创建 Bot 时根据 `concurrency_mode` 选用不同模板。

### B.6 `:ro` 挂载对隐式写入的影响

Claude Agent SDK 在 cwd 下可能有隐式写入：
- `.claude/todos.json`（会话 todo）——但 CLAUDE.md §2.3 说 `~/.claude` 是 session 目录，应该在 `/home/node/.claude`，而 cwd 是 `/workspace/group`，分离 **OK**
- `.claude/settings.json`——同上
- 但 SDK 会不会在 cwd 下创建临时文件？例如 autorun 时生成的诊断日志、test cache？这需要实测

**已知 Claude SDK 行为**：
- 现有 CLAUDE.md §2.3 说 "PreCompact 钩子在上下文压缩前归档对话到 `conversations/` 目录"——`conversations/` 是 cwd/project 下的子目录，**会写入 cwd！**
- 如果 advisor 模式下 cwd=`/workspace/group` 且 `:ro`，PreCompact 尝试写 `conversations/` 会 EROFS，agent 崩溃

**结论**：**🔴 P0** — 这是实现级必须解决的问题：
- 要么 advisor 模式下不启用 PreCompact hook
- 要么把 `conversations/` 重定向到 scratch
- 要么把 cwd 设为别的目录（但 SDK 自动发现 CLAUDE.md 依赖 cwd）

v2 没有意识到这一点，必须在实现前解决。

### B 总结

writer/advisor 并发是 v2 最大的新增，也是**风险最集中的区域**。PreToolUse Hook API 的真实性（B.2）和 `:ro` 挂载对 PreCompact 等隐式写入的影响（B.6）是**必须在实现前做 PoC 验证**的 P0 项目。

---

## C. 数据一致性与迁移风险

### C.1 `bots.open_id` 回填时机

**场景**：
1. 用户创建 Bot（POST /api/bots）→ 写 DB，此时 `open_id=NULL`
2. 用户启用 Bot（PUT /api/bots/:id → active）→ 建立 WebSocket → 成功后回填 `open_id`
3. 用户在回填完成前就把 Bot 拉入群（飞书推送到 Bot 的 WebSocket）

**问题**：
- §5.2 阶段 2 要求 `botOpenId` 空时 bot 连接直接丢弃消息 + 日志
- 这是正确的，但如果用户在创建 Bot 后立即拉入群，**第一批 @消息会被全部丢弃**——用户体验差
- 更糟：`onBotAddedToGroup` 回调（§5.5）可能在 open_id 回填之前触发，导致 binding 创建但消息响应延迟

**补救**：
1. 建立连接 + 拿到 open_id 后再**订阅消息**（推迟订阅而不是立即订阅）
2. 或者在 open_id 拿到后 **补发一次消息拉取**（catch-up），类似 `ignoreMessagesBefore` 的反向用法

**结论**：**⚠️ P1** — 需要在 §4.2 明确"订阅消息在 open_id 回填之后"，避免启动瞬间消息丢失。

### C.2 `bot_group_bindings.folder` 冗余缓存一致性

v2 §3.3 设计理由 3 说："一致性靠应用层：`registered_groups.folder` 改动时级联更新所有 `bot_group_bindings.folder`"——但**没有说在哪里级联**。

**核查**：
- `registered_groups.folder` 通过什么 API 改动？查 CLAUDE.md §7 表，`/api/groups` CRUD 是入口
- 每个修改 `folder` 的地方都要手动加一行 `UPDATE bot_group_bindings SET folder=? WHERE group_jid=?`——容易遗漏
- 更严重：如果通过 `init_source_path`、`init_git_url` 间接改 folder 路径，级联能否覆盖？

**建议**：
1. 用 SQLite trigger 自动同步（推荐）：
   ```sql
   CREATE TRIGGER sync_bgb_folder AFTER UPDATE OF folder ON registered_groups
   BEGIN
     UPDATE bot_group_bindings SET folder = NEW.folder WHERE group_jid = NEW.jid;
   END;
   ```
2. 或者改冗余为 JOIN 查询，牺牲一点性能换一致性
3. 或者在 `db.ts` 封装 `updateRegisteredGroupFolder()` 函数，内部两表同时更新

**结论**：**⚠️ P1** — 必须落实级联机制，推荐用 trigger。v2 仅"提到应用层级联"不足够。

### C.3 多 Bot 拉入同群的 binding 写入竞态

**场景**：
1. 用户在飞书群里 @了新加入的 Bot A 和 Bot B
2. Bot A 和 Bot B 的 WebSocket 几乎同时收到"我被加入群"事件
3. 两个回调并发执行 `onBotAddedToGroup`，尝试写 `bot_group_bindings`

**核查**：
- v2 §5.5 用 `INSERT OR IGNORE INTO bot_group_bindings`，PK `(bot_id, group_jid)` 保证幂等
- **但** `registered_groups` 那一步："若不存在，用默认模板创建"——两个回调都可能尝试创建 registered_groups 记录
- `registered_groups` 的 INSERT 如果没用 `OR IGNORE`，第二次 INSERT 会 PK 冲突报错

**结论**：**⚠️ P1** — §5.5 必须明确：`INSERT OR IGNORE INTO registered_groups` + `INSERT OR IGNORE INTO bot_group_bindings` 两步都要 IGNORE。

### C.4 Bot 删除时 session/scratch 不自动清

**场景**：用户删 Bot（§4.3）→ ON DELETE CASCADE 删 `bot_group_bindings` + `sessions`（如果有 FK）——但 v2 §3.4 的 `sessions` 表**没有**对 `bots(id)` 的外键约束。

**核查**：
- §3.4 Migration SQL 只有 `PRIMARY KEY (group_folder, bot_id, agent_id)`，没 FOREIGN KEY
- 所以 Bot 删除不会级联清 `sessions` 行
- 物理文件 `data/sessions/{folder}/bots/{botId}/`、`data/scratch/{folder}/bots/{botId}/`、`data/ipc/{folder}/bots/{botId}/`、`data/groups/{folder}/logs/bots/{botId}/`、`data/groups/{folder}/bots/{botId}/`（bot-profile）都不会自动清
- `config/bots/{botId}/feishu.json` 在 §4.3 说"删凭证文件"，**OK**

**结论**：**⚠️ P1** — §4.3 需补齐 Bot 删除时的清理清单：
1. DB: DELETE FROM sessions WHERE bot_id=?（因为没 FK）
2. DB: DELETE FROM bot_group_bindings WHERE bot_id=?（FK CASCADE 自动）
3. 文件: config/bots/{botId}/、每个 folder 下的 sessions/bots/{botId}/、scratch/bots/{botId}/、ipc/bots/{botId}/、logs/bots/{botId}/、bots/{botId}/ — 全部 rm -rf

### C.5 向后兼容：现有 user-im 用户的 binding 懒生成

v2 §9 说"现有单 Bot 用户走 userConnections，`bot_id=''` 路径"。

**核查**：
- 单 Bot 用户的 registered_groups 记录没有对应的 `bot_group_bindings` 行（因为没有 Bot 概念）
- §5.2 阶段 4 要求 `SELECT folder FROM bot_group_bindings WHERE bot_id=X.id AND group_jid=chatJid`——这是**多 Bot 连接**路径
- 单 Bot 连接（`connectionKind='user'`）走老的 `registered_groups` 查询，**不经过** `bot_group_bindings`？

**问题**：v2 没有明确写出单 Bot 连接的路由路径。§5.2 的流程图**隐含**地假设了所有消息都走新路径。如果不区分 connectionKind，单 Bot 用户会被迫创建 `bot_group_bindings` 记录（空 bot_id）——但 `bots.id` 是 PK，没有 `bot_id=''` 的 Bot 记录，FK 约束会失败。

**结论**：**🔴 P0** — §5.2 必须明确两条路径：
- `connectionKind='user'`（老路径）：查 `registered_groups.folder`，不碰 `bot_group_bindings`
- `connectionKind='bot'`（新路径）：先查 `bot_group_bindings`，取出 folder

这个分叉在文档中完全没体现，实现时极易出错。

---

## D. 消息路由竞态

### D.1 多 @mention 的 reaction 时序错位

**场景**：消息 `@A @B`，两连接并发处理：
- A 连接：INSERT OR IGNORE 成功（首次）→ addReaction('OnIt') → enqueue
- B 连接：INSERT OR IGNORE 冲突（跳过实际写入）→ addReaction('OnIt') → enqueue

**问题**：
- reaction 是 per-connection 独立发送的飞书 API 调用，顺序不定
- A 的 reaction 可能比 B 晚到飞书服务端
- 用户界面看到先 B 后 A 的 OnIt，或者同时显示两个——功能上无影响，但时序上不是"A 先于 B"

**现实影响**：
- 飞书 reaction 是 set 语义（同一 emoji 去重），两个 Bot 各自发 `OnIt` 实际只显示一次（按 Bot 身份区分则显示两次）
- 不会引起用户困惑，**实际可忽略**

**结论**：**LOW** — 时序不齐是现实，但用户感知影响小。可接受。

### D.2 advisor 读到的上下文可能与"当前 writer 正在做的事"错位

**场景**：
- t=0：用户 @Writer A "重构 login 模块"
- t=1：A 开始跑（进入 folder 串行队列）
- t=2：用户 @Advisor B "review 一下 login 代码"
- t=3：B 立即并发启动（§5.6 advisor 不阻塞）
- t=4：B 读取群聊历史，只看到"A 开始跑"但还没看到 A 的输出；读取文件系统，看到的是 A 刚开始修改前的状态
- t=5：B 基于 t=4 的状态给出 review，但此时 A 已经改了代码
- t=6：用户看到 B 的 review 和 A 的新代码，B 的 review 是过时的

**问题**：
- advisor 拿到的是**瞬时快照**，不知道 writer 正在写
- Token 预算制上下文注入（§6.3）不含"当前有哪些 writer 在运行"的信号
- B 可能会说"我建议把 X 改成 Y"，但 A 已经把 X 改成 Z 了

**这个问题 v2 完全没提**。

**补救方案**：
1. 给 advisor 注入"当前正在运行的 agents"信号（查 queue 状态）
2. advisor 的 system prompt 明确："你看到的文件状态可能正在被其他 agent 修改，review 时要基于 git HEAD 或用户明确指定的版本"
3. 让 advisor 自己检查 `git status` 发现变动
4. **最根本的解决**：advisor 不独立并发，而是等待当前 writer 完成（但这就退化成了串行）

**结论**：**🔴 P0** — 这是 advisor 并发模型的**核心语义缺陷**。建议在 v3 中：
- 要么明确"advisor 是尽力而为的异步 review，可能看到过时状态"，并在 UI 中标注
- 要么改为"advisor 队列化但与 writer 不互斥"+"启动时 snapshot 当前文件状态到 scratch"

### D.3 @writer + @advisor 同一条消息的时序错位

**场景**：一条消息 `@A(writer) @B(advisor) 讨论登录页方案`
- A 入 folder 串行队列
- B 入 advisor 队列，立即并行启动
- B 启动时，A 还没开始（队列里排着），B 读群聊历史没有 A 的输出
- B 给出建议：`"建议先做登录页再做注册页"`
- A 启动，读群聊历史看到 B 的建议，实现它

**这个场景其实 OK**，但反过来：
- `@A @B 同时做 login 重构和 review`
- B 先跑，review 了旧代码
- A 跑完输出新代码
- 用户看到 B 的 review 对 A 无用

**结论**：同 D.2，需要明确 advisor 的语义边界。

---

## E. 实现复杂度与 PR 拆分建议

### E.1 额外实现成本估算（人天）

| 模块 | v1 估算 | v2 额外成本 |
|------|---------|------------|
| Schema migration + DB 层 CRUD | 2d | +0.5d（bots/bindings/usage_records） |
| IMConnectionManager 双轨 + BotConnection | 3d | +0.5d（open_id 回填、connectionKind 分支） |
| 消息路由（activation_mode 复用） | 2d | +0.5d（COALESCE 三层继承、阶段 2/3 分离） |
| Session 目录 / IPC / logs 切分 | 1d | +0.5d（file-manager 保护路径确认） |
| CLAUDE.md 双层加载 + customSystemPrompt | 2d | +1d（SDK API 验证 + bot-profile 挂载） |
| Token 预算上下文注入 | 1d | +0.5d（中文 tokenizer 选型） |
| UI (BotsPage、WorkspaceBotsPanel、Setup) | 4d | +1d（concurrency_mode 编辑、role 模板选择） |
| **writer/advisor 并发（新增）** | — | **+5d**（队列 resolver、scratch 目录、PreToolUse Hook、advisor-guard.ts、:ro 挂载、PreCompact 冲突） |
| 测试（新增 8 个 test file） | 2d | +2d（concurrency-mode、advisor-guard、hook mock） |
| PoC：SDK hooks API 验证 | — | +1d |
| PoC：`:ro` 挂载 + PreCompact 兼容性 | — | +1d |
| 文档 / 迁移脚本 | 1d | +0.5d |
| **合计** | **约 18d** | **约 31d**（多 13d） |

v2 相对 v1 额外 ~13 人天，主要来自 advisor 并发机制的引入。

### E.2 最容易出错的部分

按风险排序：

1. **advisor 宿主机模式的 PreToolUse Hook**（B.2） — SDK API 可能不存在或签名不稳定；覆盖不全（subprocess）
2. **`:ro` 挂载与 PreCompact 的冲突**（B.6） — 未验证，可能导致 advisor 崩溃
3. **advisor 的上下文错位**（D.2） — 语义缺陷，无法通过编码简单解决
4. **`bot_group_bindings.folder` 级联**（C.2） — 应用层维护容易遗漏，推荐 trigger
5. **单 Bot 老路径与新路径分叉**（C.5） — 文档不清晰，代码容易写错
6. **open_id 回填时机 race**（C.1） — 启动瞬间消息丢失
7. **Token 估算对中文不准**（A#9） — 上下文过量风险
8. **session/scratch 级联清理**（C.4） — 长期运行磁盘膨胀

### E.3 PR 拆分建议（强烈推荐）

**PR 1：多 Bot 基础（只含 writer）** — 约 12-15 人天
- Schema v35：bots、bot_group_bindings、sessions 加 bot_id 列、usage_records 加 bot_id
- IMConnectionManager 双轨
- 消息路由新增 connectionKind 分支
- CLAUDE.md 双层加载（bot-profile 挂载）
- Session / IPC / logs per-bot 切分
- UI：BotsPage、WorkspaceBotsPanel、Setup 调整
- 测试：bots-schema、bot-routing、bot-openid-safety、bot-session-isolation、bot-ipc-isolation
- **暂不引入 concurrency_mode**：写死为 writer，所有 Bot folder 级串行
- **价值**：跑通多 Bot 协作主路径，v1 目标达成

**PR 2：writer/advisor 并发模型** — 约 10 人天
- bots/bindings 加 concurrency_mode 列（v35 即加入，但 PR 1 不消费）
- group-queue.ts serializationKeyResolver 分支
- scratch 目录 + 挂载
- 容器模式 :ro 挂载
- 宿主机模式 PreToolUse Hook（advisor-guard.ts）— **需要先做 PoC**
- 默认 CLAUDE.md 模板区分 writer/advisor
- 测试：concurrency-mode、advisor-guard
- **前置条件**：PoC 验证 SDK hooks API 和 :ro 挂载兼容性

**PR 3：边角清理和遗漏点** — 约 5 人天
- Bot 软删除
- 测试连接 API
- 审计日志接入
- scratch 自动清理（定期任务）
- `bot_group_bindings.folder` trigger
- 权限模型：admin vs member 的跨用户管理
- 凭证泄露场景文档

**拆分的好处**：
- PR 1 跑通就能给用户提供 80% 价值（多 Bot 协作）
- advisor 的风险隔离在 PR 2，失败可单独回滚
- PR 3 的遗漏点不阻塞主线

### E.4 是否建议进入实现阶段？

**不建议直接按 v2 全量实现。**

建议：
1. 先做 PoC 验证两件事：SDK PreToolUse Hook API 稳定性、`:ro` 挂载与 PreCompact 的兼容性
2. 按 PR 1/2/3 拆分，PR 1 先走完整流程
3. PR 2 开始前，基于 PoC 输出**修订 v2 文档为 v3**，落实 §B、§C、§D 的剩余空白

---

## F. 遗漏点

### F.1 Bot "测试连接"（Test Connect）按钮

v2 §8.1 列表视图操作里有"测试连接"，但**没有说测什么**。

**合理定义**：
1. 从 `data/config/bots/{botId}/feishu.json` 读凭证
2. 临时建立一次 WebSocket 连接（不落地到 `botConnections`）
3. 拉取 Bot Info（open_id + name）
4. 关闭连接
5. UI 展示：连接成功 + Bot 显示名 + open_id 前 8 位

**结论**：**⚠️ P2** — v3 需补一节说明测试流程（复用 `createFeishuConnection` 但传一个 ephemeral 标志）。

### F.2 Bot 停用（`status='disabled'`）的行为

v2 §4.3 只说"断开连接；`bot_group_bindings` 保留"，但没说：

1. 正在处理的消息：让它跑完？强制中止？
2. 队列里排队的消息：丢弃？保留等重新启用？
3. 已回填的 `open_id`：保留（下次启用继续用）？
4. WebSocket 断开的心跳行为：优雅关闭（发送 close frame）还是直接 kill？

**结论**：**⚠️ P1** — v3 补齐停用语义。建议：正在跑的跑完 + 队列丢弃 + open_id 保留 + 优雅断开。

### F.3 软删除 vs 硬删除

v2 用 `ON DELETE CASCADE`，是硬删除。

**问题**：
- 用户误点删除 → 所有 `bot_group_bindings`、`sessions` 直接消失
- 文件层面 config、scratch、session 都被删
- 不可恢复

**建议**：借鉴 `users.deleted_at` 软删除模式：
- `bots` 加 `deleted_at` 列
- 软删除时 `deleted_at = now()` + 断开连接 + 改 `status='disabled'`
- 所有查询加 `WHERE deleted_at IS NULL`
- 保留 30 天后硬删（定期任务）

**结论**：**⚠️ P1** — v3 必须讨论软删除，避免误操作导致不可逆损失。

### F.4 凭证泄露 / 更换场景

v2 §4.3 说"更新凭证：原子替换凭证文件 → 断开旧连接 → 建立新连接"。

**问题**：
- 历史消息归属：`messages.source_jid` 是 `feishu:oc_xxx`，和 App 身份无关，**无问题**
- 用量统计（`usage_records.bot_id`）：bot_id 是内部 ID 不变，凭证变更不影响归属，**无问题**
- 但：凭证更换后，Bot 的 open_id **会变**（新 App ID 对应新 open_id）
- 所有 `bot_group_bindings.group_jid` 指向的飞书群，用户需要**重新把新 App 拉入群**（老 App 已不属于这个 App ID 了）
- v2 没说新 open_id 回填逻辑，但 §4.2 启动流程说"连接建立后回填"应该也能处理凭证更换

**结论**：**⚠️ P2** — v3 补一句"凭证更换后 open_id 自动重新回填；用户需手动重新拉 Bot 入群"。

### F.5 权限模型（admin vs member）

v2 没说清：
1. admin 能管理 member 的 Bot 吗？
2. member 能看到其他 member 的 Bot 吗？
3. Bot 的凭证文件权限（0600）确保了文件系统隔离，但 API 层呢？

**建议**：
- `GET /api/bots` 默认只返回当前用户的 Bot
- admin 加 `?user_id=xxx` 查询参数可以跨用户
- `PUT/DELETE /api/bots/:id` 校验 `req.user.id === bot.user_id || req.user.role === 'admin'`
- member 不能看到其他 member 的 Bot（即使绑在同一个 folder）

**结论**：**🔴 P0** — 多租户系统的基础安全，v2 遗漏严重。v3 必须补权限矩阵。

### F.6 审计日志

v2 没提 Bot 相关操作是否写入 `auth_audit_log`。

**建议**：扩展 `AuthEventType`：
- `bot_created`
- `bot_credentials_updated`（敏感，必记）
- `bot_disabled`
- `bot_deleted`（硬/软）
- `bot_binding_added` / `bot_binding_removed`

**结论**：**⚠️ P1** — v3 补审计事件类型列表。

### F.7 其他遗漏

- **Bot 显示名 `bots.name` 与飞书侧真实显示名的关系**：如果用户在 HappyClaw 里把 Bot 命名为"Frontend"，但飞书 App 的 name 是"MyBot"，用户在群里看到的 @名称是飞书的（"MyBot"），HappyClaw UI 显示的是"Frontend"——这种不一致容易误导。v3 建议：启动时调用飞书 API 获取真实 app name，在 UI 中同时显示两者。
- **多个 Bot 共享同一个飞书 App**：不可能（App ID 唯一），但如果用户错误配置了同一个 App Secret 到两个 Bot，会发生什么？建议加唯一性校验（`bots.app_id` 在连接后回填 + UNIQUE index）。
- **宿主机模式的 advisor Bot**：CLAUDE.md §2.4 强制 admin 主容器是 host mode、member 主容器是 container mode。如果 admin 把一个 advisor Bot 拉入自己的主容器 folder（`main`），走 host mode，PreToolUse Hook 软保护生效；但如果这个 Bot 还被用户拉入别的 folder，是 container mode 还是 host mode？v2 没明确"执行模式是 per-folder 还是 per-bot"。**⚠️ P1**

---

## G. 修复建议的优先级

### 🔴 P0（必须在实现前解决）

| ID | 问题 | 来源 |
|----|------|------|
| P0-1 | SDK PreToolUse Hook API 真实性验证 + subprocess 覆盖面 | B.2 |
| P0-2 | `:ro` 挂载与 PreCompact（`conversations/` 写入）的冲突 | B.6 |
| P0-3 | advisor 读到过时文件状态的语义缺陷 | D.2 |
| P0-4 | 单 Bot 老路径与新路径的分叉（connectionKind='user' 不走 bot_group_bindings） | C.5 |
| P0-5 | 权限模型：admin 跨用户管理、member 隔离 | F.5 |

### ⚠️ P1（实现前文档需补齐）

| ID | 问题 | 来源 |
|----|------|------|
| P1-1 | SCHEMA_VERSION 基线偏差（v24 vs v34），需对齐 `src/db.ts` 实际值 | A#1 |
| P1-2 | `serializationKeyResolver` 给出 before/after 代码 | B.1 |
| P1-3 | advisor 默认 CLAUDE.md 模板（独立于 writer） | B.5 |
| P1-4 | scratch 目录生命周期（Bot 删除级联、定期清理） | B.3 |
| P1-5 | `bot_group_bindings.folder` 一致性机制（推荐 SQLite trigger） | C.2 |
| P1-6 | `onBotAddedToGroup` 用 `INSERT OR IGNORE` 处理并发 | C.3 |
| P1-7 | Bot 删除时的清理清单（DB + 文件层） | C.4 |
| P1-8 | open_id 回填完成后再订阅消息 | C.1 |
| P1-9 | Bot 停用语义：进行中/排队中消息的处理 | F.2 |
| P1-10 | 软删除设计（`bots.deleted_at`） | F.3 |
| P1-11 | 审计日志事件类型 | F.6 |
| P1-12 | advisor Bot 跨 folder 的执行模式归属 | F.7 |
| P1-13 | Token 估算对中文的偏差修正 | A#9 |
| P1-14 | §3.6 `INSERT OR IGNORE` 对现有代码的影响核查 | A#5 |
| P1-15 | `logs/bots/{botId}/` 路径是否仍在 `file-manager.ts` 保护范围 | A#11 |

### P2（实现中/后可补）

| ID | 问题 | 来源 |
|----|------|------|
| P2-1 | scratch mkdir 权限模式（容器模式属主） | B.4 |
| P2-2 | 测试连接（Test Connect）详细流程 | F.1 |
| P2-3 | 凭证更换后用户需重新拉入群的说明 | F.4 |
| P2-4 | `bots.name` 与飞书 App name 的同步 | F.7 |
| P2-5 | `bots.app_id` 唯一性校验 | F.7 |
| P2-6 | `usage_daily_summary` 预留 bot 维度 | A#12 |

---

## H. 最终建议

### 不建议立刻进入实现阶段。

**理由**：
1. **2 个 P0 问题需 PoC 验证**（B.2 SDK Hook API、B.6 `:ro` 挂载）——如果 SDK 不提供稳定的 PreToolUse Hook，advisor 宿主机模式需要整体重新设计
2. **1 个 P0 语义缺陷无法通过代码解决**（D.2 advisor 读到过时状态）——需要在设计层决定是否接受、或改变 advisor 并发模型
3. **1 个 P0 文档空白**（C.5 单 Bot 新旧路径分叉）——实现时极易引入退化 bug
4. **1 个 P0 安全隐患**（F.5 权限模型）——多租户必须

### 建议路径

**阶段 1：PoC（3-5 天）**
- 写一个最小 demo 验证 Claude Agent SDK 的 PreToolUse hook
- 把一个容器的工作目录挂成 `:ro`，跑完整 agent 流程看 PreCompact/session 是否炸

**阶段 2：v3 文档（1-2 天）**
- 基于 PoC 结果修订 §5.6（advisor 强制策略）、§6（CLAUDE.md 模板）、§7.4（scratch 生命周期）
- 补齐 §F 的所有遗漏点（权限、审计、软删除、停用语义）
- 明确 §5.2 两条路径（user vs bot connectionKind）

**阶段 3：PR 1 多 Bot 基础（12-15 天）**
- 只做 writer，folder 级串行
- 完整走通多 Bot 协作主线

**阶段 4：PR 2 writer/advisor 并发（10 天）**
- 基于 PoC 已验证的机制落地

**阶段 5：PR 3 收尾（5 天）**
- 软删除、审计、清理、边角

总周期预计 **6-8 周**（单人串行），或 3-4 周（两人并行 PR 1 后端 + 前端）。

### 总结

v2 相对 v1 是**显著进步**，Schema 层设计基本正确，核心概念清晰。但 advisor 并发这个新增给设计引入了**未被充分推演的语义和技术风险**。建议先做 PoC 验证 + 拆分 PR 渐进落地，而不是一次性全量实现。
