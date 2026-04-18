/**
 * Scratch GC (PR3)
 *
 * 每日凌晨 3 点扫描 data/scratch/{folder}/bots/{botId}/：
 *   - 超过 retentionDays 未访问（mtime）：硬删除 + 审计日志
 *   - 超过 1GB：写 scratch_quota_exceeded 审计 + 更新 bot-metrics
 *
 * 设计依据：v3 §7.4、§10.1
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { logAuthEvent } from './db.js';
import { recordScratchSize } from './bot-metrics.js';

// DATA_DIR resolved at call time (tests override via process.env.DATA_DIR)
function getDataDir(): string {
  return process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
}

export interface GcOptions {
  /** 保留天数，超过此天数未访问（mtime）的目录将被删除 */
  retentionDays: number;
  /** 单目录体积告警阈值（bytes），默认 1GB */
  quotaBytes?: number;
  /** 注入 mock 体积函数（仅用于测试，替代真实 du） */
  sizeOverride?: (folder: string, botId: string) => number;
}

export interface GcReport {
  scanned: number;
  deleted: number;
  kept: number;
  quotaExceeded: number;
  errors: number;
}

/**
 * 递归计算目录体积（字节），类似 du -sb。
 * 出错时静默忽略并返回已累计值。
 */
function duSync(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += duSync(p);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          // skip unreadable file
        }
      }
    }
  } catch {
    // skip unreadable directory
  }
  return total;
}

/**
 * 扫描 data/scratch/{folder}/bots/{botId}/ 并清理过期目录。
 *
 * 纯函数（无全局副作用），可在测试中直接调用。
 */
export async function runScratchGc(opts: GcOptions): Promise<GcReport> {
  const scratchRoot = path.join(getDataDir(), 'scratch');
  const report: GcReport = {
    scanned: 0,
    deleted: 0,
    kept: 0,
    quotaExceeded: 0,
    errors: 0,
  };
  const cutoffMs = Date.now() - opts.retentionDays * 24 * 3600 * 1000;
  const quotaBytes = opts.quotaBytes ?? 1024 ** 3; // 默认 1GB

  if (!fs.existsSync(scratchRoot)) {
    // 目录尚未创建，直接写审计并返回
    logAuthEvent({
      event_type: 'scratch_gc_run',
      username: 'system',
      actor_username: 'system',
      details: { ...report },
      ip_address: null,
      user_agent: null,
    });
    return report;
  }

  for (const folder of fs.readdirSync(scratchRoot)) {
    const botsDir = path.join(scratchRoot, folder, 'bots');
    if (!fs.existsSync(botsDir)) continue;

    for (const botId of fs.readdirSync(botsDir)) {
      const botDir = path.join(botsDir, botId);
      report.scanned++;

      try {
        const stat = fs.statSync(botDir);
        const sizeBytes = opts.sizeOverride
          ? opts.sizeOverride(folder, botId)
          : duSync(botDir);

        // 记录体积到 bot-metrics
        recordScratchSize(folder, botId, sizeBytes);

        // 超配额告警
        if (sizeBytes > quotaBytes) {
          report.quotaExceeded++;
          logAuthEvent({
            event_type: 'scratch_quota_exceeded',
            username: 'system',
            actor_username: 'system',
            details: {
              folder,
              bot_id: botId,
              size_bytes: sizeBytes,
              quota_bytes: quotaBytes,
            },
            ip_address: null,
            user_agent: null,
          });
          logger.warn(
            { folder, botId, sizeBytes, quotaBytes },
            'scratch-gc: quota exceeded',
          );
        }

        // 按 mtime 判断是否过期
        if (stat.mtimeMs < cutoffMs) {
          fs.rmSync(botDir, { recursive: true, force: true });
          report.deleted++;
          logger.info(
            { folder, botId, sizeBytes, mtimeMs: stat.mtimeMs },
            'scratch-gc: deleted expired dir',
          );
        } else {
          report.kept++;
        }
      } catch (err) {
        report.errors++;
        logger.warn({ err, folder, botId }, 'scratch-gc: scan error');
      }
    }
  }

  logAuthEvent({
    event_type: 'scratch_gc_run',
    username: 'system',
    actor_username: 'system',
    details: { ...report },
    ip_address: null,
    user_agent: null,
  });

  return report;
}

/**
 * 判断当前时刻是否应触发一次 GC。
 *
 * 规则：
 * - 当前小时 === 3（凌晨 3 点）
 * - 距离上次运行超过 23 小时（或从未运行过）
 *
 * @param lastRunAt  上次运行的时间戳（ms），null 表示从未运行
 * @param now        当前时间戳（ms），默认 Date.now()（测试时注入）
 */
export function shouldRunNow(
  lastRunAt: number | null,
  now: number = Date.now(),
): boolean {
  const hour = new Date(now).getHours();
  if (hour !== 3) return false;
  if (lastRunAt === null) return true;
  const hoursSince = (now - lastRunAt) / 3_600_000;
  return hoursSince >= 23;
}
