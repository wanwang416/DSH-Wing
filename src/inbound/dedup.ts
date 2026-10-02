/**
 * 消息去重（24h TTL + 持久化 + LRU 2048）
 *
 * 参考成熟桥接实现，
 * 增加内存 LRU 上限（2048）与 24h TTL 修剪。
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const LRU_MAX = 2048;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface DedupeRecord {
  messageId: string;
  at: number;
}

export function createDedupeStore(
  file: string,
  now: () => number = Date.now,
  ttlMs: number = DEFAULT_TTL_MS,
  logger?: { warn?: (m: string) => void },
) {
  // ★ M13（2026-10-02 阶段4）注记：文件名是 dedupe.jsonl 但内容是**格式化 JSON 数组**（非 JSONL）
  //   ——历史原因，改名会造成迁移负担，保持不变。后人勿按 JSONL 逐行解析。
  let records: DedupeRecord[] = [];
  try {
    const raw = readFileSync(file, "utf8");
    records = (JSON.parse(raw) as DedupeRecord[]).slice(-LRU_MAX);
  } catch (err) {
    if (existsSync(file)) {
      // ★ M13：解析失败（或读取失败）**不许静默清空**——原文件复制为 .bak 留证 + warn。
      //   可用性优先：去重从空开始（代价是平台重投的近期消息可能重复执行一次，但不会卡死消息）。
      try {
        copyFileSync(file, `${file}.bak`);
        logger?.warn?.(
          `去重状态文件解析失败，已保留备份 ${file}.bak，去重从空开始: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch (bakErr) {
        logger?.warn?.(
          `去重状态文件解析失败，且备份失败: ${err instanceof Error ? err.message : String(err)} / ${bakErr instanceof Error ? bakErr.message : String(bakErr)}`,
        );
      }
    }
    records = [];
  }

  const persist = () => {
    try {
      // ★ M13：tmp + rename 原子写——写一半被杀不会再把 dedupe.jsonl 打成损坏 JSON
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(records.slice(-LRU_MAX), null, 2), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // 忽略（与旧实现一致：持久化失败不阻断消息处理）
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
