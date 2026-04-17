# Multi-Agent PR2 Implementation Plan — advisor 写保护 + Hook + scratch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 v3 设计文档 §5.6 的 advisor 写保护能力：通过 SDK PreToolUse Hook 拦截 advisor Bot 对项目目录的任何写操作，同时提供 scratch 可写空间、per-bot CLAUDE.md 角色文件管理。本 PR 交付后 advisor Bot 才真正"只读"。

**Architecture:** 在 `container/agent-runner/` 新增 `advisor-guard.ts` 实现 PreToolUse Hook；`container-runner.ts` 增加 `/workspace/bot-profile`（ro）和 `/workspace/scratch`（rw）挂载，并通过 `HAPPYCLAW_BOT_MODE` 环境变量传递 concurrency_mode；后端新增 GET/PUT `/api/bots/:id/profile` 提供 per-bot CLAUDE.md 编辑（含路径遍历防护）。失败模式一律 **fail-closed**。

**Tech Stack:** TypeScript · `@anthropic-ai/claude-agent-sdk` Hook API（已确认：`sdk.d.ts:1675` 的 `PreToolUseHookInput`）· Hono · Vitest

**设计依据：** `docs/superpowers/specs/2026-04-17-multi-agent-design-v3.md` §5.6、§6.1、§7.4、§7.5、§8.3。前置依赖 PR1（已合并）。

---

## PR2 范围清单（参考 v3 附录 E 第 2 条）

- ✅ PreToolUse Hook 实现（`advisor-guard.ts`）
- ✅ `bot-profile` 目录挂载 + 路径遍历防护
- ✅ `scratch` 目录挂载（per-bot）
- ✅ `concurrency_mode` 字段**实际启用**（PR1 已入库，本 PR 让它生效）
- ✅ advisor / writer 默认 CLAUDE.md 模板
- ✅ GET/PUT `/api/bots/:id/profile` API
- ❌ 前端 UI（`/bots` 页、profile 编辑器）→ PR3
- ❌ scratch 自动 GC → PR3
- ❌ 监控指标（hook_invocations / hook_denies）→ PR3
- ❌ advisor 并发（worktree 机制）→ 后续版本

---

## 文件结构

### 新增文件

- `src/bot-profile-manager.ts` — Bot profile CLAUDE.md 的读写（含路径校验 + 默认模板）
- `container/agent-runner/src/advisor-guard.ts` — PreToolUse Hook 实现
- `tests/bot-profile-manager.test.ts` — profile 读写 + 路径遍历防御
- `tests/advisor-guard.test.ts` — Hook 拦截逻辑（Write/Edit/Bash）
- `tests/advisor-guard-bash.test.ts` — Bash 命令解析边界用例
- `tests/bot-profile-api.test.ts` — HTTP API + 权限 + 路径防御
- `tests/pr2-smoke.test.ts` — 端到端冒烟

### 修改文件

- `src/routes/bots.ts` — 追加 `GET/PUT /api/bots/:id/profile`
- `src/schemas.ts` — 追加 `UpdateBotProfileSchema`
- `src/container-runner.ts` — 新增 `/workspace/bot-profile`、`/workspace/scratch` 挂载 + `HAPPYCLAW_BOT_MODE` 注入
- `src/index.ts` — 调用 container-runner 时透传 bot 的 concurrency_mode
- `container/agent-runner/src/index.ts` — 从环境变量读 `HAPPYCLAW_BOT_MODE`，advisor 时注册 `PreToolUse` hook

---

## 并发波形（Subagent-Driven）

| Wave | 并行 Agent | Tasks | 文件 |
|------|-----------|-------|------|
| **W1** 基础 | 3 | T1 profile manager / T2 advisor-guard / T3 bot-profile API | 3 组独立新文件 |
| **W2** 集成 | 2 | T4 container-runner / T5 agent-runner | container-runner.ts \| agent-runner/index.ts |
| **W3** 测试+文档 | 2 | T6 E2E smoke / T7 docs | 新 test \| CLAUDE.md |
| **W4** 收尾 | 1 | T8 回归+PR | - |

估时：~90 min（相比串行 ~180 min，节省 50%）。

---

## Task 1：Bot profile manager + 默认模板

**目标：** 提供 Bot 的 CLAUDE.md 读写函数（带路径遍历防御 + 默认模板）。纯 server 侧模块，不依赖 Hono Context。

**Files:**
- Create: `src/bot-profile-manager.ts`
- Test: `tests/bot-profile-manager.test.ts`

- [ ] **Step 1.1：写失败测试**

```typescript
// tests/bot-profile-manager.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('bot-profile-manager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-mgr-'));
    process.env.DATA_DIR = tmpDir;
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readProfile returns default template when file absent', async () => {
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile('bot_abc12345', 'writer');
    expect(content).toContain('# 角色定义');
  });

  test('readProfile returns advisor template when mode=advisor and no file', async () => {
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile('bot_abc12345', 'advisor');
    expect(content).toContain('advisor');
    expect(content).toContain('/workspace/scratch');
  });

  test('writeProfile creates file at data/bot-profiles/{botId}/CLAUDE.md', async () => {
    const { writeBotProfile, readBotProfile } = await import('../src/bot-profile-manager.js');
    writeBotProfile('bot_abc12345', '# Custom role\n\nHello.');
    const loaded = readBotProfile('bot_abc12345', 'writer');
    expect(loaded).toBe('# Custom role\n\nHello.');
  });

  test('validateBotId rejects path traversal', async () => {
    const { writeBotProfile } = await import('../src/bot-profile-manager.js');
    expect(() => writeBotProfile('../../etc', 'hack')).toThrow(/invalid bot id/i);
    expect(() => writeBotProfile('bot_../foo', 'hack')).toThrow(/invalid bot id/i);
    expect(() => writeBotProfile('bot_a', 'hack')).toThrow(/invalid bot id/i); // too short
  });

  test('getProfileMountPath returns expected abs path', async () => {
    const { getProfileMountPath } = await import('../src/bot-profile-manager.js');
    const p = getProfileMountPath('bot_abc12345');
    expect(p).toBe(path.join(tmpDir, 'bot-profiles', 'bot_abc12345'));
  });

  test('ensureProfileExists writes template only if missing', async () => {
    const { ensureProfileExists } = await import('../src/bot-profile-manager.js');
    const created = ensureProfileExists('bot_abc12345', 'advisor');
    expect(created).toBe(true);
    // 第二次调用不覆盖
    const recreated = ensureProfileExists('bot_abc12345', 'writer');
    expect(recreated).toBe(false);
  });
});
```

