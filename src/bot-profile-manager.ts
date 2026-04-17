/**
 * Bot Profile Manager
 *
 * 管理 per-bot 角色 CLAUDE.md 文件的读写、默认模板生成、路径遍历防御。
 * 路径：data/bot-profiles/{botId}/CLAUDE.md
 *
 * 设计参考 docs/superpowers/specs/2026-04-17-multi-agent-design-v3.md §6.1, §7.5, §8.3
 *
 * 注意：DATA_DIR 在运行时动态读取（优先 process.env.DATA_DIR，fallback 到 config），
 * 以支持测试环境通过 process.env.DATA_DIR 临时覆盖路径。
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR as CONFIG_DATA_DIR } from './config.js';
import type { BotConcurrencyMode } from './types.js';
import { logger } from './logger.js';

/** botId 正则：必须以 bot_ 开头，后跟至少 8 个字母数字/下划线/连字符。
 *  严格字符集 [a-zA-Z0-9_-] 阻断 `.`、`%`、`/`、空格等危险字符。 */
const BOT_ID_PATTERN = /^bot_[a-zA-Z0-9_-]{8,}$/;

export class InvalidBotIdError extends Error {
  constructor(botId: string) {
    super(`invalid bot id: ${botId}`);
    this.name = 'InvalidBotIdError';
  }
}

/**
 * 动态获取 DATA_DIR，支持测试环境通过 process.env.DATA_DIR 覆盖。
 */
function getDataDir(): string {
  return process.env.DATA_DIR ?? CONFIG_DATA_DIR;
}

/**
 * 校验 botId 并返回安全的绝对目录路径。
 * 双层防御：
 *   1. 正则校验 botId 格式（阻断 `..`、`%xx`、`/`、空格等危险字符）
 *   2. path.resolve 后验证路径必须严格位于 baseDir 下（防止 path 拼接边界绕过）
 *
 * 抛出 `InvalidBotIdError` 若 botId 非法。
 */
function safeProfilePath(botId: string): string {
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new InvalidBotIdError(botId);
  }
  const baseDir = path.resolve(getDataDir(), 'bot-profiles');
  const target = path.resolve(baseDir, botId);
  // 严格前缀校验：resolved 路径必须以 baseDir + path.sep 开头
  if (!target.startsWith(baseDir + path.sep)) {
    throw new InvalidBotIdError(botId);
  }
  return target;
}

/**
 * 返回 bot profile 目录的绝对路径（供 container-runner 挂载使用）。
 * 不创建目录，也不写任何文件。
 */
export function getProfileMountPath(botId: string): string {
  return safeProfilePath(botId);
}

// ─────────────────────────────────────────────
// 默认模板
// ─────────────────────────────────────────────

/** writer 模式默认模板 */
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

/** advisor 模式默认模板（强调只读边界） */
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

// ─────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────

/**
 * 读取 bot 的 CLAUDE.md profile。
 * 若文件不存在或读取失败，回落到对应 mode 的默认模板。
 */
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
    logger.warn(
      { err, botId },
      'Failed to read bot profile, returning default template',
    );
    return mode === 'advisor' ? advisorTemplate() : writerTemplate();
  }
}

/**
 * 写入 bot 的 CLAUDE.md profile。
 * 使用原子写入（先写 .tmp 再 rename），保证不出现部分写入的中间态。
 */
export function writeBotProfile(botId: string, content: string): void {
  const dir = safeProfilePath(botId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'CLAUDE.md');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * 若 profile 文件不存在，写入对应 mode 的默认模板。
 * 返回 true 表示新建了文件，false 表示文件已存在（未覆盖）。
 */
export function ensureProfileExists(
  botId: string,
  mode: BotConcurrencyMode,
): boolean {
  const dir = safeProfilePath(botId);
  const file = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(dir, { recursive: true });
  const content = mode === 'advisor' ? advisorTemplate() : writerTemplate();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
  return true;
}

/**
 * 删除 bot 的整个 profile 目录（包括 CLAUDE.md）。
 * 幂等：若目录不存在不抛异常。
 */
export function deleteBotProfile(botId: string): void {
  try {
    const dir = safeProfilePath(botId);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (err instanceof InvalidBotIdError) {
      throw err;
    }
    logger.warn({ err, botId }, 'Failed to delete bot profile directory');
  }
}
