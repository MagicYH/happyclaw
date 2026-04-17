/**
 * tests/bot-profile-manager.test.ts
 *
 * Bot Profile Manager 单元测试。
 * 涵盖 plan 中的 6 个核心用例 + test-cases.md UT-01~UT-12 的全部 bot-profile 相关用例。
 *
 * 覆盖范围：
 *   - UT-01: safeProfilePath 对合法 botId 返回绝对路径
 *   - UT-02: writeBotProfile 原子写（.tmp → rename）
 *   - UT-03: readBotProfile 首次读无文件返回默认模板
 *   - UT-04: readBotProfile 读写往返一致
 *   - UT-05: ensureProfileExists 首次调用返回 true 并落盘
 *   - UT-06: ensureProfileExists 第二次调用返回 false 且不覆盖
 *   - UT-07: deleteBotProfile 幂等清理
 *   - UT-08: getProfileMountPath 路径与 write 目录一致
 *   - UT-09: writeBotProfile 拒绝 `..` 组件 botId
 *   - UT-10: 拒绝含 `..` 但以 `bot_` 前缀伪装的 botId
 *   - UT-11: 拒绝太短 botId
 *   - UT-12: 拒绝 URL 编码 botId（防御 router 层漏网）
 *   - UT-13: writer 模板含标准 sections
 *   - UT-14: writer 模板不包含 advisor 字样
 *   - UT-15: advisor 模板强制声明 scratch 与 /tmp
 *   - UT-16: advisor 模板强制声明 subprocess 约束
 *   - 额外: InvalidBotIdError 可以被 instanceof 检测
 *   - 额外: readBotProfile 读取失败时回落默认模板
 */
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

  // ─────────────────────────────────────────────
  // Plan 里的 6 个核心用例
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // UT-01: safeProfilePath 对合法 botId 返回绝对路径
  // ─────────────────────────────────────────────

  test('UT-01: getProfileMountPath for valid botId returns {DATA_DIR}/bot-profiles/{botId}', async () => {
    const { getProfileMountPath } = await import('../src/bot-profile-manager.js');
    const p = getProfileMountPath('bot_abc12345');
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(tmpDir, 'bot-profiles', 'bot_abc12345'));
  });

  // ─────────────────────────────────────────────
  // UT-02: writeBotProfile 原子写（.tmp → rename）
  // ─────────────────────────────────────────────

  test('UT-02: writeBotProfile uses atomic write (no .tmp residue)', async () => {
    const { writeBotProfile, getProfileMountPath } = await import('../src/bot-profile-manager.js');
    writeBotProfile('bot_abc12345', 'atomic content');
    const profileDir = getProfileMountPath('bot_abc12345');
    const files = fs.readdirSync(profileDir);
    // 目录中没有 .tmp 文件残留
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
    // CLAUDE.md 存在
    expect(files).toContain('CLAUDE.md');
  });

  // ─────────────────────────────────────────────
  // UT-03: readBotProfile 首次读无文件返回默认模板
  // ─────────────────────────────────────────────

  test('UT-03: readBotProfile writer template when no file', async () => {
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile('bot_xyz12345', 'writer');
    expect(content).toContain('# 角色定义');
    expect(content).toContain('协作准则');
  });

  // ─────────────────────────────────────────────
  // UT-04: readBotProfile 读写往返一致
  // ─────────────────────────────────────────────

  test('UT-04: readBotProfile roundtrip consistency', async () => {
    const { writeBotProfile, readBotProfile } = await import('../src/bot-profile-manager.js');
    const data = '# Custom\n\nUnique content 12345';
    writeBotProfile('bot_abc12345', data);
    const back = readBotProfile('bot_abc12345', 'writer');
    expect(back).toBe(data);
  });

  // ─────────────────────────────────────────────
  // UT-05: ensureProfileExists 首次调用返回 true 并落盘
  // ─────────────────────────────────────────────

  test('UT-05: ensureProfileExists returns true on first call and creates file', async () => {
    const { ensureProfileExists, getProfileMountPath } = await import('../src/bot-profile-manager.js');
    const result = ensureProfileExists('bot_abc12345', 'advisor');
    expect(result).toBe(true);
    const profileFile = path.join(getProfileMountPath('bot_abc12345'), 'CLAUDE.md');
    expect(fs.existsSync(profileFile)).toBe(true);
    const content = fs.readFileSync(profileFile, 'utf-8');
    expect(content).toContain('advisor');
  });

  // ─────────────────────────────────────────────
  // UT-06: ensureProfileExists 第二次调用返回 false 且不覆盖
  // ─────────────────────────────────────────────

  test('UT-06: ensureProfileExists returns false on second call without overwriting', async () => {
    const { ensureProfileExists, getProfileMountPath } = await import('../src/bot-profile-manager.js');
    ensureProfileExists('bot_abc12345', 'advisor');
    // 第二次（不同 mode），应返回 false 且文件内容保持 advisor 模板
    const result2 = ensureProfileExists('bot_abc12345', 'writer');
    expect(result2).toBe(false);
    const content = fs.readFileSync(
      path.join(getProfileMountPath('bot_abc12345'), 'CLAUDE.md'),
      'utf-8',
    );
    expect(content).toContain('advisor');
  });

  // ─────────────────────────────────────────────
  // UT-07: deleteBotProfile 幂等清理
  // ─────────────────────────────────────────────

  test('UT-07: deleteBotProfile is idempotent', async () => {
    const { ensureProfileExists, deleteBotProfile, getProfileMountPath } = await import(
      '../src/bot-profile-manager.js'
    );
    ensureProfileExists('bot_abc12345', 'writer');
    const dir = getProfileMountPath('bot_abc12345');
    expect(fs.existsSync(dir)).toBe(true);
    // 第一次删除
    expect(() => deleteBotProfile('bot_abc12345')).not.toThrow();
    expect(fs.existsSync(dir)).toBe(false);
    // 第二次删除——不应抛异常
    expect(() => deleteBotProfile('bot_abc12345')).not.toThrow();
  });

  // ─────────────────────────────────────────────
  // UT-08: getProfileMountPath 与 writeBotProfile 目录一致
  // ─────────────────────────────────────────────

  test('UT-08: getProfileMountPath consistent with writeBotProfile directory', async () => {
    const { writeBotProfile, getProfileMountPath } = await import('../src/bot-profile-manager.js');
    writeBotProfile('bot_abc12345', 'content');
    const dir = getProfileMountPath('bot_abc12345');
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
  });

  // ─────────────────────────────────────────────
  // UT-09: writeBotProfile 拒绝 `..` 组件 botId
  // ─────────────────────────────────────────────

  test('UT-09: writeBotProfile rejects botId with .. component', async () => {
    const { writeBotProfile, InvalidBotIdError } = await import('../src/bot-profile-manager.js');
    expect(() => writeBotProfile('../etc/passwd', '')).toThrow(InvalidBotIdError);
    // 确保文件系统中恶意路径不存在
    expect(fs.existsSync(path.join(tmpDir, 'etc'))).toBe(false);
  });

  // ─────────────────────────────────────────────
  // UT-10: 拒绝含 `..` 但以 `bot_` 前缀伪装的 botId
  // ─────────────────────────────────────────────

  test('UT-10: writeBotProfile rejects botId like bot_../foo', async () => {
    const { writeBotProfile, InvalidBotIdError } = await import('../src/bot-profile-manager.js');
    expect(() => writeBotProfile('bot_../foo', '')).toThrow(InvalidBotIdError);
  });

  // ─────────────────────────────────────────────
  // UT-11: 拒绝太短 botId
  // ─────────────────────────────────────────────

  test('UT-11: writeBotProfile rejects botId that is too short (<8 chars after bot_)', async () => {
    const { writeBotProfile, InvalidBotIdError } = await import('../src/bot-profile-manager.js');
    // 'bot_a' — suffix 只有 1 个字符
    expect(() => writeBotProfile('bot_a', '')).toThrow(InvalidBotIdError);
    // 'bot_1234567' — suffix 7 个字符，也应该拒绝（需要至少 8 个）
    expect(() => writeBotProfile('bot_1234567', '')).toThrow(InvalidBotIdError);
  });

  // ─────────────────────────────────────────────
  // UT-12: 拒绝 URL 编码 botId（防御 router 层漏网）
  // ─────────────────────────────────────────────

  test('UT-12: writeBotProfile rejects URL-encoded botId like bot_%2e%2e', async () => {
    const { writeBotProfile, InvalidBotIdError } = await import('../src/bot-profile-manager.js');
    // % 不在 [a-zA-Z0-9_-] 字符集中，应当拒绝
    expect(() => writeBotProfile('bot_%2e%2e', '')).toThrow(InvalidBotIdError);
    expect(() => writeBotProfile('bot_%2Fetc', '')).toThrow(InvalidBotIdError);
  });

  // ─────────────────────────────────────────────
  // UT-13: writer 模板含标准 sections
  // ─────────────────────────────────────────────

  test('UT-13: writer template contains standard sections', async () => {
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile('bot_abc12345', 'writer');
    expect(content).toContain('# 角色定义');
    expect(content).toContain('## 职责范围');
    expect(content).toContain('## 协作准则');
  });

  // ─────────────────────────────────────────────
  // UT-14: writer 模板不包含 advisor 字样
  // ─────────────────────────────────────────────

  test('UT-14: writer template does not contain advisor keywords', async () => {
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile('bot_abc12345', 'writer');
    expect(content).not.toContain('advisor');
    expect(content).not.toContain('/workspace/scratch');
    expect(content).not.toContain('只读');
  });

  // ─────────────────────────────────────────────
  // UT-15: advisor 模板强制声明 scratch 与 /tmp
  // ─────────────────────────────────────────────

  test('UT-15: advisor template declares scratch and /tmp constraints', async () => {
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile('bot_abc12345', 'advisor');
    expect(content).toContain('/workspace/scratch');
    expect(content).toContain('/tmp');
    expect(content).toContain('禁止修改');
  });

  // ─────────────────────────────────────────────
  // UT-16: advisor 模板强制声明 subprocess 约束
  // ─────────────────────────────────────────────

  test('UT-16: advisor template declares subprocess constraints', async () => {
    const { readBotProfile } = await import('../src/bot-profile-manager.js');
    const content = readBotProfile('bot_abc12345', 'advisor');
    // 应包含 subprocess 相关约束说明
    expect(content).toMatch(/subprocess|子进程|python/i);
  });

  // ─────────────────────────────────────────────
  // 额外: InvalidBotIdError 可以被 instanceof 检测
  // ─────────────────────────────────────────────

  test('InvalidBotIdError is instanceof-checkable', async () => {
    const { writeBotProfile, InvalidBotIdError } = await import('../src/bot-profile-manager.js');
    let caught: unknown;
    try {
      writeBotProfile('INVALID_BOT', 'content');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidBotIdError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/invalid bot id/i);
  });

  // ─────────────────────────────────────────────
  // 额外: readBotProfile 文件损坏/读取失败时 fallback 到模板
  // ─────────────────────────────────────────────

  test('readBotProfile falls back to template when file is unreadable', async () => {
    const { writeBotProfile, readBotProfile, getProfileMountPath } = await import(
      '../src/bot-profile-manager.js'
    );
    // 先写入文件
    writeBotProfile('bot_abc12345', '# Valid content');
    // 然后删除文件，模拟读取失败场景（改权限在 CI 里不总可靠，直接删文件）
    const profileFile = path.join(getProfileMountPath('bot_abc12345'), 'CLAUDE.md');
    fs.unlinkSync(profileFile);
    // 再次读取应当 fallback 到默认模板
    const content = readBotProfile('bot_abc12345', 'writer');
    expect(content).toContain('# 角色定义');
  });

  // ─────────────────────────────────────────────
  // 额外: 路径严格前缀校验（UT-32 的 bot-profile 类比）
  // ─────────────────────────────────────────────

  test('getProfileMountPath strict prefix check prevents /bot-profilesXXX escape', async () => {
    const { getProfileMountPath, writeBotProfile, InvalidBotIdError } = await import(
      '../src/bot-profile-manager.js'
    );
    // 合法 botId
    const p = getProfileMountPath('bot_abc12345');
    expect(p.startsWith(path.join(tmpDir, 'bot-profiles') + path.sep)).toBe(true);
    // botId 带空格或特殊字符（不在 [a-zA-Z0-9_-] 范围）应被拒绝
    expect(() => writeBotProfile('bot abc12345', '')).toThrow(InvalidBotIdError);
    expect(() => writeBotProfile('bot_abc/12345', '')).toThrow(InvalidBotIdError);
  });
});
