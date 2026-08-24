/**
 * 配额熔断（对齐既有桥接实现）
 *
 * 连接失败计数窗口（默认 60 分钟 12 次）→ 熔断（quarantined）→ 窗口过期自动恢复。
 * 历史持久化 conn-history.jsonl。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface QuotaOpts {
  windowMinutes: number;
  limit: number;
  now?: () => number;
}

export function createQuotaGovernor(historyFile: string, opts: QuotaOpts) {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMinutes * 60_000;
  let history: Array<{ at: number; ok: boolean }> = [];
  try {
    history = readFileSync(historyFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as { at: number; ok: boolean };
        } catch {
          return undefined;
        }
      })
      .filter((r): r is { at: number; ok: boolean } => r !== undefined);
  } catch {
    history = [];
  }
  const persist = () => {
    try {
      mkdirSync(join(historyFile, ".."), { recursive: true });
      writeFileSync(historyFile, history.slice(-500).map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    } catch {
      // 忽略
    }
  };
  const prune = () => {
    const cutoff = now() - windowMs;
    history = history.filter((r) => r.at >= cutoff);
  };
  return {
    recordConnect() {
      prune();
      history.push({ at: now(), ok: true });
      persist();
      return history.length;
    },
    recordFailure() {
      prune();
      history.push({ at: now(), ok: false });
      persist();
    },
    tripped() {
      prune();
      return history.filter((r) => !r.ok).length >= opts.limit;
    },
    remaining() {
      prune();
      return Math.max(0, opts.limit - history.filter((r) => !r.ok).length);
    },
    resetAt() {
      prune();
      const oldest = history.filter((r) => !r.ok)[0];
      return oldest ? oldest.at + windowMs : undefined;
    },
    reset() {
      history = [];
      persist();
    },
  };
}

export type QuotaGovernor = ReturnType<typeof createQuotaGovernor>;
