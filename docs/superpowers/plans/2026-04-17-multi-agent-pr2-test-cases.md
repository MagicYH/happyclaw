# Multi-Agent PR2 测试用例文档

**范围：** PR2（advisor 写保护 + PreToolUse Hook + scratch / bot-profile 挂载，详见 `2026-04-17-multi-agent-pr2.md`）
**日期：** 2026-04-17
**测试层级：** 单元测试（Unit）+ 集成测试（Integration）+ 端到端测试（E2E）
**目标覆盖率：** ≥80%（按 common 规则）
**设计依据：** `docs/superpowers/specs/2026-04-17-multi-agent-design-v3.md` §5.6 / §6.1 / §7.4 / §7.5 / §8.3

---

## 1. 测试策略与工具

### 1.1 测试金字塔

```
         ┌──────────────┐
         │  E2E (10+)   │  真实 Hono app.request + 真实 DB，
         │              │  完整 LLM hook 调用链模拟
         ├──────────────┤
         │ Integration  │  跨模块（profile ↔ container-runner
         │   (12+)      │  ↔ agent-runner hook 注册链路）
         ├──────────────┤
         │     Unit     │  纯函数：hook 决策 / 路径解析 /
         │    (50+)     │  bash 命令分词 / profile 模板选择
         └──────────────┘
```

### 1.2 工具栈

| 层级 | 工具 | 说明 |
|------|------|------|
| Unit | Vitest 4.1（现有） | `tests/advisor-guard.test.ts`、`tests/advisor-guard-bash.test.ts`、`tests/bot-profile-manager.test.ts` 等 |
| Integration | Vitest + tmp DATA_DIR + 真实 SQLite | `tests/container-runner-bot-mounts.test.ts`、`tests/agent-runner-hook-registration.test.ts` |
| E2E (API) | Vitest + Hono `app.request()` | `tests/bot-profile-api.test.ts`、`tests/pr2-smoke.test.ts` |
| E2E (SDK Hook) | 直接构造 `PreToolUseHookInput`，断言 Hook 返回的 `permissionDecision` | - |
| E2E (Web UI) | ❌ 本 PR 无前端，推迟到 PR3 | - |

**核心原则**：PreToolUse Hook 是安全防线，要求 **穷尽 allow/deny 矩阵 + 恶意路径攻击向量 + fail-closed 覆盖**。命令解析不靠子进程，全部在纯函数里完成（正则 + 简易分词），因此可以完全用 unit 测试覆盖。

### 1.3 隔离机制

所有测试都使用**临时 DATA_DIR**（`fs.mkdtempSync`），每个 `beforeEach` 重新 init 数据库并设置 `process.env.DATA_DIR`；每个 `afterEach` 清理目录并 `delete process.env.DATA_DIR`。避免跨测试污染和开发环境影响。

**特别约束**：

- 所有写/edit 工具的测试都假设 `projectRoot = /workspace/group`；改动默认 projectRoot 时必须复验矩阵
- 所有 bash 测试以 `/workspace/group` 为 root，验证 resolver 纯函数行为
- `container-runner` 测试 **不** 真的启动 Docker / node 进程，只测挂载构造函数 `buildBotMounts` 的返回值 + 副作用（目录与模板文件落盘）

### 1.4 Mock 策略

- **Claude Agent SDK**：PR2 本阶段 hook 测试 **不** mock SDK；直接调用 `createAdvisorGuardHook()` 的返回值，手工构造 `PreToolUseHookInput` 对象断言 `hookSpecificOutput.permissionDecision`
- **文件系统**：不 mock，真实写 tmpdir
- **Hono**：使用 `app.request()` 而非 supertest，保持单进程、快速
- **时间戳**：Hook 决策不依赖时间，无需 `vi.useFakeTimers()`
- **logger**：Hook 内部 logger.error 用 `vi.spyOn` 可选检查（不是必须）

---

## 2. 测试覆盖矩阵

| Feature | Unit | Integration | E2E | 合计 |
|---------|------|-------------|-----|------|
| Bot Profile Manager | UT-01 ~ UT-08 | IT-01 | - | 9 |
| 默认模板生成 | UT-09 ~ UT-12 | - | E2E-04 | 5 |
| PreToolUse Hook — Write/Edit/NotebookEdit | UT-13 ~ UT-22 | IT-02 | E2E-05 | 12 |
| PreToolUse Hook — Bash 命令矩阵 | UT-23 ~ UT-38 | IT-03 | - | 17 |
| PreToolUse Hook — fail-closed 异常路径 | UT-39 ~ UT-44 | - | E2E-06 | 7 |
| container-runner 挂载构造 | UT-45 ~ UT-50 | IT-04 ~ IT-06 | E2E-07 | 10 |
| agent-runner 模式分叉 | UT-51 ~ UT-55 | IT-07 ~ IT-08 | E2E-08 | 8 |
| Bot Profile HTTP API | UT-56 ~ UT-60 | IT-09 ~ IT-11 | E2E-01, E2E-02, E2E-03 | 11 |
| 审计事件 | UT-61 | IT-12 | E2E-09 | 3 |
| concurrency_mode 覆盖链 | UT-62 ~ UT-64 | - | E2E-10 | 4 |
| 回归（PR1 零回归） | - | - | E2E-11 | 1 |
| **合计** | **64** | **12** | **11** | **87** |

> 实际 unit 用例按命名规律列到 UT-64，集成到 IT-12，E2E 到 E2E-11。若执行时有合并，序号连续即可。

---

## 3. 单元测试用例（Unit Tests，64 条）