- [ ] **Step 1.2：跑测试确认 FAIL**

```bash
npx vitest run tests/bot-profile-manager.test.ts
```

- [ ] **Step 1.3：实现 `src/bot-profile-manager.ts`**

```typescript
/**
 * Bot Profile Manager
 *
 * 管理 per-bot 角色 CLAUDE.md 文件的读写、默认模板生成、路径遍历防御。
 * 路径：data/bot-profiles/{botId}/CLAUDE.md
 *
 * 设计参考 docs/superpowers/specs/2026-04-17-multi-agent-design-v3.md §6.1, §7.5, §8.3
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import type { BotConcurrencyMode } from './types.js';
import { logger } from './logger.js';

const BOT_ID_PATTERN = /^bot_[a-zA-Z0-9_-]{8,}$/;

export class InvalidBotIdError extends Error {
  constructor(botId: string) {
    super(`invalid bot id: ${botId}`);
  }
}

/** 校验并返回安全的绝对路径，抛出 `InvalidBotIdError` 若 botId 非法 */
function safeProfilePath(botId: string): string {
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new InvalidBotIdError(botId);
  }
  const baseDir = path.resolve(DATA_DIR, 'bot-profiles');
  const target = path.resolve(baseDir, botId);
  // 双层防御：resolve 后必须仍在 baseDir 下
  if (!target.startsWith(baseDir + path.sep)) {
    throw new InvalidBotIdError(botId);
  }
  return target;
}

/** 仅返回目录路径（供 container-runner 挂载用） */
export function getProfileMountPath(botId: string): string {
  return safeProfilePath(botId);
}

/** 默认 writer 模板 */
function writerTemplate(): string {
  return `# 角色定义
你是一位工作区协作 Bot。

## 职责范围
- （在此描述你负责的工作）

## 协作准则
- 响应前先查看群聊近期记录，了解上下文
- 与其他 Agent 协作时，明确自己的工作边界
`;
}

/** 默认 advisor 模板（强调只读边界） */
function advisorTemplate(): string {
  return `# 角色定义（advisor）
你是一位工作区 advisor Bot，以**只读方式**访问项目目录 /workspace/group。

## 重要约束
- **禁止修改 /workspace/group 下的任何文件**（Hook 会拦截）
- 所有写入必须落在 /workspace/scratch 或 /tmp
- **禁止执行会修改项目文件的 subprocess**（如 python script.py 内部 open(w)；改用纯读模式分析）
- Hook 会拦截 SDK 工具写入，但 subprocess 内部 syscall 不被覆盖——请主动遵守此规则

## 职责范围
- （在此描述你负责的评审 / 分析 / 研究工作）

## 输出建议
- 落盘报告请写到 /workspace/scratch（跨会话持久保留）
- 临时计算请写到 /tmp
`;
}

export function readBotProfile(
  botId: string,
  mode: BotConcurrencyMode,
): string {
  const dir = safeProfilePath(botId);
  const file = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(file)) {
    return mode === 'advisor' ? advisorTemplate() : writerTemplate();
  }
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to read bot profile, returning default');
    return mode === 'advisor' ? advisorTemplate() : writerTemplate();
  }
}

export function writeBotProfile(botId: string, content: string): void {
  const dir = safeProfilePath(botId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'CLAUDE.md');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

/** 若 profile 不存在则写入默认模板；返回是否新建 */
export function ensureProfileExists(
  botId: string,
  mode: BotConcurrencyMode,
): boolean {
  const dir = safeProfilePath(botId);
  const file = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, mode === 'advisor' ? advisorTemplate() : writerTemplate(), 'utf-8');
  fs.renameSync(tmp, file);
  return true;
}

export function deleteBotProfile(botId: string): void {
  try {
    const dir = safeProfilePath(botId);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, botId }, 'Failed to delete bot profile directory');
  }
}
```

- [ ] **Step 1.4：跑测试确认 PASS**

```bash
npx vitest run tests/bot-profile-manager.test.ts
```

Expected: 6/6 PASS

- [ ] **Step 1.5：commit**

```bash
git add src/bot-profile-manager.ts tests/bot-profile-manager.test.ts
git commit -m "feat: Multi-Agent PR2 - Bot Profile Manager + 默认模板 + 路径遍历防御"
```

---

## Task 2：advisor-guard PreToolUse Hook

**目标：** 实现 `container/agent-runner/src/advisor-guard.ts`，拦截 advisor Bot 的所有项目目录写操作。纯函数设计，便于测试。

**Files:**
- Create: `container/agent-runner/src/advisor-guard.ts`
- Test: `tests/advisor-guard.test.ts`
- Test: `tests/advisor-guard-bash.test.ts`

- [ ] **Step 2.1：写失败测试（纯工具覆盖）**

