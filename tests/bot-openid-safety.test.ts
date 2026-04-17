/**
 * Task 10 — bot-openid-safety tests
 *
 * 验证 shouldProcessWhenBotOpenIdMissing() 在 user / bot 连接下的行为：
 * - user 连接：open_id 空时默认放行（向后兼容）
 * - bot 连接：open_id 空时强制丢弃（安全严格模式）
 */
import { describe, it, expect } from 'vitest';
import { shouldProcessWhenBotOpenIdMissing } from '../src/feishu.js';

describe('shouldProcessWhenBotOpenIdMissing', () => {
  it('user connection: defaults to allow when botOpenId is missing', () => {
    expect(shouldProcessWhenBotOpenIdMissing('user')).toBe(true);
  });

  it('bot connection: defaults to drop when botOpenId is missing', () => {
    expect(shouldProcessWhenBotOpenIdMissing('bot')).toBe(false);
  });
});