### 3.1 Bot Profile Manager：路径与 CRUD（UT-01 ~ UT-08）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-01 | `safeProfilePath` 对合法 botId 返回绝对路径 | DATA_DIR 临时目录 | `safeProfilePath('bot_abc12345')` | 返回 `{DATA_DIR}/bot-profiles/bot_abc12345` | 🔴 P0 |
| UT-02 | `writeBotProfile` 原子写（.tmp → rename） | DATA_DIR 临时目录 | `writeBotProfile('bot_abc12345', 'x')` | 文件存在；目录中无 `.tmp` 残留 | 🔴 P0 |
| UT-03 | `readBotProfile` 首次读无文件返回默认模板 | 无 profile 目录 | `readBotProfile('bot_abc12345', 'writer')` | 返回 writer 模板（含"协作准则"） | 🔴 P0 |
| UT-04 | `readBotProfile` 读写往返一致 | 先 `writeBotProfile(id, 'X')` | `readBotProfile(id, 'writer')` | 严格等于 `'X'`（不回落模板） | 🔴 P0 |
| UT-05 | `ensureProfileExists` 首次调用返回 true 并落盘 | 无 profile 目录 | `ensureProfileExists('bot_abc12345', 'advisor')` | 返回 `true`；文件存在；内容含 advisor 模板 | 🔴 P0 |
| UT-06 | `ensureProfileExists` 第二次调用返回 false 且不覆盖 | UT-05 状态下 | 再次 `ensureProfileExists(id, 'writer')` | 返回 `false`；文件内容仍是 advisor 模板 | 🔴 P0 |
| UT-07 | `deleteBotProfile` 幂等清理 | UT-05 状态下 | 连续 `deleteBotProfile(id)` ×2 | 第一次删成功；第二次不抛异常；目录不存在 | 🟠 P1 |
| UT-08 | `getProfileMountPath` 路径与 write 目录一致 | DATA_DIR 临时目录 | `getProfileMountPath('bot_abc12345')` | 等于 UT-01 的返回值 | 🔴 P0 |

### 3.2 Bot Profile Manager：路径遍历防御（UT-09 ~ UT-12，关键安全）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-09 | `writeBotProfile` 拒绝 `..` 组件 botId | - | `writeBotProfile('../etc/passwd', '')` | 抛 `InvalidBotIdError`；文件系统中 `{DATA_DIR}/etc` 不存在 | 🔴 P0 |
| UT-10 | 拒绝含 `..` 但以 `bot_` 前缀伪装的 botId | - | `writeBotProfile('bot_../foo', '')` | 抛 `InvalidBotIdError` | 🔴 P0 |
| UT-11 | 拒绝太短 botId | - | `writeBotProfile('bot_a', '')`（<8 字符） | 抛 `InvalidBotIdError` | 🔴 P0 |
| UT-12 | 拒绝 URL 编码 botId（防御 router 层漏网） | - | `writeBotProfile('bot_%2e%2e', '')` | 抛 `InvalidBotIdError`（正则 `[a-zA-Z0-9_-]` 不含 `%`） | 🔴 P0 |

### 3.3 默认模板内容断言（UT-13 ~ UT-16）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-13 | writer 模板含标准 sections | - | `readBotProfile('bot_abc12345', 'writer')` | 含 `# 角色定义`、`## 职责范围`、`## 协作准则` | 🟠 P1 |
| UT-14 | writer 模板**不**包含 advisor 字样 | - | 同上 | 不含 `advisor`、`scratch`、`只读` 等 advisor 关键词 | 🟠 P1 |
| UT-15 | advisor 模板强制声明 scratch 与 /tmp | - | `readBotProfile('bot_abc12345', 'advisor')` | 含 `/workspace/scratch`、`/tmp`、`禁止修改` | 🔴 P0 |
| UT-16 | advisor 模板强制声明 subprocess 约束 | - | 同上 | 含"subprocess"或"python script.py"提示，对应 §6.1 模板 | 🟠 P1 |

### 3.4 PreToolUse Hook — Write/Edit/NotebookEdit（UT-17 ~ UT-26）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-17 | Write 到项目目录 → deny | projectRoot=`/workspace/group` | `evaluateToolCall({ name:'Write', input:{file_path:'/workspace/group/src/foo.ts', content:'x'} })` | `decision='deny'`；reason 匹配 `禁止写入项目目录` | 🔴 P0 |
| UT-18 | Write 到项目深层嵌套目录 → deny | 同上 | `file_path:'/workspace/group/a/b/c/d/e.ts'` | `deny` | 🔴 P0 |
| UT-19 | Write 到 scratch → allow | 同上 | `file_path:'/workspace/scratch/report.md'` | `allow` | 🔴 P0 |
| UT-20 | Write 到 /tmp → allow | 同上 | `file_path:'/tmp/debug.log'` | `allow` | 🔴 P0 |
| UT-21 | Write 到 `/home/node/.claude` → allow | 同上 | `file_path:'/home/node/.claude/session.json'` | `allow` | 🟠 P1 |
| UT-22 | Edit 到项目文件 → deny | 同上 | `name:'Edit', input:{file_path:'/workspace/group/a.ts', old_string:'', new_string:''}` | `deny` | 🔴 P0 |
| UT-23 | MultiEdit 到项目文件 → deny（若支持） | 同上 | `name:'MultiEdit', input:{file_path:'/workspace/group/a.ts'}` | `deny` | 🟠 P1 |
| UT-24 | NotebookEdit 到项目 ipynb → deny | 同上 | `name:'NotebookEdit', input:{notebook_path:'/workspace/group/a.ipynb'}` | `deny` | 🔴 P0 |
| UT-25 | Read（非写工具）→ allow | 同上 | `name:'Read', input:{file_path:'/workspace/group/a.ts'}` | `allow` | 🔴 P0 |
| UT-26 | Glob / Grep 等只读工具 → allow | 同上 | `name:'Grep', input:{pattern:'foo', path:'/workspace/group'}` | `allow` | 🟠 P1 |