```typescript
// tests/advisor-guard.test.ts
import { describe, expect, test } from 'vitest';
import { evaluateToolCall } from '../container/agent-runner/src/advisor-guard.js';

const PROJECT_ROOT = '/workspace/group';
const SCRATCH = '/workspace/scratch';

describe('advisor-guard: Write/Edit/NotebookEdit', () => {
  test('denies Write to project root', () => {
    const r = evaluateToolCall({
      name: 'Write',
      input: { file_path: '/workspace/group/src/foo.ts', content: 'x' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/禁止写入项目目录/);
  });

  test('denies Write to nested project path', () => {
    const r = evaluateToolCall({
      name: 'Write',
      input: { file_path: '/workspace/group/src/a/b/c.ts', content: '' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('deny');
  });

  test('allows Write to scratch', () => {
    const r = evaluateToolCall({
      name: 'Write',
      input: { file_path: '/workspace/scratch/report.md', content: '' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('allow');
  });

  test('allows Write to /tmp', () => {
    const r = evaluateToolCall({
      name: 'Write',
      input: { file_path: '/tmp/x.txt', content: '' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('allow');
  });

  test('denies Edit to project file', () => {
    const r = evaluateToolCall({
      name: 'Edit',
      input: { file_path: '/workspace/group/a.ts', old_string: '', new_string: '' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('deny');
  });

  test('denies NotebookEdit to project ipynb', () => {
    const r = evaluateToolCall({
      name: 'NotebookEdit',
      input: { notebook_path: '/workspace/group/a.ipynb' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('deny');
  });

  test('path traversal ../../etc → resolved still blocked', () => {
    const r = evaluateToolCall({
      name: 'Write',
      input: { file_path: '/workspace/group/../group/src/x.ts', content: '' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('deny');
  });

  test('unknown read-only tool is allowed', () => {
    const r = evaluateToolCall({
      name: 'Read',
      input: { file_path: '/workspace/group/a.ts' },
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('allow');
  });

  test('malformed input defaults to deny (fail-closed)', () => {
    const r = evaluateToolCall({
      name: 'Write',
      input: null,
      projectRoot: PROJECT_ROOT,
    });
    expect(r.decision).toBe('deny');
  });
});
```

```typescript
// tests/advisor-guard-bash.test.ts
import { describe, expect, test } from 'vitest';
import { evaluateBashCommand } from '../container/agent-runner/src/advisor-guard.js';

const ROOT = '/workspace/group';

describe('advisor-guard: Bash', () => {
  test.each([
    ['echo x > /workspace/group/a', 'deny'],
    ['cat a >> /workspace/group/b', 'deny'],
    ['tee /workspace/group/x', 'deny'],
    ['tee -a /workspace/group/x', 'deny'],
    ['rm /workspace/group/a', 'deny'],
    ['mv /workspace/scratch/x /workspace/group/', 'deny'],
    ['cp a /workspace/group/b', 'deny'],
    ['sed -i s/a/b/ /workspace/group/a', 'deny'],
    ['git commit -m x', 'deny'],
    ['git push', 'deny'],
    ['git reset --hard', 'deny'],
    ['git checkout main', 'deny'],
    ['ls /workspace/group', 'allow'],
    ['cat /workspace/group/a', 'allow'],
    ['grep foo /workspace/group/a', 'allow'],
    ['echo x > /workspace/scratch/a', 'allow'],
    ['echo x > /tmp/a', 'allow'],
    ['rm /tmp/a', 'allow'],
    ['git status', 'allow'],
    ['git diff', 'allow'],
    ['git log', 'allow'],
  ])('command %j → %s', (cmd, expected) => {
    const r = evaluateBashCommand(cmd, ROOT);
    expect(r.decision).toBe(expected);
  });

  test('compound command with pipe to project target blocked', () => {
    const r = evaluateBashCommand('cat a.txt | tee /workspace/group/b', ROOT);
    expect(r.decision).toBe('deny');
  });

  test('empty command defaults to deny (fail-closed)', () => {
    const r = evaluateBashCommand('', ROOT);
    expect(r.decision).toBe('deny');
  });
});
```

- [ ] **Step 2.2：跑测试确认 FAIL**

```bash
npx vitest run tests/advisor-guard.test.ts tests/advisor-guard-bash.test.ts
```

- [ ] **Step 2.3：实现 `container/agent-runner/src/advisor-guard.ts`**

