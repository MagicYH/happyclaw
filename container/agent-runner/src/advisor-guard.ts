/**
 * Advisor Guard: PreToolUse Hook for advisor-mode bots.
 *
 * Intercepts all write tool calls (Write/Edit/MultiEdit/NotebookEdit/Bash) to block
 * mutations of the project directory (/workspace/group by default).
 *
 * Allowed write destinations:
 *   - /workspace/scratch (per-bot persistent scratch)
 *   - /tmp (ephemeral)
 *   - /home/node/.claude (SDK session state)
 *   - /workspace/bot-profile (ro by design; attempts will 404 at fs level)
 *
 * Design rules:
 *   1. fail-closed: unknown format, malformed input, parse failure, internal error → deny
 *   2. Path boundaries are strict: /workspace/groupa is NOT under /workspace/group
 *      (uses startsWith(root + path.sep))
 *   3. Relative paths are treated as project paths (advisor cwd = project root)
 *   4. Bash: quote stripping for single/double quoted paths; compound commands all checked
 *   5. $(cmd) and other dynamic path forms → deny (cannot statically evaluate)
 *
 * 设计参考 v3 §5.6.3 (PreToolUse Hook 详细设计)
 */
import path from 'path';
import type {
  HookCallback,
  HookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Decision = 'allow' | 'deny';

export interface GuardResult {
  decision: Decision;
  reason?: string;
}

export interface EvaluateInput {
  name: string;
  input: unknown;
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Known read-only tools that are always allowed regardless of file path
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'List',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoRead',
  'TodoWrite',
]);

// ---------------------------------------------------------------------------
// Git write-operation detection (no path needed; cwd is project root)
// ---------------------------------------------------------------------------

const BASH_GIT_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+(?:restore|revert)\b/,
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip one layer of surrounding single or double quotes from a token.
 * e.g. '/workspace/group/a' → /workspace/group/a
 */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/**
 * Check whether a path (absolute or relative) is under the project root.
 *
 * - Absolute paths: use path.resolve + strict startsWith(root + sep)
 * - Relative paths: advisor's cwd is projectRoot, so relative → treat as project (deny)
 * - Empty or non-string: denied (fail-closed)
 */
function isProjectPath(p: string, root: string): boolean {
  if (!p || typeof p !== 'string') return true; // fail-closed
  if (!path.isAbsolute(p)) {
    // Relative path in advisor context = under project root → deny
    return true;
  }
  const resolved = path.resolve(p);
  // Strict boundary: /workspace/group === root OR /workspace/group/... starts with root/
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Validate a file_path value and return a GuardResult.
 */
function checkFilePath(filePath: unknown, root: string): GuardResult {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return {
      decision: 'deny',
      reason: '无法解析路径参数（非字符串或空），advisor 模式拒绝以确保安全',
    };
  }
  if (isProjectPath(filePath, root)) {
    return {
      decision: 'deny',
      reason: `禁止写入项目目录 ${root}。advisor 角色应写入 /workspace/scratch 或 /tmp。`,
    };
  }
  return { decision: 'allow' };
}

// ---------------------------------------------------------------------------
// Bash command analysis
// ---------------------------------------------------------------------------

/**
 * Extract redirect targets from a command string.
 * Handles:
 *   > PATH
 *   >> PATH
 *   quoted: > 'PATH' or > "PATH"
 */