### 3.5 PreToolUse Hook — 路径变种攻击（UT-27 ~ UT-32，关键安全）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-27 | `../../` 反复解析后仍落在项目内 | projectRoot=`/workspace/group` | `file_path:'/workspace/group/../group/src/x.ts'` | `deny` | 🔴 P0 |
| UT-28 | 相对路径（无法判定）→ fail-closed deny | 同上 | `file_path:'src/foo.ts'` | `deny`（相对路径在 advisor cwd 下视为项目） | 🔴 P0 |
| UT-29 | 仅 `.`（当前目录） → deny | 同上 | `file_path:'.'` | `deny` | 🟠 P1 |
| UT-30 | 空字符串 file_path → deny（fail-closed） | 同上 | `file_path:''` | `deny` | 🔴 P0 |
| UT-31 | 非 string file_path → deny（fail-closed） | 同上 | `file_path: 42` | `deny` | 🔴 P0 |
| UT-32 | 绝对路径但后缀匹配项目根边界 | 同上 | `file_path:'/workspace/groupa/x.ts'`（不是 `/workspace/group/` 开头） | `allow`（严格比较 `startsWith(root + sep)`） | 🔴 P0 |

### 3.6 PreToolUse Hook — Bash 命令矩阵（UT-33 ~ UT-48，共 16 条）

Bash 是 advisor 最难防的面。测试用 `test.each` 批量断言。

| ID | 命令 | 期望 | 优先级 |
|----|------|------|--------|
| UT-33 | `echo x > /workspace/group/a` | `deny` | 🔴 P0 |
| UT-34 | `cat a >> /workspace/group/b` | `deny` | 🔴 P0 |
| UT-35 | `tee /workspace/group/x` | `deny` | 🔴 P0 |
| UT-36 | `tee -a /workspace/group/x` | `deny` | 🔴 P0 |
| UT-37 | `rm /workspace/group/a` | `deny` | 🔴 P0 |
| UT-38 | `rm -rf /workspace/group/src/` | `deny` | 🔴 P0 |
| UT-39 | `mv /workspace/scratch/x /workspace/group/` | `deny` | 🔴 P0 |
| UT-40 | `cp a /workspace/group/b` | `deny` | 🔴 P0 |
| UT-41 | `sed -i s/a/b/ /workspace/group/a` | `deny` | 🔴 P0 |
| UT-42 | `cat a \| tee /workspace/group/b` | `deny`（管道目标仍是项目） | 🔴 P0 |
| UT-43 | `ls /workspace/group` | `allow` | 🔴 P0 |
| UT-44 | `grep -r foo /workspace/group` | `allow` | 🔴 P0 |
| UT-45 | `echo x > /workspace/scratch/a` | `allow` | 🔴 P0 |
| UT-46 | `echo x > /tmp/a.log` | `allow` | 🔴 P0 |
| UT-47 | `rm /tmp/a` | `allow` | 🔴 P0 |
| UT-48 | `sed s/a/b/ /workspace/group/a`（无 `-i`） | `allow`（纯输出到 stdout） | 🟠 P1 |

### 3.7 PreToolUse Hook — git 子命令（UT-49 ~ UT-56，共 8 条）

| ID | 命令 | 期望 | 优先级 |
|----|------|------|--------|
| UT-49 | `git commit -m x` | `deny` | 🔴 P0 |
| UT-50 | `git push` | `deny` | 🔴 P0 |
| UT-51 | `git reset --hard HEAD` | `deny` | 🔴 P0 |
| UT-52 | `git checkout main` | `deny` | 🔴 P0 |
| UT-53 | `git merge feature` | `deny` | 🔴 P0 |
| UT-54 | `git rebase origin/main` | `deny` | 🔴 P0 |
| UT-55 | `git revert HEAD` | `deny` | 🟠 P1 |
| UT-56 | `git status`、`git diff`、`git log` | `allow`（三种只读 git） | 🔴 P0 |

### 3.8 PreToolUse Hook — Bash 边界与规避尝试（UT-57 ~ UT-62）

| ID | 命令 | 期望 | 理由 / 优先级 |
|----|------|------|--------|
| UT-57 | 空字符串 bash 命令 | `deny`（fail-closed） | 🔴 P0 |
| UT-58 | `echo x > '/workspace/group/a'`（单引号包裹） | `deny` | 🔴 P0 — 必须通过引号剥离 |
| UT-59 | `echo x > "/workspace/group/a"`（双引号包裹） | `deny` | 🔴 P0 |
| UT-60 | `echo a; rm /workspace/group/b`（第二条语句是写） | `deny` | 🔴 P0 |
| UT-61 | `echo a && cp /tmp/x /workspace/group/y`（复合命令） | `deny` | 🔴 P0 |
| UT-62 | 命令替换 `echo x > $(pwd)/a` | `deny`（fail-closed：动态路径无法静态判定，保守拒绝） | 🟠 P1 |