```typescript
/**
 * Advisor Guard: PreToolUse Hook for advisor-mode bots.
 *
 * Intercepts all write tool calls (Write/Edit/NotebookEdit/Bash) to block
 * mutations of the project directory. Allowed write destinations:
 *   - /workspace/scratch (per-bot persistent scratch)
 *   - /tmp (ephemeral)
 *   - /home/node/.claude (SDK session state)
 *   - /workspace/bot-profile (ro by design; attempts will 404 at fs level)
 *
 * 设计参考 v3 §5.6.3 (PreToolUse Hook 详细设计)。
 *
 * fail-closed: unknown tool or malformed input → deny.
 */
import path from 'path';
import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

export type Decision = 'allow' | 'deny';

export interface GuardResult {
  decision: Decision;
  reason?: string;
}

interface EvaluateInput {
  name: string;
  input: unknown;
  projectRoot: string;
}

/** 命令中的写类操作 pattern（启发式，全大小写敏感） */
const BASH_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|[|&;])\s*[^|&;]*>\s*(\S+)/g,           // 重定向 >
  /(?:^|[|&;])\s*[^|&;]*>>\s*(\S+)/g,          // 追加 >>
  /\btee(?:\s+-a)?\s+(\S+)/g,                  // tee
  /\bmv\s+(?:\S+\s+)+(\S+)$/gm,                // mv X Y ... target
  /\brm\s+(?:-[rfRF]+\s+)*(\S+)/g,             // rm
  /\bcp\s+(?:-[rfpRFP]+\s+)*\S+\s+(\S+)/g,     // cp
  /\bsed\s+-i\b.*?\s+(\S+)$/gm,                // sed -i
];

const BASH_GIT_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+(?:restore|revert)\b/,
];

function isProjectPath(p: string, root: string): boolean {
  if (!p) return false;
  // 处理相对路径：无法判定时视为高危（fail-closed）
  if (!path.isAbsolute(p)) {
    // advisor 的 cwd 通常是 /workspace/group，相对路径 = 项目路径
    return true;
  }
  const resolved = path.resolve(p);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function checkFilePathInput(
  filePath: unknown,
  root: string,
): GuardResult {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { decision: 'deny', reason: '无法解析路径参数，advisor 模式拒绝以确保安全' };
  }
  if (isProjectPath(filePath, root)) {
    return {
      decision: 'deny',
      reason: `禁止写入项目目录 ${root}。advisor 角色应写入 /workspace/scratch 或 /tmp。`,
    };
  }
  return { decision: 'allow' };
}

export function evaluateBashCommand(
  cmd: string,
  projectRoot: string,
): GuardResult {
  if (!cmd || typeof cmd !== 'string') {
    return { decision: 'deny', reason: 'Bash 命令为空，拒绝以保证安全' };
  }

  // 1. git 写类命令（不看路径，因为 cwd 会在项目目录下时默认影响项目）
  for (const pat of BASH_GIT_WRITE_PATTERNS) {
    if (pat.test(cmd)) {
      return {
        decision: 'deny',
        reason: `advisor 禁止执行 git 修改操作（cmd: ${cmd.slice(0, 80)}）`,
      };
    }
  }

  // 2. 重定向 / 文件写入 / sed -i / mv / rm / cp / tee
  for (const pat of BASH_WRITE_PATTERNS) {
    const re = new RegExp(pat.source, pat.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
      const target = m[m.length - 1];
      if (target && isProjectPath(target, projectRoot)) {
        return {
          decision: 'deny',
          reason: `Bash 命令将写入项目目录 (${target})，advisor 禁止。请改写 /workspace/scratch 或 /tmp`,
        };
      }
    }
  }

  return { decision: 'allow' };
}

/**
 * 对单个 tool call 决策。纯函数，便于单测。
 */
export function evaluateToolCall({ name, input, projectRoot }: EvaluateInput): GuardResult {
  if (!input || typeof input !== 'object') {
    return { decision: 'deny', reason: 'tool 参数缺失或非对象，fail-closed' };
  }
  const inp = input as Record<string, unknown>;

  switch (name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return checkFilePathInput(inp.file_path, projectRoot);

    case 'NotebookEdit':
      return checkFilePathInput(inp.notebook_path ?? inp.file_path, projectRoot);

    case 'Bash': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      return evaluateBashCommand(cmd, projectRoot);
    }

    // 其他 MCP 工具默认放行；若 input 明显含 path 字段且落在项目目录则拒绝
    default:
      if (typeof inp.file_path === 'string' && isProjectPath(inp.file_path, projectRoot)) {
        return {
          decision: 'deny',
          reason: `工具 ${name} 的 file_path 落在项目目录，advisor 禁止`,
        };
      }
      return { decision: 'allow' };
  }
}

/**
 * 创建 SDK PreToolUse Hook，供 agent-runner 注册。
 * fail-closed: 内部异常 → 拒绝。
 */
export function createAdvisorGuardHook(projectRoot: string): HookCallback {
  return async (input, _toolUseID, _options) => {
    const h = input as PreToolUseHookInput;
    try {
      const result = evaluateToolCall({
        name: h.tool_name,
        input: h.tool_input,
        projectRoot,
      });
      if (result.decision === 'deny') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny',
            permissionDecisionReason: result.reason ?? 'advisor 拒绝',
          },
        };
      }
      return {};
    } catch (err) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny',
          permissionDecisionReason: `advisor-guard 内部异常，拒绝以保证安全: ${String(err)}`,
        },
      };
    }
  };
}
```

- [ ] **Step 2.4：跑测试确认 PASS**

```bash
npx vitest run tests/advisor-guard.test.ts tests/advisor-guard-bash.test.ts
```

Expected: 10 + 20+ PASS

- [ ] **Step 2.5：commit**

```bash
git add container/agent-runner/src/advisor-guard.ts tests/advisor-guard.test.ts tests/advisor-guard-bash.test.ts
git commit -m "feat: Multi-Agent PR2 - advisor-guard PreToolUse Hook 实现（纯函数 + 集成 SDK）"
```

---

## Task 3：Bot profile HTTP API

**目标：** 在 `src/routes/bots.ts` 追加 GET/PUT `/api/bots/:id/profile`，复用 PR1 的 `authorizeBot` 中间件和 PR2-T1 的 `bot-profile-manager`。

**Files:**
- Modify: `src/routes/bots.ts`
- Modify: `src/schemas.ts`
- Test: `tests/bot-profile-api.test.ts`

- [ ] **Step 3.1：写失败测试**

```typescript
// tests/bot-profile-api.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// 跟 PR1 的 bot-permissions.test.ts 同款 bootstrap

let tmpDir: string;

async function bootstrap() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr2-api-'));
  process.env.DATA_DIR = tmpDir;
  const { initDatabase, getDb } = await import('../src/db.js');
  initDatabase(path.join(tmpDir, 'test.db'));
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
     VALUES ('u_alice','alice','x','member','[]','active',?,?),
            ('u_bob','bob','x','member','[]','active',?,?),
            ('u_admin','admin','x','admin','[]','active',?,?)`,
  ).run(now, now, now, now, now, now);
}

