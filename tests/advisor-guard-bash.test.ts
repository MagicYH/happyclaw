/**
 * advisor-guard-bash.test.ts
 *
 * Bash 命令解析边界用例 —— 全面覆盖测试用例文档 §3.6 ~ §3.8。
 *
 * 对应：UT-33 ~ UT-62（Bash 矩阵 + 边界 + 规避）
 *
 * 策略：使用 test.each 批量运行 deny/allow 决策矩阵，再补充
 * 复合命令、引号剥离、命令替换等边界场景。
 */
import { describe, expect, test } from 'vitest';
import { evaluateBashCommand } from '../container/agent-runner/src/advisor-guard.js';

const ROOT = '/workspace/group';

// ---------------------------------------------------------------------------
// §3.6 + §3.7 — 基本命令矩阵（UT-33 ~ UT-56）
// ---------------------------------------------------------------------------
describe('advisor-guard: Bash allow/deny matrix', () => {
  test.each([
    // ----- deny: 写入/删除重定向到项目目录 -----
    ['echo x > /workspace/group/a', 'deny'],          // UT-33
    ['cat a >> /workspace/group/b', 'deny'],           // UT-34
    ['tee /workspace/group/x', 'deny'],                // UT-35
    ['tee -a /workspace/group/x', 'deny'],             // UT-36
    ['rm /workspace/group/a', 'deny'],                 // UT-37
    ['rm -rf /workspace/group/src/', 'deny'],           // UT-38 (test-cases.md extra)
    ['mv /workspace/scratch/x /workspace/group/', 'deny'], // UT-39
    ['cp a /workspace/group/b', 'deny'],               // UT-40
    ['sed -i s/a/b/ /workspace/group/a', 'deny'],      // UT-41
    // ----- deny: git 写类操作 -----
    ['git commit -m x', 'deny'],                       // UT-49
    ['git push', 'deny'],                              // UT-50
    ['git reset --hard HEAD', 'deny'],                 // UT-51
    ['git checkout main', 'deny'],                     // UT-52
    ['git merge feature', 'deny'],                     // UT-53
    ['git rebase origin/main', 'deny'],                // UT-54
    ['git revert HEAD', 'deny'],                       // UT-55
    // ----- allow: 读类操作 -----
    ['ls /workspace/group', 'allow'],                  // UT-43
    ['cat /workspace/group/a', 'allow'],               // (plan allow example)
    ['grep -r foo /workspace/group', 'allow'],         // UT-44
    ['echo x > /workspace/scratch/a', 'allow'],        // UT-45
    ['echo x > /tmp/a.log', 'allow'],                  // UT-46
    ['rm /tmp/a', 'allow'],                            // UT-47
    ['sed s/a/b/ /workspace/group/a', 'allow'],        // UT-48 (no -i = stdout only)
    ['git status', 'allow'],                           // UT-56 a
    ['git diff', 'allow'],                             // UT-56 b
    ['git log', 'allow'],                              // UT-56 c
  ])('command %j → %s', (cmd, expected) => {
    const r = evaluateBashCommand(cmd, ROOT);
    expect(r.decision).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// §3.8 — 边界与规避尝试（UT-57 ~ UT-62）
// ---------------------------------------------------------------------------
describe('advisor-guard: Bash boundary and evasion', () => {
  // UT-57 — 空命令 fail-closed
  test('empty command defaults to deny (fail-closed)', () => {
    const r = evaluateBashCommand('', ROOT);
    expect(r.decision).toBe('deny');
  });

  // UT-58 — 单引号包裹路径
  test("single-quoted project path is denied: echo x > '/workspace/group/a'", () => {
    const r = evaluateBashCommand("echo x > '/workspace/group/a'", ROOT);
    expect(r.decision).toBe('deny');
  });

  // UT-59 — 双引号包裹路径
  test('double-quoted project path is denied: echo x > "/workspace/group/a"', () => {
    const r = evaluateBashCommand('echo x > "/workspace/group/a"', ROOT);
    expect(r.decision).toBe('deny');
  });

  // UT-60 — 分号复合命令，第二条写项目
  test('semicolon compound: echo a; rm /workspace/group/b → deny', () => {
    const r = evaluateBashCommand('echo a; rm /workspace/group/b', ROOT);
    expect(r.decision).toBe('deny');
  });

  // UT-61 — && 复合命令，第二条写项目
  test('&& compound: echo a && cp /tmp/x /workspace/group/y → deny', () => {
    const r = evaluateBashCommand('echo a && cp /tmp/x /workspace/group/y', ROOT);
    expect(r.decision).toBe('deny');
  });

  // UT-62 — 命令替换 $(pwd) → fail-closed deny
  test('command substitution $(pwd) → deny (fail-closed)', () => {
    const r = evaluateBashCommand('echo x > $(pwd)/a', ROOT);
    expect(r.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// §3.6 — 管道目标（UT-42）
// ---------------------------------------------------------------------------
describe('advisor-guard: Bash pipe to project target', () => {
  // UT-42
  test('pipe to tee targeting project → deny', () => {
    const r = evaluateBashCommand('cat a.txt | tee /workspace/group/b', ROOT);
    expect(r.decision).toBe('deny');
  });

  test('pipe to tee targeting scratch → allow', () => {
    const r = evaluateBashCommand('cat a.txt | tee /workspace/scratch/b', ROOT);
    expect(r.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 路径边界（/workspace/groupa 不误判为 /workspace/group 的子路径）
// ---------------------------------------------------------------------------
describe('advisor-guard: Bash path boundary', () => {
  test('/workspace/groupa is not under /workspace/group → allow (write to groupa)', () => {
    const r = evaluateBashCommand('echo x > /workspace/groupa/a', ROOT);
    expect(r.decision).toBe('allow');
  });

  test('mv to /workspace/groupa target → allow', () => {
    const r = evaluateBashCommand('mv /tmp/x /workspace/groupa/x', ROOT);
    expect(r.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 额外的 rm -rf 和 git restore
// ---------------------------------------------------------------------------
describe('advisor-guard: Bash additional git/rm cases', () => {
  test('git restore → deny', () => {
    const r = evaluateBashCommand('git restore src/foo.ts', ROOT);
    expect(r.decision).toBe('deny');
  });

  test('rm -rf without project path → allow', () => {
    const r = evaluateBashCommand('rm -rf /tmp/scratch', ROOT);
    expect(r.decision).toBe('allow');
  });
});