### 3.9 PreToolUse Hook — 其他工具与异常（UT-63 ~ UT-69，7 条含 MCP & fail-closed）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-63 | 未知工具名（无 path 字段）默认 allow | projectRoot | `name:'WebSearch', input:{query:'foo'}` | `allow` | 🟠 P1 |
| UT-64 | 未知工具含 `file_path` 落项目 → deny | 同上 | `name:'SomeMcp', input:{file_path:'/workspace/group/x'}` | `deny` | 🔴 P0 |
| UT-65 | MCP 工具名 `mcp__xyz__write` 含写语义（按名启发式）但无 path → allow | 同上 | `name:'mcp__xyz__write', input:{data:'x'}` | `allow`（除非 input 有 path） | 🟡 P2 |
| UT-66 | `tool_input=null` → deny（fail-closed） | 同上 | `name:'Write', input:null` | `deny` | 🔴 P0 |
| UT-67 | `tool_input` 不是对象 → deny（fail-closed） | 同上 | `name:'Write', input:'oops'` | `deny` | 🔴 P0 |
| UT-68 | hook 内部异常（模拟 path.resolve 抛错）→ deny（fail-closed） | Mock `path.resolve` 抛异常 | 任意输入 | `deny`；reason 含 `advisor-guard 内部异常` | 🔴 P0 |
| UT-69 | hook 返回的 `hookSpecificOutput.hookEventName` 必须是 `'PreToolUse'` | 用 createAdvisorGuardHook 生成真实 hook | 构造 Write deny 输入 | 返回 `{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'deny', ...}}` | 🔴 P0 |

### 3.10 container-runner 挂载构造（UT-70 ~ UT-75）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-70 | `buildBotMounts` 为 advisor 创建 scratch + profile 目录 | DATA_DIR tmp | `buildBotMounts({folder:'alpha', botId:'bot_abc12345', mode:'advisor'})` | 返回 `{scratchHost, profileHost, botMode:'advisor'}`；两个目录存在 | 🔴 P0 |
| UT-71 | advisor 模式下 profile 目录写入 advisor 模板（不覆盖已存在） | 同上 | 同上 | `profileHost/CLAUDE.md` 存在；内容含 advisor 关键词 | 🔴 P0 |
| UT-72 | writer 模式下 profile 目录写入 writer 模板 | 同上 | `mode:'writer'` | `CLAUDE.md` 内容**不**含 advisor 关键词，含 `协作准则` | 🔴 P0 |
| UT-73 | `buildBotMounts` 空 botId 返回 null（PR1 兼容） | 同上 | `botId:''` | 返回 `null` | 🔴 P0 |
| UT-74 | 路径中 folder 与 botId 拼接正确 | 同上 | `folder:'home-alice', botId:'bot_xyz12345'` | `scratchHost = {DATA_DIR}/scratch/home-alice/bots/bot_xyz12345` | 🔴 P0 |
| UT-75 | 恶意 botId 拒绝（防御路径遍历重演） | 同上 | `botId:'../../etc'` | 抛 `InvalidBotIdError` 或 buildBotMounts 返回 null，不创建恶意目录 | 🔴 P0 |

### 3.11 agent-runner 模式分叉与 Hook 注册（UT-76 ~ UT-81）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-76 | `resolveBotModeFromEnv` 识别 advisor | - | `resolveBotModeFromEnv({HAPPYCLAW_BOT_MODE:'advisor'})` | `'advisor'` | 🔴 P0 |
| UT-77 | `resolveBotModeFromEnv` 识别 writer | - | `{HAPPYCLAW_BOT_MODE:'writer'}` | `'writer'` | 🔴 P0 |
| UT-78 | `resolveBotModeFromEnv` 环境变量缺失 → 默认 writer | - | `{}` | `'writer'` | 🔴 P0 |
| UT-79 | `resolveBotModeFromEnv` 非法值 → 默认 writer（不抛） | - | `{HAPPYCLAW_BOT_MODE:'bogus'}` | `'writer'` | 🔴 P0 |
| UT-80 | `buildHooksConfig(writer)` 仅含 PreCompact，**不含** PreToolUse | - | `buildHooksConfig({botMode:'writer', projectRoot:'/workspace/group', preCompactHook:fn})` | `PreToolUse===undefined`；`PreCompact` 有 1 项 | 🔴 P0 |
| UT-81 | `buildHooksConfig(advisor)` 含 PreCompact + PreToolUse（1 hook） | - | 同上 `botMode:'advisor'` | `PreToolUse.length===1`；`PreCompact.length===1` | 🔴 P0 |

### 3.12 concurrency_mode 覆盖链（UT-82 ~ UT-85）

这些测试针对 `bots.concurrency_mode` 与 `bot_group_bindings.concurrency_mode` 的组合。

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-82 | binding.concurrency_mode 非 null → 覆盖 bots.concurrency_mode | Bot=writer + binding=advisor | `resolveConcurrencyMode(bot, binding)` | `'advisor'` | 🔴 P0 |
| UT-83 | binding.concurrency_mode=null → 回退 bots.concurrency_mode | Bot=advisor + binding=null | 同上 | `'advisor'` | 🔴 P0 |
| UT-84 | 两者都 null → 默认 writer | Bot=null/undefined + binding=null | 同上 | `'writer'` | 🔴 P0 |
| UT-85 | bots.concurrency_mode 被下游函数透传给 buildBotMounts（契约测试） | 模拟 runContainerAgent glue | 传入 bot 的 concurrency_mode | buildBotMounts 收到的 mode 与 bot 字段一致 | 🟠 P1 |

### 3.13 审计事件类型（UT-86）

| ID | 目标 | 前置条件 | 输入 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| UT-86 | `AuthEventType` 联合类型包含 `bot_profile_updated` | typecheck | - | 编译通过 | 🟠 P1 |

> 单元测试到此 64 条（按矩阵汇总实际计数，跨章节序号连续）。实施时可按测试文件分组，合并相邻的小 case 不影响覆盖率。

---

## 4. 集成测试用例（Integration Tests，12 条）