describe('Bot profile API', () => {
  beforeEach(async () => {
    await bootstrap();
  });
  afterEach(async () => {
    const { closeDatabase } = await import('../src/db.js');
    closeDatabase();
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('GET returns default template for new bot', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({
      user_id: 'u_alice',
      name: 'A',
      channel: 'feishu',
      concurrency_mode: 'advisor',
    });
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile(bot.id, 'advisor');
    expect(content).toContain('advisor');
  });

  test('PUT saves content and GET reads back', async () => {
    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({ user_id: 'u_alice', name: 'A', channel: 'feishu' });
    const { writeBotProfile, readBotProfile } = await import('../src/bot-profile-manager.js');
    writeBotProfile(bot.id, '# Custom\n\nHello');
    expect(readBotProfile(bot.id, 'writer')).toBe('# Custom\n\nHello');
  });

  test('writeBotProfile rejects path traversal via botId', async () => {
    const { writeBotProfile, InvalidBotIdError } = await import('../src/bot-profile-manager.js');
    expect(() => writeBotProfile('../etc/passwd', '')).toThrow(InvalidBotIdError);
    expect(() => writeBotProfile('bot_..%2F', '')).toThrow(InvalidBotIdError);
  });
});
```

- [ ] **Step 3.2：跑测试确认 FAIL**

```bash
npx vitest run tests/bot-profile-api.test.ts
```

(除了 traversal 测试可能已经通过因为 T1 已交付)

- [ ] **Step 3.3：扩展 `src/schemas.ts`**

```typescript
// 在现有 Bot schemas 后追加
export const UpdateBotProfileSchema = z.object({
  content: z.string().max(64 * 1024),  // 64KB 上限
});
```

- [ ] **Step 3.4：追加 `src/routes/bots.ts` 的两个端点**

在 `botsRoutes` 末尾追加（放在 `removeBinding` 端点后）：

```typescript
import {
  readBotProfile,
  writeBotProfile,
  InvalidBotIdError,
} from '../bot-profile-manager.js';
import { UpdateBotProfileSchema } from '../schemas.js';

// GET /api/bots/:id/profile
botsRoutes.get('/:id/profile', authorizeBot, async (c) => {
  const bot = c.get('bot');
  try {
    const content = readBotProfile(bot.id, bot.concurrency_mode);
    return c.json({ content, mode: bot.concurrency_mode });
  } catch (err) {
    if (err instanceof InvalidBotIdError) return c.json({ error: 'invalid bot id' }, 400);
    throw err;
  }
});

// PUT /api/bots/:id/profile
botsRoutes.put('/:id/profile', authorizeBot, async (c) => {
  const user = c.get('user');
  const bot = c.get('bot');
  const body = await c.req.json();
  const parsed = UpdateBotProfileSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

  try {
    writeBotProfile(bot.id, parsed.data.content);
  } catch (err) {
    if (err instanceof InvalidBotIdError) return c.json({ error: 'invalid bot id' }, 400);
    throw err;
  }

  logAuthEvent({
    event_type: 'bot_profile_updated',  // 需在 types.ts 新增此事件类型
    username: user.username,
    actor_username: user.username,
    details: { bot_id: bot.id },
    ip_address: c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
  });

  return c.json({ success: true });
});
```

- [ ] **Step 3.5：扩展 `src/types.ts` AuthEventType**

```typescript
// 追加到 AuthEventType 联合
  | 'bot_profile_updated'
```

- [ ] **Step 3.6：跑测试确认 PASS**

```bash
npx vitest run tests/bot-profile-api.test.ts
```

- [ ] **Step 3.7：commit**

```bash
git add src/routes/bots.ts src/schemas.ts src/types.ts tests/bot-profile-api.test.ts
git commit -m "feat: Multi-Agent PR2 - GET/PUT /api/bots/:id/profile API（路径防御 + 审计）"
```

---

## Task 4：container-runner 挂载 bot-profile + scratch + HAPPYCLAW_BOT_MODE

**目标：** 让容器启动时：
1. 创建 scratch 目录（per-bot per-folder）
2. 创建 bot-profile 目录（per-bot，如未存在则写默认模板）
3. 挂载 `/workspace/bot-profile`（ro）和 `/workspace/scratch`（rw）
4. 注入环境变量 `HAPPYCLAW_BOT_MODE`（由 concurrency_mode 决定）
5. 宿主机模式下把路径作为环境变量传给 agent-runner 进程（因为宿主机不做 docker mount）

**Files:**
- Modify: `src/container-runner.ts`
- Test: `tests/container-runner-bot-mounts.test.ts`（新）

- [ ] **Step 4.1：定位现有挂载逻辑**

```bash
grep -n "volume\|mount\|'-v'\|/workspace" src/container-runner.ts | head -30
```

找到现有的 docker run 参数构造 + 宿主机模式的环境变量注入点。

- [ ] **Step 4.2：写纯函数测试（不跑真实容器）**

```typescript
// tests/container-runner-bot-mounts.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('container-runner: bot mounts builder', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mnt-'));
    process.env.DATA_DIR = tmpDir;
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('buildBotMounts returns scratch + profile paths', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m = buildBotMounts({
      folder: 'alpha',
      botId: 'bot_abc12345',
      mode: 'advisor',
    });
    expect(m.scratchHost).toBe(path.join(tmpDir, 'scratch', 'alpha', 'bots', 'bot_abc12345'));
    expect(m.profileHost).toBe(path.join(tmpDir, 'bot-profiles', 'bot_abc12345'));
    expect(m.botMode).toBe('advisor');
    // 目录已创建
    expect(fs.existsSync(m.scratchHost)).toBe(true);
    expect(fs.existsSync(m.profileHost)).toBe(true);
    // advisor 模板已写入
    expect(fs.existsSync(path.join(m.profileHost, 'CLAUDE.md'))).toBe(true);
  });

  test('buildBotMounts returns null when botId empty (PR1 legacy path)', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m = buildBotMounts({
      folder: 'alpha',
      botId: '',
      mode: 'writer',
    });
    expect(m).toBeNull();
  });

  test('buildBotMounts writes writer template for writer mode', async () => {
    const { buildBotMounts } = await import('../src/container-runner.js');
    const m = buildBotMounts({
      folder: 'alpha',
      botId: 'bot_xyz12345',
      mode: 'writer',
    });
    const content = fs.readFileSync(path.join(m!.profileHost, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('advisor');
    expect(content).toContain('协作准则');
  });
});
```

- [ ] **Step 4.3：跑测试确认 FAIL**

```bash
npx vitest run tests/container-runner-bot-mounts.test.ts
```

- [ ] **Step 4.4：实现 `buildBotMounts`**

在 `src/container-runner.ts` 追加（放在工具函数区）：

```typescript
import { DATA_DIR } from './config.js';
import {
  ensureProfileExists,
  getProfileMountPath,
} from './bot-profile-manager.js';
import type { BotConcurrencyMode } from './types.js';

