/**
 * 消息去重（24h TTL + 持久化 + LRU 2048）
 *
 * 参考成熟桥接实现，
 * 增加内存 LRU 上限（2048）与 24h TTL 修剪。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const LRU_MAX = 2048;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface DedupeRecord {
  messageId: string;
  at: number;
}

export function createDedupeStore(file: string, now: () => number = Date.now, ttlMs: number = DEFAULT_TTL_MS) {
  let records: DedupeRecord[] = [];
  try {
    const raw = readFileSync(file, "utf8");
    records = (JSON.parse(raw) as DedupeRecord[]).slice(-LRU_MAX);
  } catch {
    records = [];
  }

  const persist = () => {
    try {
      writeFileSync(file, JSON.stringify(records.slice(-LRU_MAX), null, 2), { mode: 0o600 });
    } catch {
      // 忽略
    }
  };

  /** messageId 是否已见过（不改变状态） */
  function isDuplicate(messageId: string): boolean {
    const cutoff = now() - ttlMs;
    // 顺带惰性修剪过期记录
    if (records.some((r) => r.at < cutoff)) {
      records = records.filter((r) => r.at >= cutoff);
      persist();
    }
    return records.some((r) => r.messageId === messageId);
  }

  /** 记录一条 messageId；已存在返回 false */
  function add(messageId: string): boolean {
    const cutoff = now() - ttlMs;
    records = records.filter((r) => r.at >= cutoff);
    if (records.some((r) => r.messageId === messageId)) return false;
    records.push({ messageId, at: now() });
    if (records.length > LRU_MAX) records = records.slice(-LRU_MAX);
    persist();
    return true;
  }

  /** 主动修剪过期记录 */
  function prune(): void {
    const cutoff = now() - ttlMs;
    const before = records.length;
    records = records.filter((r) => r.at >= cutoff);
    if (records.length !== before) persist();
  }

  return { isDuplicate, add, prune, size: () => records.length };
}

export type DedupeStore = ReturnType<typeof createDedupeStore>;