集成测试跨多个模块，验证 profile manager / container-runner / agent-runner 三者的粘合点。目录 `tests/integration/`。

| ID | 目标 | 跨越模块 | 步骤 | 期望结果 | 优先级 |
|----|------|---------|------|---------|--------|
| IT-01 | profile 读写 + 默认模板 + 读回链路 | `bot-profile-manager.ts` + 文件系统 | 1. `readBotProfile` 首次得默认<br>2. `writeBotProfile` 自定义<br>3. 再 `readBotProfile` 得自定义 | 三步结果符合预期 | 🔴 P0 |
| IT-02 | 真实 `createAdvisorGuardHook` 决策与 `PreToolUseHookInput` 结构匹配 | advisor-guard + SDK 类型 | 构造最小可用 `PreToolUseHookInput`（hook_event_name, tool_name, tool_input, tool_use_id, cwd），调用 hook | 返回 `{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'deny'}}` | 🔴 P0 |
| IT-03 | Bash hook 对真实命令列表做 allow/deny 回归跑全 | advisor-guard-bash | 把 §3.6 ~ §3.8 的矩阵跑一遍 | 所有期望一致 | 🔴 P0 |
| IT-04 | advisor Bot 启动链：profile 落盘 + scratch 目录 + env 注入 | `buildBotMounts` + 文件系统 | 1. createBot(advisor)<br>2. buildBotMounts<br>3. 检查目录 + CLAUDE.md 内容 + 返回的 botMode | 目录存在；模板正确；botMode='advisor' | 🔴 P0 |
| IT-05 | writer Bot 启动链：profile 为 writer 模板、无 deny-hook 环境 | 同上 | 同上但 mode=writer | profile 含 `协作准则`、不含 `advisor`；botMode='writer' | 🔴 P0 |
| IT-06 | buildBotMounts 幂等：第二次调用不覆盖已存在 profile | 同上 | 1. buildBotMounts<br>2. 改文件内容<br>3. buildBotMounts 再跑 | 文件内容保留用户自定义 | 🔴 P0 |
| IT-07 | agent-runner hook 装配链：`buildHooksConfig` 返回结构可被 SDK query() 消费 | agent-runner + SDK 类型 | 构造 advisor 配置 | `hooks.PreToolUse[0].hooks[0]` 是 callable；调用后返回对象含 `hookSpecificOutput` | 🔴 P0 |
| IT-08 | env → mode → hook 注册端到端 | container-runner env 注入 + agent-runner 读 env | 模拟 process.env.HAPPYCLAW_BOT_MODE='advisor'，跑 buildHooksConfig | PreToolUse 存在 | 🔴 P0 |
| IT-09 | GET `/api/bots/:id/profile` 返回默认模板（member 自己的 Bot） | 路由 + authorizeBot + profile manager | 1. member 登录<br>2. createBot<br>3. app.request GET profile | 200；body 含 advisor/writer 关键词（按 mode） | 🔴 P0 |
| IT-10 | PUT `/api/bots/:id/profile` 写入并 GET 回读一致 | 路由 + profile manager + 审计 | 1. PUT content='# Custom'<br>2. GET | PUT 返回 200；GET body.content === '# Custom'；审计日志含 `bot_profile_updated` | 🔴 P0 |
| IT-11 | PUT `/api/bots/:id/profile` 超 64KB 被 Zod 拒 | `UpdateBotProfileSchema` | 发送 content 长度 = 64*1024+1 | 400；error 包含 Zod issues | 🟠 P1 |
| IT-12 | 审计事件完整字段（ip / user_agent / actor / username） | 路由 + audit log | PUT profile 时带 `X-Forwarded-For` 头 | audit_log 行 ip_address/user_agent/actor_username/username/details.bot_id 全部非空 | 🟠 P1 |

---

## 5. 端到端测试用例（E2E Tests，11 条）

**工具：** Vitest + Hono `app.request()`，完整中间件链 + Zod + 路由 handler + DB + 审计日志。Hook 层通过手工构造 `PreToolUseHookInput` 模拟 SDK 调用（而非真的跑 Claude）。

### 5.1 Bot Profile API 正常路径

#### E2E-01：Member 完整 profile 生命周期（Happy Path）

**目标：** Member 自己创建 Bot、读默认 profile、写自定义、再读。

**前置条件：** `enableMultiBot=true`；member `alice` 有 Bot `bot_abc12345`（concurrency_mode='advisor'）

**步骤：**

```
1. alice 登录
2. GET /api/bots/{id}/profile
   → 200，body.mode='advisor'；body.content 含 'advisor' 和 '/workspace/scratch'
3. PUT /api/bots/{id}/profile { content: '# My Role\n\nReviewer' }
   → 200
4. GET /api/bots/{id}/profile
   → 200，body.content === '# My Role\n\nReviewer'；body.mode='advisor'（模板已被自定义覆盖，但 mode 字段仍来自 bots 表）
5. 文件系统检查：data/bot-profiles/{id}/CLAUDE.md 内容一致
6. 审计日志含 bot_profile_updated，actor=alice，username=alice
```

**期望结果：** 所有步骤 200，DB 与 FS 一致，审计完整。

**优先级：** 🔴 P0

---

#### E2E-02：Admin 跨用户编辑 profile

**目标：** admin 可以编辑任意 member 的 Bot profile。

**前置条件：** admin；member `alice` 有一个 Bot

**步骤：**

```
1. admin 登录
2. PUT /api/bots/{alice_bot_id}/profile { content: 'admin overridden' }
   → 200
3. 审计：actor_username=admin，username=alice
```