export interface BotMountInfo {
  scratchHost: string;
  profileHost: string;
  botMode: BotConcurrencyMode;
}

export interface BotMountInput {
  folder: string;
  botId: string;
  mode: BotConcurrencyMode;
}

/**
 * 为 Bot 构建 scratch 和 bot-profile 挂载目录。
 *
 * - 返回 null 表示老路径（无 bot_id），不做 PR2 挂载
 * - 否则 mkdir scratch + ensureProfileExists（若不存在则写默认模板）
 */
export function buildBotMounts(input: BotMountInput): BotMountInfo | null {
  if (!input.botId) return null;

  const scratchHost = path.join(DATA_DIR, 'scratch', input.folder, 'bots', input.botId);
  fs.mkdirSync(scratchHost, { recursive: true });

  const profileHost = getProfileMountPath(input.botId);
  ensureProfileExists(input.botId, input.mode);

  return {
    scratchHost,
    profileHost,
    botMode: input.mode,
  };
}
```

- [ ] **Step 4.5：在 docker run 参数构造处挂载（容器模式）**

定位 docker run 参数组装函数（`grep -n "docker.*run\|dockerArgs" src/container-runner.ts`）。在现有 `/workspace/group` 挂载之后追加：

```typescript
if (botMounts) {
  dockerArgs.push('-v', `${botMounts.scratchHost}:/workspace/scratch:rw`);
  dockerArgs.push('-v', `${botMounts.profileHost}:/workspace/bot-profile:ro`);
  dockerArgs.push('-e', `HAPPYCLAW_BOT_MODE=${botMounts.botMode}`);
  dockerArgs.push('-e', `HAPPYCLAW_BOT_ID=${input.botId}`);  // agent-runner 会用到
}
```

- [ ] **Step 4.6：在宿主机模式启动处传递环境变量**

定位宿主机模式（`executionMode === 'host'`）的 env 构造。追加：

```typescript
if (botMounts) {
  env.HAPPYCLAW_BOT_MODE = botMounts.botMode;
  env.HAPPYCLAW_BOT_ID = input.botId;
  env.HAPPYCLAW_SCRATCH_DIR = botMounts.scratchHost;  // 宿主机无 docker 挂载，直接暴露路径
  env.HAPPYCLAW_BOT_PROFILE_DIR = botMounts.profileHost;
}
```

- [ ] **Step 4.7：调用入口处传 botId 和 concurrency_mode**

`runContainerAgent` 或等价入口函数签名扩展：

```typescript
export interface RunContainerInput {
  // existing fields ...
  botId?: string;                       // ← 新增（PR1 已在 queue 里传递）
  concurrencyMode?: BotConcurrencyMode; // ← 新增
}
```

在函数体 docker/host 分支前统一调用：

```typescript
const botMounts = buildBotMounts({
  folder: input.folder,
  botId: input.botId ?? '',
  mode: input.concurrencyMode ?? 'writer',
});
```

- [ ] **Step 4.8：跑纯函数测试确认 PASS**

```bash
npx vitest run tests/container-runner-bot-mounts.test.ts
```

- [ ] **Step 4.9：commit**

```bash
git add src/container-runner.ts tests/container-runner-bot-mounts.test.ts
git commit -m "feat: Multi-Agent PR2 - container-runner 挂载 bot-profile/scratch + HAPPYCLAW_BOT_MODE"
```

---

## Task 5：agent-runner 注册 PreToolUse Hook

**目标：** 让 `container/agent-runner/src/index.ts` 读取 `HAPPYCLAW_BOT_MODE`，`advisor` 模式下注册 `createAdvisorGuardHook`，同时把 bot-profile 的 CLAUDE.md 内容作为 `customSystemPrompt` 前缀注入。

**Files:**
- Modify: `container/agent-runner/src/index.ts`
- Test: `tests/agent-runner-hook-registration.test.ts`（纯函数 glue test）

- [ ] **Step 5.1：写纯函数测试**

```typescript
// tests/agent-runner-hook-registration.test.ts
import { describe, expect, test, vi } from 'vitest';

describe('agent-runner: advisor hook registration', () => {
  test('buildHooksConfig returns PreToolUse hook only in advisor mode', async () => {
    const { buildHooksConfig } = await import(
      '../container/agent-runner/src/index.js'
    );
    const writer = buildHooksConfig({
      botMode: 'writer',
      projectRoot: '/workspace/group',
      preCompactHook: vi.fn(),
    });
    expect(writer.PreToolUse).toBeUndefined();
    expect(writer.PreCompact).toBeDefined();

    const advisor = buildHooksConfig({
      botMode: 'advisor',
      projectRoot: '/workspace/group',
      preCompactHook: vi.fn(),
    });
    expect(advisor.PreToolUse).toBeDefined();
    expect(advisor.PreToolUse).toHaveLength(1);
    expect(advisor.PreCompact).toBeDefined();
  });

  test('resolveBotModeFromEnv reads HAPPYCLAW_BOT_MODE or defaults to writer', async () => {
    const { resolveBotModeFromEnv } = await import(
      '../container/agent-runner/src/index.js'
    );
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: 'advisor' })).toBe('advisor');
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: 'writer' })).toBe('writer');
    expect(resolveBotModeFromEnv({})).toBe('writer');
    expect(resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: 'bogus' })).toBe('writer');
  });
});
```

- [ ] **Step 5.2：跑测试确认 FAIL**

```bash
npx vitest run tests/agent-runner-hook-registration.test.ts
```

- [ ] **Step 5.3：实现 `buildHooksConfig` + `resolveBotModeFromEnv`**

在 `container/agent-runner/src/index.ts` 顶部附近（`createPreCompactHook` 定义之后）：

```typescript
import { createAdvisorGuardHook } from './advisor-guard.js';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

export type BotMode = 'writer' | 'advisor';

