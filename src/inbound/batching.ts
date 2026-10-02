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
  /** ★ M4-R3 任务 4：事件层真实 chatType（合批 flush 透传用）。
   *  飞书 P2P 会话的 chat_id 同样是 oc_ 前缀，前缀猜测不可靠；有真值必须透传。 */
  chatType?: "group" | "p2p";
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
    /** 加入一条消息；返回 true=已合并/已整批投递（无需单独处理） */
    add(chatId: string, item: BatchItem): boolean {
      const existing = batches.get(chatId);
      if (existing) {
        existing.items.push(item);
        if (existing.items.length >= cfg.maxCount || totalChars(existing.items) >= cfg.maxChars) {
          // ★ P0 修复（2026-10-02）：满员分支必须把整批交给 onFlush 并返回 true。
          //   旧实现丢弃 flush 返回值后 return false → 批次内前 maxCount-1 条被静默丢弃
          //   （未去重、未落 WAL、无日志）。当前这条已 push 进 items 尾部，flush 整批
          //   （含它）交给 onFlush（index.ts 用 items 最后一条的 messageId 投递，同一条
          //   不会重复），所以返回 true 让调用方不再单独处理——若返回 false，调用方会用
          //   同一 messageId 再处理一次，两条路径争抢、整批被去重拦掉，前 7 条仍然丢失。
          const items = this.flush(chatId);
          if (items) deps.onFlush?.(chatId, items);
          return true;
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