**期望结果：** 跨用户操作允许；审计 actor/username 正确区分。

**优先级：** 🔴 P0

---

### 5.2 安全攻击向量

#### E2E-03：Member 攻击 victim 的 profile（跨租户 403）

**目标：** member `eve` 尝试读/写/访问 victim 的 Bot profile，全部拒绝。

**前置条件：** eve + victim 都是 member；victim 有 Bot `victim_bot`

**步骤：**

```
1. eve 登录
2. GET /api/bots/{victim_bot.id}/profile   → 403
3. PUT /api/bots/{victim_bot.id}/profile { content: 'hacked' }  → 403
4. 检查 data/bot-profiles/{victim_bot.id}/CLAUDE.md 未被写入 'hacked'
```

**期望结果：** 所有越权尝试 403；无文件被污染；审计日志含 forbidden 失败记录（若实现）。

**优先级：** 🔴 P0（安全）

---

#### E2E-04：路径遍历 botId 攻击被 400 拒绝

**目标：** 恶意 botId（含 `..` / URL 编码 / 太短）在进入 authorizeBot 之前被 400 拦截，或在 profile manager 层抛 InvalidBotIdError。

**前置条件：** admin 登录（排除鉴权因素干扰）

**步骤：**

```
1. PUT /api/bots/%2E%2E%2Fpasswd/profile { content: 'x' }   → 400 / 404
2. PUT /api/bots/bot_../foo/profile { content: 'x' }        → 400 / 404
3. PUT /api/bots/bot_a/profile（太短）                       → 400 / 404
4. PUT /api/bots/bot_abc12345/profile { content: 'x' }（合法） → 200
5. 文件系统检查：
   - {DATA_DIR}/etc 不存在
   - {DATA_DIR}/bot-profiles/bot_../ 不存在
   - {DATA_DIR}/bot-profiles/bot_abc12345/CLAUDE.md 存在
```

**期望结果：** 非法 botId 全部拒绝（不落盘）；合法 botId 正常写入。

**优先级：** 🔴 P0（安全）

---

### 5.3 advisor 写保护端到端

#### E2E-05：advisor Bot 启动时 scratch + bot-profile 目录创建 + env 注入

**目标：** 从 createBot(advisor) 一直到 agent-runner 启动参数齐全。

**前置条件：** member alice，已创建 advisor Bot

**步骤：**

```
1. alice 登录，POST /api/bots { concurrency_mode:'advisor', ... }
2. 模拟消息到达（触发 runContainerAgent 的 glue 层，不真的跑容器）
3. 检查 buildBotMounts 结果：
   - data/scratch/{folder}/bots/{botId}/ 存在
   - data/bot-profiles/{botId}/CLAUDE.md 存在，内容含 advisor 模板关键词
4. 检查 container-runner 构造的 env（容器模式 docker args 包含 -v scratch:rw、-v bot-profile:ro、-e HAPPYCLAW_BOT_MODE=advisor；宿主机模式 env.HAPPYCLAW_BOT_MODE='advisor' + HAPPYCLAW_SCRATCH_DIR / HAPPYCLAW_BOT_PROFILE_DIR 设置）
5. 检查 agent-runner 的 resolveBotModeFromEnv + buildHooksConfig 返回含 PreToolUse
```

**期望结果：** 四项全部齐备（目录/env/hook）。

**优先级：** 🔴 P0

---

#### E2E-06：advisor Hook 对真实 Write 调用返回 deny

**目标：** 模拟 LLM 触发 Write 工具调用，Hook 返回 deny 结构；LLM 收到结构化错误。

**前置条件：** advisor hook 已注册（`createAdvisorGuardHook('/workspace/group')`）

**步骤：**

```
1. 构造 PreToolUseHookInput:
   {
     hook_event_name: 'PreToolUse',
     tool_name: 'Write',
     tool_input: { file_path: '/workspace/group/src/foo.ts', content: 'x' },
     tool_use_id: 'tu_1',
     cwd: '/workspace/group'
   }
2. 调用 hook
3. 断言返回值：
   - hookSpecificOutput.hookEventName === 'PreToolUse'
   - hookSpecificOutput.permissionDecision === 'deny'
   - hookSpecificOutput.permissionDecisionReason 含 '禁止写入项目目录'
4. 构造 Bash 调用：input:{command:'rm /workspace/group/src/foo.ts'}
   → 同样返回 deny，reason 含 'Bash 命令将写入项目目录'
5. 构造合法调用：input:{command:'cat /workspace/group/src/foo.ts'}
   → 返回 {} 或 allow（按 SDK 语义 empty 即放行）
```

**期望结果：** 三种场景覆盖完整决策。

**优先级：** 🔴 P0

---

### 5.4 模式分叉 E2E

#### E2E-07：writer Bot 启动不注册 PreToolUse Hook

**目标：** writer 模式下，agent-runner 的 hooks 配置严格不含 PreToolUse，确保不会误伤 writer 用户。

**前置条件：** writer Bot 已创建

**步骤：**

```
1. 设置 process.env.HAPPYCLAW_BOT_MODE='writer'
2. 调用 resolveBotModeFromEnv(process.env) → 'writer'
3. 调用 buildHooksConfig({botMode:'writer', ...})
4. 断言：
   - hooks.PreToolUse === undefined
   - hooks.PreCompact 存在（PR1 的归档功能不受影响）
5. 真实构造一个 Write 到 /workspace/group 的调用，由于无 hook，SDK 默认允许（测试不跑 SDK，仅断言 hooks 配置）
```

**期望结果：** writer 模式 hooks 结构无 PreToolUse 字段。

**优先级：** 🔴 P0

---