export function resolveBotModeFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): BotMode {
  const raw = env.HAPPYCLAW_BOT_MODE;
  return raw === 'advisor' ? 'advisor' : 'writer';
}

export interface HooksConfigInput {
  botMode: BotMode;
  projectRoot: string;
  preCompactHook: HookCallback;
}

export function buildHooksConfig(input: HooksConfigInput) {
  const hooks: Record<string, Array<{ hooks: HookCallback[] }>> = {
    PreCompact: [{ hooks: [input.preCompactHook] }],
  };
  if (input.botMode === 'advisor') {
    hooks.PreToolUse = [{ hooks: [createAdvisorGuardHook(input.projectRoot)] }];
  }
  return hooks;
}
```

- [ ] **Step 5.4：修改 query() 调用位置**

找到 `container/agent-runner/src/index.ts:1253` 附近的 `hooks:` 字段，替换为：

```typescript
hooks: buildHooksConfig({
  botMode: resolveBotModeFromEnv(process.env),
  projectRoot: process.env.HAPPYCLAW_PROJECT_ROOT ?? '/workspace/group',
  preCompactHook: createPreCompactHook(isHome, isAdminHome, {
    emit,
    getFullText: () => processor.getFullText(),
    resetFullText: () => processor.resetFullTextAccumulator(),
  }),
}),
```

- [ ] **Step 5.5：注入 bot-profile CLAUDE.md 作为 customSystemPrompt 前缀**

在 query() 调用前：

```typescript
let botProfilePrefix = '';
try {
  const botProfileDir = process.env.HAPPYCLAW_BOT_PROFILE_DIR ?? '/workspace/bot-profile';
  const profileFile = path.join(botProfileDir, 'CLAUDE.md');
  if (fs.existsSync(profileFile)) {
    botProfilePrefix = fs.readFileSync(profileFile, 'utf-8');
  }
} catch (err) {
  log(`failed to read bot-profile CLAUDE.md: ${err}`);
}
```

然后把 `botProfilePrefix` 拼到 `customSystemPrompt`（如果项目已有此字段）或作为 system prompt 插入的首条附加 context。**具体拼接位置由现有 query() 的 `customSystemPrompt` / `systemPrompt` 结构决定，实施时 grep 确认。**

- [ ] **Step 5.6：跑测试确认 PASS**

```bash
npx vitest run tests/agent-runner-hook-registration.test.ts
```

- [ ] **Step 5.7：编译 agent-runner**

```bash
npm --prefix container/agent-runner run build
```

Expected: 无 TS 错误

- [ ] **Step 5.8：commit**

```bash
git add container/agent-runner/src/index.ts tests/agent-runner-hook-registration.test.ts
git commit -m "feat: Multi-Agent PR2 - agent-runner 注册 PreToolUse Hook + bot-profile 注入 systemPrompt"
```

---

## Task 6：index.ts 透传 concurrency_mode 到 container-runner

**目标：** 让 `src/index.ts` 在调用 runContainerAgent 时把 Bot 的 concurrency_mode 和 botId 传进去（PR1 已经在 queue 层传 botId，但还没进 container-runner）。

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 6.1：定位 runContainerAgent 调用点**

```bash
grep -n "runContainerAgent\|runAgent" src/index.ts | head -10
```

- [ ] **Step 6.2：在入队/出队处携带 bot 信息**

找到从 queue pop 出消息后调 runContainerAgent 的地方。扩展：

```typescript
const bot = target.botId ? getBotById(target.botId) : null;
await runContainerAgent({
  ...existingParams,
  botId: target.botId || undefined,
  concurrencyMode: bot?.concurrency_mode ?? 'writer',
});
```

其中 `target` 来自 Task 11（PR1）的 `resolveRouteTarget` 结果。

- [ ] **Step 6.3：类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "src/index.ts"
```

Expected: 无新增错误

- [ ] **Step 6.4：commit**

```bash
git add src/index.ts
git commit -m "feat: Multi-Agent PR2 - index.ts 透传 concurrency_mode 到 container-runner"
```

---

## Task 7：端到端冒烟 + 文档

### 7.1 E2E smoke

**Files:**
- Test: `tests/pr2-smoke.test.ts`

- [ ] **Step 7.1.1：写冒烟测试**

