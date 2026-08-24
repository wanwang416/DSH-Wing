/**
 * 丢消息补偿（对齐既有桥接实现）
 *
 * 连接恢复（onRecovered）时，用 listMessages 拉取断连窗口（10 分钟）内消息，
 * 与已投递集合去重后 reinject 回处理管线——WS 假死窗口的消息补拉。
 */

import type { RouteStore } from "../session/persistence.js";

export interface CompensatedMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  text: string;
  senderOpenId?: string;
}

export interface CompensationDeps {
  routes: RouteStore;
  listMessages(params: { chatId: string; startTimeMs: number; endTimeMs: number }): Promise<Array<{ messageId: string; timestampMs: number }>>;
  reinject(msg: CompensatedMessage): Promise<void>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  replayWindowMs?: number;
  now?: () => number;
}

/** 断连补拉窗口：最近 10 分钟 */
const REPLAY_WINDOW_MS = 10 * 60_000;

export function createMissedCompensation(deps: CompensationDeps) {
  const now = deps.now ?? Date.now;
  const windowMs = deps.replayWindowMs ?? REPLAY_WINDOW_MS;
  const delivered = new Set<string>();
  const maxTracked = 5000;

  return {
    /** 处理成功的消息登记（补偿去重用） */
    noteDelivered(messageId: string): void {
      delivered.add(messageId);
      if (delivered.size > maxTracked) {
        const arr = [...delivered];
        delivered.clear();
        for (const id of arr.slice(-2500)) delivered.add(id);
      }
    },
    /** 连接恢复：补拉断连窗口消息 */
    async onRecovered(): Promise<void> {
      const until = now();
      const since = until - windowMs;
      let pulled = 0;
      for (const route of deps.routes.all()) {
        try {
          const items = await deps.listMessages({
            chatId: route.chatId,
            startTimeMs: since,
            endTimeMs: until,
          });
          for (const item of items) {
            if (delivered.has(item.messageId)) continue;
            delivered.add(item.messageId); // 防止重复 reinject
            try {
              await deps.reinject({
                messageId: item.messageId,
                chatId: route.chatId,
                chatType: route.chatType,
                text: "",
                senderOpenId: undefined,
              });
              pulled += 1;
            } catch (err) {
              deps.logger?.warn?.(`补偿 reinject 失败 ${item.messageId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          deps.logger?.warn?.(`补偿 listMessages 失败（${route.chatId}）: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (pulled > 0) deps.logger?.info?.(`丢消息补偿：补拉 ${pulled} 条`);
    },
  };
}

export type MissedCompensation = ReturnType<typeof createMissedCompensation>;