#### E2E-08：环境变量异常值不破坏 writer Bot

**目标：** 容器 env 被污染/误设（`HAPPYCLAW_BOT_MODE=bogus`）时，默认走 writer 分支，不误注册 hook。

**前置条件：** - 

**步骤：**

```
1. 设置 process.env.HAPPYCLAW_BOT_MODE='malicious'
2. buildHooksConfig({botMode:resolveBotModeFromEnv(process.env), ...})
3. 断言 hooks.PreToolUse === undefined
```

**期望结果：** 异常值退化为 writer（安全侧向默认"不误伤"）。

**优先级：** 🟠 P1

---

### 5.5 审计与向后兼容

#### E2E-09：bot_profile_updated 审计字段完整性

**目标：** PUT profile 触发的审计记录字段齐全。

**前置条件：** alice 登录，已有 Bot

**步骤：**

```
1. PUT /api/bots/{id}/profile 带以下请求头：
   - X-Forwarded-For: 203.0.113.42
   - User-Agent: TestAgent/1.0
   - Cookie: session=...
2. 查询 auth_audit_log WHERE event_type='bot_profile_updated' 最新行
3. 断言：
   - username === 'alice'
   - actor_username === 'alice'
   - ip_address === '203.0.113.42'（当 TRUST_PROXY=true）或 socket IP
   - user_agent === 'TestAgent/1.0'
   - details 含 bot_id
   - created_at 是合法 ISO 时间戳
```

**期望结果：** 所有字段非空且合法。

**优先级：** 🟠 P1

---

#### E2E-10：concurrency_mode 覆盖链端到端

**目标：** Bot 默认 writer，binding 覆盖为 advisor，消息到达后真正以 advisor 启动。

**前置条件：** Bot=writer + binding=advisor（mode 字段非 null）

**步骤：**

```
1. createBot({concurrency_mode:'writer'})
2. upsertBinding({...bot, concurrency_mode:'advisor'})
3. 模拟消息到达 bot + group
4. 走到 runContainerAgent 时，解析出的 effectiveMode === 'advisor'
5. buildBotMounts 收到 'advisor'，写 advisor 模板
6. HAPPYCLAW_BOT_MODE env='advisor'
7. agent-runner hook 含 PreToolUse
```

**期望结果：** binding 的覆盖在整条链路上生效。

**优先级：** 🔴 P0

---

### 5.6 回归保护

#### E2E-11：PR1 的 113 个测试全部 PASS（零回归）

**目标：** PR2 的改动不能破坏 PR1 任何功能。

**步骤：**

```
1. npx vitest run --no-file-parallelism tests/ --reporter=verbose
2. 统计：PR1 原有测试条数（113 左右）全部 PASS
3. 重点关注：
   - PR1 单 Bot 老路径（botId=''）完整功能
   - writer Bot 启动路径不误注册 PreToolUse
   - 老的 PreCompact Hook 行为不变
   - messages INSERT OR IGNORE 行为不受 PR2 影响
   - bot CRUD / binding CRUD / 加解密 全部 OK
```

**期望结果：** PR1 + PR2 加起来 ~140+ 测试全绿。

**优先级：** 🔴 P0

---

## 6. 回归测试清单

在 PR2 合并前，必须通过以下**现有测试**全部继续通过（零回归）：

| 类别 | 测试文件 | 重点关注 |
|------|---------|---------|
| PR1 Schema / migration | `tests/*-schema*.test.ts`（PR1 的 v35 迁移） | PR2 不修改 schema，应 100% 通过 |
| PR1 Bot CRUD | `tests/bot-*.test.ts` | PR2 扩展 profile API 不影响现有 CRUD |
| PR1 路由分叉 | `tests/routing-bot.test.ts` 等 | Hook 注册走容器层，不影响路由层 |
| IM Command | `tests/im-command-utils.test.ts` | Slash 命令不受 advisor-guard 影响 |
| Message History | `tests/history-image-prune.test.ts` | PR2 不动消息层 |
| DingTalk Card | `tests/dingtalk-streaming-card.test.ts` | 不相关 |
| Session | `tests/session-history.test.ts` | PR2 不改 session 表 |
| PreCompact Hook | `tests/pre-compact-*.test.ts` | PR2 复用 buildHooksConfig，不改动 PreCompact 语义 |

**执行方式：** `make test`，期望 100% 通过（PR1 原有 113 + PR2 新增 ~87 = ~200 条）。

---

## 7. 非功能性测试（优先级 🟡 P2）

| ID | 目标 | 测试方法 |
|----|------|---------|
| NF-01 | Hook 决策性能（单次 ≤ 1ms） | 对 §3.4-§3.8 的 50 个矩阵跑 benchmark，P99 ≤ 1ms |
| NF-02 | Bash 正则回溯攻击（ReDoS） | 用超长 payload（如 1MB `"a".repeat(1_000_000)`）喂 evaluateBashCommand，预期 ≤ 50ms 返回（不 hang） |
| NF-03 | profile 文件权限（非 0600/0644） | 写入后检查 `fs.statSync(file).mode & 0o777`；advisor profile 容器挂载 ro，验证写入失败被 Hook 捕获（容器内） |
| NF-04 | scratch 目录跨用户数据隔离 | Bot A 和 Bot B 分属不同 user，各自 scratch 路径不可交叉读写（由 folder+botId 嵌套保证） |
| NF-05 | 凭证文件不泄露（hook reason 不包含 secret） | 检查 deny reason 字符串，不得含 `appSecret`、`ANTHROPIC_API_KEY` 等敏感值 |

---

## 8. 测试执行计划

### 8.1 PR2 开发期（每个 Task 完成后）