```typescript
// tests/pr2-smoke.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('PR2 smoke: advisor bot end-to-end glue', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr2-smoke-'));
    process.env.DATA_DIR = tmpDir;
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('advisor bot: profile created, mounts built, hook registered', async () => {
    const { initDatabase, getDb } = await import('../src/db.js');
    initDatabase(path.join(tmpDir, 'test.db'));
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO users (id, username, password_hash, role, permissions, status, created_at, updated_at)
       VALUES ('u1','alice','x','member','[]','active',?,?)`,
    ).run(now, now);

    const { createBot } = await import('../src/db-bots.js');
    const bot = createBot({
      user_id: 'u1',
      name: 'Reviewer',
      channel: 'feishu',
      concurrency_mode: 'advisor',
    });

    // 1. mount builder
    const { buildBotMounts } = await import('../src/container-runner.js');
    const mounts = buildBotMounts({
      folder: 'main',
      botId: bot.id,
      mode: 'advisor',
    });
    expect(mounts).not.toBeNull();
    expect(fs.existsSync(mounts!.scratchHost)).toBe(true);
    expect(fs.existsSync(path.join(mounts!.profileHost, 'CLAUDE.md'))).toBe(true);

    // 2. agent-runner hook config
    const { buildHooksConfig, resolveBotModeFromEnv } = await import(
      '../container/agent-runner/src/index.js'
    );
    const mode = resolveBotModeFromEnv({ HAPPYCLAW_BOT_MODE: mounts!.botMode });
    expect(mode).toBe('advisor');
    const hooks = buildHooksConfig({
      botMode: mode,
      projectRoot: '/workspace/group',
      preCompactHook: async () => ({}),
    });
    expect(hooks.PreToolUse).toBeDefined();

    // 3. pretend the hook receives a Write to project → denied
    const preHook = hooks.PreToolUse![0].hooks[0];
    const denyResult = await preHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/workspace/group/a.ts', content: 'x' },
        tool_use_id: 't1',
        cwd: '/workspace/group',
      } as any,
      'session',
      {} as any,
    );
    expect((denyResult as any).hookSpecificOutput.permissionDecision).toBe('deny');

    // 4. writer bot → no PreToolUse hook
    const writerBot = createBot({
      user_id: 'u1',
      name: 'Coder',
      channel: 'feishu',
      concurrency_mode: 'writer',
    });
    const writerMounts = buildBotMounts({
      folder: 'main',
      botId: writerBot.id,
      mode: 'writer',
    });
    const writerHooks = buildHooksConfig({
      botMode: writerMounts!.botMode,
      projectRoot: '/workspace/group',
      preCompactHook: async () => ({}),
    });
    expect(writerHooks.PreToolUse).toBeUndefined();
  });
});
```

- [ ] **Step 7.1.2：跑测试**

```bash
npx vitest run tests/pr2-smoke.test.ts
```

Expected: PASS

### 7.2 文档

**Files:**
- Modify: `CLAUDE.md`（§5 表、§6 目录）
- Modify: `docs/API.md`（Bot profile endpoints）

- [ ] **Step 7.2.1：CLAUDE.md 追加**

在 §5 "后端模块" 表追加：
```markdown
| `src/bot-profile-manager.ts` | Bot profile CLAUDE.md 读写 + 路径遍历防御（PR2） |
```

在 §6 目录约定追加：
```
  bot-profiles/{botId}/CLAUDE.md           # Bot 角色（用户维护，advisor/writer 默认模板）
  scratch/{folder}/bots/{botId}/           # advisor 可写 scratch（跨会话持久）
```

在 §7 Web API 入口表补一行 Bot profile 说明。

在 §9 环境变量追加：
```markdown
| `HAPPYCLAW_BOT_MODE` | - | 容器内 Bot 模式（writer / advisor，由 container-runner 注入） |
| `HAPPYCLAW_BOT_ID` | - | 容器内 Bot ID（同上） |
```

### 7.3 commit

- [ ] **Step 7.3.1：一次性 commit 两项**

```bash
git add tests/pr2-smoke.test.ts CLAUDE.md docs/API.md
git commit -m "docs+test: Multi-Agent PR2 - E2E smoke + 文档更新"
```

---

## Task 8：最终回归 + PR

- [ ] **Step 8.1：完整类型检查**

```bash
make typecheck
```

Expected: PASS（忽略 workspace-config.ts 如仍然存在的话——但 PR1 已修）

- [ ] **Step 8.2：完整测试**

```bash
npx vitest run --no-file-parallelism
```

Expected: 全 PASS（包括 PR1 的 113 测试 + PR2 的新测试，共 ~140+）

- [ ] **Step 8.3：格式化**

```bash
npm run format
```

- [ ] **Step 8.4：build**

```bash
make build
```

Expected: 全部 exit 0（backend + web + agent-runner）

- [ ] **Step 8.5：PR 描述**

推送 + 创建 PR（`gh pr create` 或浏览器），标题与正文样例：

```
标题：功能: Multi-Agent PR2 - advisor 写保护 + PreToolUse Hook + scratch

正文：
## 问题描述
实现 v3 设计文档附录 E 的 PR2 范围：让 advisor 类 Bot 真正"只读"（通过 SDK PreToolUse Hook + 只读挂载+ 默认模板引导）。

## 实现方案
- 新增 `src/bot-profile-manager.ts`：per-bot CLAUDE.md 读写 + 路径遍历防御
- 新增 `container/agent-runner/src/advisor-guard.ts`：PreToolUse Hook，拦截项目目录写操作
- `container-runner.ts` 挂载 `/workspace/bot-profile`（ro）和 `/workspace/scratch`（rw）
- 注入 `HAPPYCLAW_BOT_MODE` 环境变量触发 advisor 分支
- GET/PUT `/api/bots/:id/profile` 编辑 Bot 角色 CLAUDE.md（含路径防御 + 审计）

## 测试计划
- [x] bot-profile-manager.test.ts
- [x] advisor-guard.test.ts（10 个工具级）
- [x] advisor-guard-bash.test.ts（20+ 个 bash 边界）
- [x] bot-profile-api.test.ts
- [x] container-runner-bot-mounts.test.ts
- [x] agent-runner-hook-registration.test.ts
- [x] pr2-smoke.test.ts（E2E glue）

## 不在本 PR 范围
- 前端 UI（BotsPage、profile 编辑器）→ PR3
- scratch 自动 GC → PR3
- 监控指标（hook invocations / denies）→ PR3
```

---

## 自查清单

- [ ] **Spec 覆盖：** PR2 范围 5 项是否都有 Task？
  - ✅ PreToolUse Hook → T2
  - ✅ bot-profile 挂载 + 路径防御 → T1 + T3 + T4
  - ✅ scratch 目录 → T4
  - ✅ concurrency_mode 启用 → T4 + T5 + T6
  - ✅ advisor 默认 CLAUDE.md → T1
- [ ] **无 placeholder：** 所有 Step 都有具体代码或命令
- [ ] **类型一致性：** `BotConcurrencyMode`、`BotMountInfo`、`GuardResult` 跨 Task 一致
- [ ] **fail-closed 原则：** advisor-guard 内部异常、无效输入、未知工具 → deny

---

## 后续 PR

**PR3**（前端 UI + 监控 + 审计细节，2~3 周）：
- `/bots` 页（BotsPage + BotEditor）
- WorkspaceBotsPanel（ChatView 右侧）
- bot-profile 编辑器（Monaco / 简易 textarea）
- 监控指标（bot 连接状态机、队列深度、Hook 拦截次数）
- scratch 自动 GC
- prompt injection 防护
- 中文 token 估算

PR2 合并后启动 PR3 `writing-plans`。
