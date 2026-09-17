/**
 * 入站事件分发（M1 只注册 p2_im_message_receive_v1）
 *
 * 流程：收到事件 → dedup 检查 → parser 解析 → 上层 handler。
 */

import { parseInboundMessage, type ParsedMessage } from "./parser.js";
import type { DedupeStore } from "./dedup.js";

const EVENT_MESSAGE = "im.message.receive_v1";

export interface DispatcherDeps {
  dedupe: DedupeStore;
  botOpenId: () => string | undefined;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /** 解析后的消息处理入口（session 层） */
  handleInbound(msg: ParsedMessage): Promise<void>;
}

export function createDispatcher(deps: DispatcherDeps) {
  return {
    /** 由 transport 的事件回调调用 */
    async handleEvent(event: string, data: unknown): Promise<void> {
      if (event !== EVENT_MESSAGE) return;
      const raw = data as any;
      const messageId = raw?.message?.message_id ?? raw?.message_id;
      if (!messageId) return;

      // 去重：重复消息直接丢弃
      if (deps.dedupe.isDuplicate(messageId)) {
        deps.logger?.warn?.(`去重丢弃消息 ${messageId}`);
        return;
      }
      if (!deps.dedupe.add(messageId)) return;

      const msg = parseInboundMessage(raw, deps.botOpenId());
      if (!msg) return; // 非 text 或解析失败

      try {
        await deps.handleInbound(msg);
      } catch (err) {
        deps.logger?.error?.(`handleInbound 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    /**
     * ★ 企微线路入口：消息已在平台侧解析成 ParsedMessage（wecom-parser），
     * 跳过飞书事件解析，直接去重 + 进 handleInbound。
     */
    async handleParsed(msg: ParsedMessage): Promise<void> {
      if (deps.dedupe.isDuplicate(msg.messageId)) {
        deps.logger?.warn?.(`去重丢弃企微消息 ${msg.messageId}`);
        return;
      }
      if (!deps.dedupe.add(msg.messageId)) return;
      try {
        await deps.handleInbound(msg);
      } catch (err) {
        deps.logger?.error?.(`企微 handleInbound 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