```bash
# 单元测试（快速反馈）
npx vitest run tests/bot-profile-manager.test.ts
npx vitest run tests/advisor-guard.test.ts
npx vitest run tests/advisor-guard-bash.test.ts

# 集成测试
npx vitest run tests/container-runner-bot-mounts.test.ts
npx vitest run tests/agent-runner-hook-registration.test.ts

# 端到端
npx vitest run tests/bot-profile-api.test.ts
npx vitest run tests/pr2-smoke.test.ts

# 类型检查
make typecheck
```

### 8.2 PR 提交前

```bash
make test  # 全量，含 PR1 回归
make typecheck
make build  # 确保 agent-runner 编译通过
```

要求：**全绿 + PR1 零回归 + 覆盖率 ≥ 80%**

### 8.3 CI 集成

`make test` 作为 CI 默认 job。PR2 新增测试文件自动被 vitest 扫描（约定路径 `tests/`），无需改 CI 配置。

---

## 9. 优先级汇总

| 优先级 | Unit | Integration | E2E | 合计 | 说明 |
|--------|------|-------------|-----|------|------|
| 🔴 P0 | 50 | 10 | 9 | **69** | 必须全通过才能合 PR |
| 🟠 P1 | 13 | 2 | 2 | **17** | 应该通过；允许极少 quarantine |
| 🟡 P2 | 1 | 0 | 0（+5 NF） | **6** | 非功能类，建议 PR3 前补齐 |
| **合计** | **64** | **12** | **11（+5 NF）** | **92** | |

---

## 10. 风险与未覆盖

### 已知不测（超出 PR2 范围）

- **前端 UI** 路径（`/bots` 页、profile 编辑器 Monaco）→ PR3
- **scratch 自动 GC**（超时清理、体积告警）→ PR3
- **Hook 监控指标**（调用次数、deny 次数、内部错误计数）→ PR3
- **worktree 并发 advisor**（allow 多 advisor 并发写 scratch）→ 后续版本
- **真实 Claude Agent SDK 跑一条 Write 被拦截** → 本 PR 用 hook 纯函数 + 手工构造输入模拟；SDK 层集成测试留到 PR3 前的手工灰度

### 测试未完全覆盖的风险

| 风险点 | 原因 | 缓解 |
|--------|------|------|
| Bash 命令 ReDoS / 解析遗漏 | 正则是启发式，不是完整 shell parser | NF-02 提供 ReDoS 基线；建议在 staging 做模糊测试（fuzzing） |
| subprocess 内部 open(w) 绕过 Hook | SDK 不覆盖 syscall | advisor 模板明确声明；审计日志留 trace；PR3 监控可补 |
| 动态路径 `$(pwd)`、`$VAR` | 静态正则无法求值 | UT-62 采取保守 deny；可能导致 false positive，用户遇到会投诉 → 若频繁，PR3 可加白名单 |
| 多 Bot 同 folder 并发下的 scratch 竞争 | PR2 仍全串行，无并发压力 | 合并后在 staging 观察；worktree 机制留到后续版本 |
| profile 文件挂载 ro 后容器内的错误信息是否友好 | 需真实容器环境验证 | 合并后手工灰度 1 次：创建 advisor Bot，让它尝试写 /workspace/bot-profile 看报错 |
| hook 异常 fail-closed 导致合法工具被误杀 | UT-68 覆盖了基础 fail-closed | 合并后开启 hook 失败告警监控（PR3） |

---

## 11. 实施计划中发现的测试角度补充

对比 `2026-04-17-multi-agent-pr2.md` 原计划的测试清单（7 个测试文件），以下角度在 plan 中**缺失或薄弱**，本文档已补齐：

1. **Bash 引号剥离 / 复合语句 / 命令替换**（UT-58 ~ UT-62）— plan 的 `test.each` 矩阵未覆盖引号包裹与动态路径，属高风险漏洞面
2. **路径边界严格匹配**（UT-32）— `/workspace/groupa/x.ts` 不应当作 `/workspace/group/` 的子路径，plan 未覆盖 `startsWith(root + sep)` 的严格语义
3. **未知 MCP 工具的 file_path 漏网**（UT-64）— plan 只测了"未知工具 → allow"，没测"未知工具 + 明显 file_path 项目路径 → deny"
4. **URL 编码 botId 攻击**（UT-12, E2E-04）— plan 的 traversal 测试只覆盖 `..`，没测 `%2e%2e`、`%2F` 等编码变种
5. **binding.concurrency_mode 覆盖 bots.concurrency_mode**（UT-82 ~ UT-85, E2E-10）— plan 的 Task 4 仅说"bot 的 concurrency_mode"，对 binding 覆盖链缺少显式测试
6. **HAPPYCLAW_BOT_MODE 非法值的退化行为**（UT-79, E2E-08）— plan 的 `resolveBotModeFromEnv` 测试只有 advisor/writer/缺失三种，没测"垃圾值"应退化为 writer
7. **fail-closed 在 hook 内部异常时**（UT-68）— plan 只提"fail-closed"原则，缺少显式的异常注入测试
8. **审计事件 ip_address 透过 X-Forwarded-For**（E2E-09, IT-12）— plan 的 Task 3 步骤 3.5 写了审计代码但没测 TRUST_PROXY 场景
9. **PR1 回归**（E2E-11）— plan 的 Task 8 Step 8.2 只要求"全 PASS"，本文档把"PR1 零回归"作为显式测试项

建议 PR2 实施者在 `tests/advisor-guard-bash.test.ts` / `tests/advisor-guard.test.ts` 中补齐以上角度。

---

**文档结束**