function extractRedirectTargets(cmd: string): string[] {
  const targets: string[] = [];
  // Match > or >> followed by optional whitespace and a token (quoted or unquoted)
  const redirectRe = />>?\s*(["']?)(\S+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(cmd)) !== null) {
    const raw = m[2];
    targets.push(stripQuotes(raw));
  }
  return targets;
}

/**
 * Extract tee targets: `tee [-a] TARGET`
 */
function extractTeeTargets(cmd: string): string[] {
  const targets: string[] = [];
  const teeRe = /\btee(?:\s+-a)?\s+(["']?)(\S+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = teeRe.exec(cmd)) !== null) {
    targets.push(stripQuotes(m[2]));
  }
  return targets;
}

/**
 * Extract mv final destination (last non-option argument after 'mv').
 * Simplified: split on whitespace, last token is target.
 */
function extractMvTarget(segment: string): string | null {
  const parts = segment.trim().split(/\s+/);
  if (parts.length < 3) return null; // mv SRC DEST
  return stripQuotes(parts[parts.length - 1]);
}

/**
 * Extract cp destination (last non-option argument after 'cp').
 */
function extractCpTarget(segment: string): string | null {
  const parts = segment.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return stripQuotes(parts[parts.length - 1]);
}

/**
 * Extract rm targets (all non-flag arguments after 'rm').
 */
function extractRmTargets(segment: string): string[] {
  const parts = segment.trim().split(/\s+/).slice(1); // drop 'rm'
  return parts.filter((p) => !p.startsWith('-')).map(stripQuotes);
}

/**
 * Extract sed -i targets (last argument on the line).
 */
function extractSedTarget(segment: string): string | null {
  if (!/\bsed\s+.*-i/.test(segment)) return null;
  const parts = segment.trim().split(/\s+/);
  return stripQuotes(parts[parts.length - 1]);
}

/**
 * Detect dynamic path expressions that cannot be statically analyzed.
 * Examples: $(pwd), ${VAR}, `pwd`
 */
function hasDynamicPaths(cmd: string): boolean {
  return /\$\(|`[^`]+`|\$\{/.test(cmd);
}

/**
 * Split a command string into segments separated by ; | && ||
 * to analyze each sub-command independently.
 */
function splitToSegments(cmd: string): string[] {
  // Split on ; | && || but keep simple segments
  return cmd.split(/[;|]|\&\&|\|\|/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Analyze a single command segment (no ; | && ||) for project-path writes.
 */
function analyzeSegment(segment: string, root: string): boolean {
  // Check redirect targets (> and >>)
  for (const t of extractRedirectTargets(segment)) {
    if (isProjectPath(t, root)) return true;
  }

  // Check tee targets
  for (const t of extractTeeTargets(segment)) {
    if (isProjectPath(t, root)) return true;
  }

  // mv
  if (/\bmv\b/.test(segment)) {
    const t = extractMvTarget(segment);
    if (t && isProjectPath(t, root)) return true;
  }

  // cp
  if (/\bcp\b/.test(segment)) {
    const t = extractCpTarget(segment);
    if (t && isProjectPath(t, root)) return true;
  }

  // rm
  if (/\brm\b/.test(segment)) {
    for (const t of extractRmTargets(segment)) {
      if (isProjectPath(t, root)) return true;
    }
  }

  // sed -i
  if (/\bsed\s/.test(segment)) {
    const t = extractSedTarget(segment);
    if (t && isProjectPath(t, root)) return true;
  }

  return false;
}

/**
 * Evaluate a Bash command string for project-directory writes.
 * Pure function — no side effects.
 *
 * fail-closed: empty / undefined / dynamic paths / parse failures → deny
 */
export function evaluateBashCommand(cmd: string, projectRoot: string): GuardResult {
  if (!cmd || typeof cmd !== 'string') {
    return { decision: 'deny', reason: 'Bash 命令为空，拒绝以保证安全' };
  }

  // 1. Git write operations (no path check needed; cwd = project root)
  for (const pat of BASH_GIT_WRITE_PATTERNS) {
    if (pat.test(cmd)) {
      return {
        decision: 'deny',
        reason: `advisor 禁止执行 git 修改操作（cmd: ${cmd.slice(0, 80)}）`,
      };
    }
  }

  // 2. Dynamic paths — cannot statically analyze, fail-closed
  if (hasDynamicPaths(cmd)) {
    return {
      decision: 'deny',
      reason: `Bash 命令含动态路径表达式（$()、反引号等），无法静态分析，advisor 保守拒绝`,
    };
  }

  // 3. Analyze each command segment
  const segments = splitToSegments(cmd);
  for (const seg of segments) {
    if (analyzeSegment(seg, projectRoot)) {
      return {
        decision: 'deny',
        reason: `Bash 命令将写入项目目录 ${projectRoot}，advisor 禁止。请改写 /workspace/scratch 或 /tmp`,
      };
    }
  }

  return { decision: 'allow' };
}

// ---------------------------------------------------------------------------
// evaluateToolCall — main entry point for tool call decisions
// ---------------------------------------------------------------------------

/**
 * Evaluate a single tool call and return allow/deny.
 *
 * Pure function: no I/O, no side effects, no SDK imports at call site.
 * fail-closed: any malformed input or unknown format → deny.
 */
export function evaluateToolCall({ name, input, projectRoot }: EvaluateInput): GuardResult {
  // Malformed input → deny
  if (input === null || input === undefined || typeof input !== 'object') {
    return { decision: 'deny', reason: 'tool 参数缺失或非对象，fail-closed' };
  }
  const inp = input as Record<string, unknown>;

  switch (name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return checkFilePath(inp.file_path, projectRoot);

    case 'NotebookEdit': {
      // Support both notebook_path and file_path for robustness
      const nbPath = inp.notebook_path ?? inp.file_path;
      return checkFilePath(nbPath, projectRoot);
    }

    case 'Bash': {
      const cmd = typeof inp.command === 'string' ? inp.command : '';
      return evaluateBashCommand(cmd, projectRoot);
    }

    default: {
      // Known read-only tools are always allowed regardless of path
      if (READ_ONLY_TOOLS.has(name)) {
        return { decision: 'allow' };
      }
      // Unknown tools with explicit file_path in project → deny
      if (typeof inp.file_path === 'string' && isProjectPath(inp.file_path, projectRoot)) {
        return {
          decision: 'deny',
          reason: `工具 ${name} 的 file_path 落在项目目录，advisor 禁止`,
        };
      }
      // Otherwise allow (read-only tools, MCP tools without path, etc.)
      return { decision: 'allow' };
    }
  }
}

// ---------------------------------------------------------------------------
// createAdvisorGuardHook — SDK PreToolUse Hook factory
// ---------------------------------------------------------------------------

/**
 * Create a SDK-compatible PreToolUse HookCallback for advisor bots.
 *
 * fail-closed: any internal exception → deny with reason.
 *
 * Usage:
 *   hooks: {
 *     PreToolUse: [{ hooks: [createAdvisorGuardHook('/workspace/group')] }]
 *   }
 */
export function createAdvisorGuardHook(projectRoot: string): HookCallback {
  return async (input: HookInput, _toolUseID: string | undefined, _options: { signal: AbortSignal }) => {
    try {
      const h = input as PreToolUseHookInput;
      const result = evaluateToolCall({
        name: h.tool_name,
        input: h.tool_input,
        projectRoot,
      });

      if (result.decision === 'deny') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: result.reason ?? 'advisor 拒绝写入项目目录',
          },
        };
      }

      // allow → return empty object (SDK interprets as approve)
      return {};
    } catch (err) {
      // fail-closed: any exception → deny
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `advisor-guard 内部异常，拒绝以保证安全: ${String(err)}`,
        },
      };
    }
  };
}
