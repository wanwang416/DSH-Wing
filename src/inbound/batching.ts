/**
 * 文本合批（M2：群聊短消息合批机制）
 *
 * 同一 chat 在 0.6s 窗口内的多条消息合并为一条（最多 8 条 / 4000 字符），
 * 减少 agent 被打断频率；窗口到期 flush。
 * ★ 插话语义保留：合批仅合并同一窗口的连续短消息，不吞长任务/插话。
 */

export interface BatchConfig {
  windowMs: number;
  maxCount: number;
  maxChars: number;
}

export const DEFAULT_BATCH: BatchConfig = {
  windowMs: 600,
  maxCount: 8,
  maxChars: 4000,
};

export interface BatchItem {
  messageId: string;
  text: string;
}

export interface BatchingDeps {
  cfg?: BatchConfig;
  now?: () => number;
  /** 批次到期 flush 回调（投给处理管线） */
  onFlush?(chatId: string, items: BatchItem[]): void;
}

export function createBatching(deps: BatchingDeps = {}) {
  const cfg = deps.cfg ?? DEFAULT_BATCH;
  const now = deps.now ?? Date.now;
  const batches = new Map<string, { items: BatchItem[]; openedAt: number; timer?: ReturnType<typeof setTimeout> }>();

  return {
    /** 加入一条消息；返回 true=已合并（无需单独处理），false=应 flush 后单独处理（超限） */
    add(chatId: string, item: BatchItem): boolean {
      const existing = batches.get(chatId);
      if (existing) {
        existing.items.push(item);
        if (existing.items.length >= cfg.maxCount || totalChars(existing.items) >= cfg.maxChars) {
          this.flush(chatId);
          return false; // 超限：调用方重新单独入队
        }
        return true;
      }
      const rec: { items: BatchItem[]; openedAt: number; timer?: ReturnType<typeof setTimeout> } = {
        items: [item],
        openedAt: now(),
        timer: undefined,
      };
      rec.timer = setTimeout(() => {
        const flushed = this.flush(chatId);
        if (flushed) deps.onFlush?.(chatId, flushed);
      }, cfg.windowMs);
      rec.timer.unref?.();
      batches.set(chatId, rec);
      return true;
    },
    /** 立即取出并清空该 chat 的批次；无批次返回 undefined（不触发 onFlush） */
    flush(chatId: string): BatchItem[] | undefined {
      const rec = batches.get(chatId);
      if (!rec) return undefined;
      batches.delete(chatId);
      if (rec.timer) clearTimeout(rec.timer);
      return rec.items;
    },
    /** 合并批次的文本（按序，\n 连接） */
    merge(items: BatchItem[]): string {
      return items.map((i) => i.text).join("\n");
    },
    size: () => batches.size,
  };
}

function totalChars(items: BatchItem[]): number {
  return items.reduce((n, i) => n + i.text.length, 0);
}

export type Batching = ReturnType<typeof createBatching>;
