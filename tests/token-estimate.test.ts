/**
 * Token estimation tests for context-builder.ts
 * Pure function unit tests — no side effects, no I/O.
 */
import { describe, expect, test } from 'vitest';

// Dynamic import to avoid ESM issues with the agent-runner subproject.
// We test via the compiled JS output of context-builder.
// Since tests run in the main project but the source is in container/, we
// import from the TypeScript source directly using vitest's ts support.
// vitest.config.ts excludes container/ from scanning but we can import explicitly.

async function getContextBuilder() {
  // Import the actual module — vitest handles TypeScript transpilation
  return await import('../container/agent-runner/src/context-builder.js');
}

describe('estimateTokens — pure function', () => {
  test('empty string → 0 tokens', async () => {
    const { estimateTokens } = await getContextBuilder();
    expect(estimateTokens('')).toBe(0);
  });

  test('pure ASCII / English: 4 chars per token', async () => {
    const { estimateTokens } = await getContextBuilder();
    // 'Hello' = 5 chars, ceil(5/4) = 2
    expect(estimateTokens('Hello')).toBe(2);
    // 'Hello World!' = 12 chars, ceil(12/4) = 3
    expect(estimateTokens('Hello World!')).toBe(3);
    // 40-char English string → 10 tokens
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  test('pure CJK Chinese: 2.5 chars per token', async () => {
    const { estimateTokens } = await getContextBuilder();
    // 5 CJK chars → ceil(5/2.5) = 2
    expect(estimateTokens('你好世界！')).toBe(2);
    // 10 CJK chars → 4
    expect(estimateTokens('一二三四五六七八九十')).toBe(4);
    // 1 CJK → ceil(1/2.5) = 1
    expect(estimateTokens('中')).toBe(1);
    // 2 CJK → ceil(2/2.5) = 1
    expect(estimateTokens('中文')).toBe(1);
    // 3 CJK → ceil(3/2.5) = 2
    expect(estimateTokens('中文字')).toBe(2);
  });

  test('mixed Chinese + English', async () => {
    const { estimateTokens } = await getContextBuilder();
    // '你好 hello' = 2 CJK + 7 non-CJK (' hello')
    // ceil(2/2.5 + 7/4) = ceil(0.8 + 1.75) = ceil(2.55) = 3
    expect(estimateTokens('你好 hello')).toBe(3);
  });

  test('CJK extension block (U+3400-U+4DBF) counted as CJK', async () => {
    const { estimateTokens } = await getContextBuilder();
    // U+3400 is in the CJK Extension A block
    const extChar = '\u3400'; // 㐀
    // 1 extension CJK → ceil(1/2.5) = 1
    expect(estimateTokens(extChar)).toBe(1);
  });

  test('emoji and symbols counted as non-CJK (other chars)', async () => {
    const { estimateTokens } = await getContextBuilder();
    // '🎉' is 2 code units (surrogate pair in UTF-16) but 2 chars in JS string.length
    // treated as 2 non-CJK chars → ceil(2/4) = 1
    const emoji = '🎉';
    expect(estimateTokens(emoji)).toBeGreaterThanOrEqual(1);
    expect(estimateTokens(emoji)).toBeLessThanOrEqual(2);
  });

  test('newline and whitespace counted as non-CJK', async () => {
    const { estimateTokens } = await getContextBuilder();
    // 4 newlines = 4 chars = ceil(4/4) = 1
    expect(estimateTokens('\n\n\n\n')).toBe(1);
  });

  test('long text returns positive number proportional to length', async () => {
    const { estimateTokens } = await getContextBuilder();
    const longEng = 'a'.repeat(400);
    const longCjk = '字'.repeat(400);
    expect(estimateTokens(longEng)).toBe(100);
    expect(estimateTokens(longCjk)).toBe(160); // ceil(400/2.5) = 160
  });
});

describe('buildGroupContext', () => {
  test('returns empty string when messages is empty', async () => {
    const { buildGroupContext } = await getContextBuilder();
    expect(buildGroupContext([], 1000)).toBe('');
  });

  test('returns all messages when within budget', async () => {
    const { buildGroupContext } = await getContextBuilder();
    const messages = [
      { timestamp: '2026-04-17 10:00', sender: 'Alice', text: 'Hello' },
      { timestamp: '2026-04-17 10:01', sender: 'Bot', text: 'Hi there' },
    ];
    const result = buildGroupContext(messages, 10000);
    expect(result).toContain('Alice');
    expect(result).toContain('Hello');
    expect(result).toContain('Bot');
    expect(result).toContain('Hi there');
  });

  test('truncates oldest messages when over budget', async () => {
    const { buildGroupContext } = await getContextBuilder();
    // Budget of 2 tokens = very small, should drop earlier messages
    const messages = [
      { timestamp: '2026-04-17 10:00', sender: 'Alice', text: 'First message that is longer' },
      { timestamp: '2026-04-17 10:01', sender: 'Bob', text: 'Second' },
      { timestamp: '2026-04-17 10:02', sender: 'Alice', text: 'Third' },
    ];
    // Very small budget forces truncation
    const result = buildGroupContext(messages, 3);
    // Should contain at least the last message
    expect(result).toContain('Third');
    // Should NOT contain all three
    expect(result).not.toContain('First message that is longer');
  });

  test('includes timestamps and sender in formatted output', async () => {
    const { buildGroupContext } = await getContextBuilder();
    const messages = [
      { timestamp: '2026-04-17 10:01', sender: 'user', text: 'Test message' },
    ];
    const result = buildGroupContext(messages, 10000);
    expect(result).toContain('2026-04-17 10:01');
    expect(result).toContain('user');
    expect(result).toContain('Test message');
  });
});
