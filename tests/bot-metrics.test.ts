import { describe, expect, test, beforeEach } from 'vitest';

describe('bot-metrics', () => {
  beforeEach(async () => {
    const { resetMetrics } = await import('../src/bot-metrics.js');
    resetMetrics();
  });

  test('recordQueueEnqueue + recordQueueProcessed aggregate per folder/bot', async () => {
    const { recordQueueEnqueue, recordQueueProcessed, getMetrics } = await import('../src/bot-metrics.js');
    recordQueueEnqueue('main');
    recordQueueEnqueue('main');
    recordQueueProcessed('main', 'bot_abc12345');
    const m = getMetrics();
    expect(m.queue_depth.main).toBe(1);
    expect(m.queue_processed_total['main|bot_abc12345']).toBe(1);
  });

  test('recordQueueDequeue decrements depth without going below 0', async () => {
    const { recordQueueEnqueue, recordQueueDequeue, getMetrics } = await import('../src/bot-metrics.js');
    recordQueueEnqueue('main');
    recordQueueDequeue('main');
    recordQueueDequeue('main'); // extra dequeue should clamp at 0
    expect(getMetrics().queue_depth.main).toBe(0);
  });

  test('recordHookDeny aggregates per (bot, tool, reason)', async () => {
    const { recordHookDeny, getMetrics } = await import('../src/bot-metrics.js');
    recordHookDeny('bot_abc12345', 'Write', 'project_path');
    recordHookDeny('bot_abc12345', 'Write', 'project_path');
    recordHookDeny('bot_abc12345', 'Bash', 'git_commit');
    const m = getMetrics();
    expect(m.hook_denies_total['bot_abc12345|Write|project_path']).toBe(2);
    expect(m.hook_denies_total['bot_abc12345|Bash|git_commit']).toBe(1);
  });

  test('recordHookInvocation aggregates per (bot, tool)', async () => {
    const { recordHookInvocation, getMetrics } = await import('../src/bot-metrics.js');
    recordHookInvocation('bot_abc12345', 'Write');
    recordHookInvocation('bot_abc12345', 'Write');
    recordHookInvocation('bot_abc12345', 'Bash');
    const m = getMetrics();
    expect(m.hook_invocations_total['bot_abc12345|Write']).toBe(2);
    expect(m.hook_invocations_total['bot_abc12345|Bash']).toBe(1);
  });

  test('recordScratchSize stores per (folder, bot)', async () => {
    const { recordScratchSize, getMetrics } = await import('../src/bot-metrics.js');
    recordScratchSize('main', 'bot_a', 1024);
    recordScratchSize('main', 'bot_a', 2048); // overwrites
    expect(getMetrics().scratch_size_bytes['main|bot_a']).toBe(2048);
  });

  test('resetMetrics clears all counters', async () => {
    const { recordQueueEnqueue, resetMetrics, getMetrics } = await import('../src/bot-metrics.js');
    recordQueueEnqueue('main');
    resetMetrics();
    expect(Object.keys(getMetrics().queue_depth).length).toBe(0);
  });

  test('multiple folders are tracked independently', async () => {
    const { recordQueueEnqueue, recordQueueProcessed, getMetrics } = await import('../src/bot-metrics.js');
    recordQueueEnqueue('main');
    recordQueueEnqueue('main');
    recordQueueEnqueue('home-1');
    recordQueueProcessed('main', 'bot_a');
    recordQueueProcessed('home-1', 'bot_b');
    const m = getMetrics();
    expect(m.queue_depth.main).toBe(1);
    expect(m.queue_depth['home-1']).toBe(0);
    expect(m.queue_processed_total['main|bot_a']).toBe(1);
    expect(m.queue_processed_total['home-1|bot_b']).toBe(1);
  });

  test('updated_at advances after each record call', async () => {
    const { recordQueueEnqueue, getMetrics } = await import('../src/bot-metrics.js');
    const before = getMetrics().updated_at;
    // Ensure time advances
    await new Promise((r) => setTimeout(r, 2));
    recordQueueEnqueue('main');
    const after = getMetrics().updated_at;
    expect(after >= before).toBe(true);
  });
});
