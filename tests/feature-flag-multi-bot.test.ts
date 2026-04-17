import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('../src/db.js', () => ({}));

describe('SystemSettings: multi-bot flags', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('enableMultiBot defaults to false', async () => {
    const { getSystemSettings } = await import('../src/runtime-config.js');
    const settings = getSystemSettings();
    expect(settings.enableMultiBot).toBe(false);
  });

  test('maxBotsPerMessage defaults to 3', async () => {
    const { getSystemSettings } = await import('../src/runtime-config.js');
    const settings = getSystemSettings();
    expect(settings.maxBotsPerMessage).toBe(3);
  });

  test('maxBotsPerUser defaults to 10', async () => {
    const { getSystemSettings } = await import('../src/runtime-config.js');
    const settings = getSystemSettings();
    expect(settings.maxBotsPerUser).toBe(10);
  });
});
