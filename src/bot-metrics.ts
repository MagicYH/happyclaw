/**
 * Bot Metrics (PR3)
 *
 * 内存计数器，避免引入 Prometheus 依赖。通过 GET /api/monitor/bot-metrics 暴露。
 * 设计：v3 §10.1
 *
 * 指标说明：
 * - queue_depth: per folder 当前队列深度（入队 +1，出队/处理 -1）
 * - queue_processed_total: per (folder|bot_id) 累计处理完成数
 * - hook_invocations_total: per (bot_id|tool) 累计 Hook 调用数
 * - hook_denies_total: per (bot_id|tool|reason) 累计 Hook 拒绝数
 * - scratch_size_bytes: per (folder|bot_id) scratch 目录体积（覆盖更新）
 */

interface Metrics {
  queue_depth: Record<string, number>; // folder → 当前深度
  queue_processed_total: Record<string, number>; // folder|bot_id → 累计
  hook_invocations_total: Record<string, number>; // bot_id|tool → 累计
  hook_denies_total: Record<string, number>; // bot_id|tool|reason → 累计
  scratch_size_bytes: Record<string, number>; // folder|bot_id → bytes
  updated_at: string;
}

function emptyMetrics(): Metrics {
  return {
    queue_depth: {},
    queue_processed_total: {},
    hook_invocations_total: {},
    hook_denies_total: {},
    scratch_size_bytes: {},
    updated_at: new Date().toISOString(),
  };
}

let metrics: Metrics = emptyMetrics();

function touch(): void {
  metrics.updated_at = new Date().toISOString();
}

/**
 * 消息/任务入队：队列深度 +1
 */
export function recordQueueEnqueue(folder: string): void {
  metrics.queue_depth[folder] = (metrics.queue_depth[folder] ?? 0) + 1;
  touch();
}

/**
 * 消息/任务出队（不计处理结果）：队列深度 -1，下限为 0
 */
export function recordQueueDequeue(folder: string): void {
  const cur = metrics.queue_depth[folder] ?? 0;
  metrics.queue_depth[folder] = Math.max(0, cur - 1);
  touch();
}

/**
 * 消息/任务处理完成：队列深度 -1（同 Dequeue），并累计 per-bot 处理计数
 */
export function recordQueueProcessed(folder: string, botId: string): void {
  // 深度减 1
  const cur = metrics.queue_depth[folder] ?? 0;
  metrics.queue_depth[folder] = Math.max(0, cur - 1);
  // 累计
  const k = `${folder}|${botId}`;
  metrics.queue_processed_total[k] =
    (metrics.queue_processed_total[k] ?? 0) + 1;
  touch();
}

/**
 * Hook 调用（不论通过/拒绝）：per (bot_id|tool) 累计
 */
export function recordHookInvocation(botId: string, tool: string): void {
  const k = `${botId}|${tool}`;
  metrics.hook_invocations_total[k] =
    (metrics.hook_invocations_total[k] ?? 0) + 1;
  touch();
}

/**
 * Hook 拒绝：per (bot_id|tool|reason) 累计
 * 由主进程在解析 stream_event hook_deny 时调用。
 */
export function recordHookDeny(
  botId: string,
  tool: string,
  reason: string,
): void {
  const k = `${botId}|${tool}|${reason}`;
  metrics.hook_denies_total[k] = (metrics.hook_denies_total[k] ?? 0) + 1;
  touch();
}

/**
 * Scratch 目录体积：per (folder|bot_id) 覆盖更新（单位：bytes）
 */
export function recordScratchSize(
  folder: string,
  botId: string,
  bytes: number,
): void {
  metrics.scratch_size_bytes[`${folder}|${botId}`] = bytes;
  touch();
}

/**
 * 读取当前全量指标快照（只读引用，勿外部修改）
 */
export function getMetrics(): Readonly<Metrics> {
  return metrics;
}

/**
 * 重置所有计数器（仅用于测试）
 */
export function resetMetrics(): void {
  metrics = emptyMetrics();
}
