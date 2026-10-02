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

/** listMessages 返回条目：P0-3 起带 text（拿不到正文为 undefined） */
export type CompensatableItem = { messageId: string; timestampMs: number; text?: string };

export interface CompensationDeps {
  routes: RouteStore;
  listMessages(params: { chatId: string; startTimeMs: number; endTimeMs: number }): Promise<CompensatableItem[]>;
  reinject(msg: CompensatedMessage): Promise<void>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  replayWindowMs?: number;
  now?: () => number;
  /**
   * ★ 该路由是否属于企微线路。企微消息**不走飞书补偿**（listMessages 是飞书 API）：
   *   2026-09-17 真机实测，拿企微 chatId 调 listMessages 会每 30 秒刷一条 429（累计 116 次）。
   * 缺省 = 不过滤（保持旧行为）。
   */
  isWecomRoute?(route: { sessionKey: string; chatId: string }): boolean;
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
      let noText = 0;
      for (const route of deps.routes.all()) {
        if (deps.isWecomRoute?.(route)) continue; // ★ 企微路由不进飞书补偿通道（真机 429 根因）
        try {
          const items = await deps.listMessages({
            chatId: route.chatId,
            startTimeMs: since,
            endTimeMs: until,
          });
          for (const item of items) {
            if (delivered.has(item.messageId)) continue;
            // ★ P0-3（2026-10-02）：拿不到正文不 reinject、不计数、不标记已投递——
            //   旧实现恒传 text:"" → reinject 第一句必拦，pulled 照加谎报"补拉 N 条"。
            if (!item.text) {
              noText += 1;
              deps.logger?.warn?.(`补偿跳过 ${item.messageId}：listMessages 拿不到正文（post/卡片或未解析），已跳过 ${noText} 条`);
              continue;
            }
            try {
              await deps.reinject({
                messageId: item.messageId,
                chatId: route.chatId,
                chatType: route.chatType,
                text: item.text,
                senderOpenId: undefined,
              });
              // ★ P0-3：delivered.add 移到 reinject 成功之后——失败不标记，下轮恢复可重试
              delivered.add(item.messageId);
              pulled += 1;
            } catch (err) {
              deps.logger?.warn?.(`补偿 reinject 失败 ${item.messageId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          deps.logger?.warn?.(`补偿 listMessages 失败（${route.chatId}）: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // ★ 不许假成功：pulled 与 skipped 分开计数，skipped>0 必打 warn
      if (pulled > 0) deps.logger?.info?.(`丢消息补偿：补拉 ${pulled} 条`);
      if (noText > 0) deps.logger?.warn?.(`丢消息补偿：${noText} 条因拿不到正文被跳过（未计入补拉数）`);
    },
  };
}

export type MissedCompensation = ReturnType<typeof createMissedCompensation>;
