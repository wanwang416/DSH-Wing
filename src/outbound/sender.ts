/**
 * 飞书发送器：text/card/reaction，3 次重试
 *
 * M1 用 create 新消息（不做 reply；reply 降级逻辑 M2 完整实现）。
 */

import type { WingLarkClient } from "../host/client.js";

export interface SenderDeps {
  getClient(): WingLarkClient | undefined;
  logger?: { warn?: (m: string) => void; error?: (m: string) => void };
  maxRetries?: number;
}

export function createSender(deps: SenderDeps) {
  const maxRetries = deps.maxRetries ?? 3;
  const client = () => deps.getClient();

  async function withRetry(fn: () => Promise<unknown>): Promise<unknown> {
    let lastErr: unknown;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        }
      }
    }
    throw lastErr;
  }

  const receiveIdType = (chatId: string): "chat_id" | "open_id" =>
    chatId.startsWith("oc_") ? "chat_id" : "open_id";

  /** 提取 sendMessage 响应中的 message_id（兼容 SDK 多种返回） */
  const extractMessageId = (res: unknown): string | undefined => {
    if (res && typeof res === "object") {
      const r = res as { data?: { message_id?: unknown; item?: { message_id?: unknown } }; message_id?: unknown };
      return (r?.data?.message_id ?? r?.message_id ?? r?.data?.item?.message_id) as string | undefined;
    }
    return undefined;
  };

  return {
    /** 发送文本消息 */
    async sendText(chatId: string, text: string): Promise<unknown> {
      const c = client();
      if (!c?.sendMessage) throw new Error("lark 客户端未就绪");
      return withRetry(() =>
        c.sendMessage({
          receive_id_type: receiveIdType(chatId),
          params: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text }),
          },
        }),
      );
    },
    /** 发送卡片消息（M1 工具状态备用；M2 起 CardKit 渲染） */
    async sendCard(chatId: string, card: unknown): Promise<unknown> {
      const c = client();
      if (!c?.sendMessage) throw new Error("lark 客户端未就绪");
      return withRetry(() =>
        c.sendMessage({
          receive_id_type: receiveIdType(chatId),
          params: {
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(card),
          },
        }),
      );
    },
    /**
     * ★ M3 任务 2：CardKit 两步发送（createCardEntity → im.message.create 引用 card_id）。
     * 返回 { messageId, cardId }；cardId 用于后续流式打字机更新。
     * 参考成熟桥接 SendPreviewStart (feishu.go:4511-4513)。
     */
    async sendCardKitCard(chatId: string, cardJson: string): Promise<{ messageId: string; cardId: string }> {
      const c = client();
      if (!c?.createCardEntity || !c?.sendMessage) throw new Error("lark 客户端未就绪（无 CardKit）");
      const cardId = await c.createCardEntity(cardJson);
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      const res = await withRetry(() =>
        c.sendMessage({
          receive_id_type: receiveIdType(chatId),
          params: {
            receive_id: chatId,
            msg_type: "interactive",
            content,
          },
        }),
      );
      const messageId = extractMessageId(res);
      if (!messageId) throw new Error(`sendCardKitCard 未返回 message_id. ${JSON.stringify(res).slice(0, 200)}`);
      return { messageId, cardId };
    },
    /** ★ M3 任务 2：CardKit 流式更新 main_text 元素（打字机动画） */
    async streamCardContent(cardId: string, content: string, sequence: number): Promise<unknown> {
      const c = client();
      if (!c?.streamMessageContent) throw new Error("lark 客户端未就绪（无 streamMessageContent）");
      return withRetry(() => c.streamMessageContent!(cardId, content, sequence));
    },
    /** 添加表情回应 */
    async addReaction(messageId: string, emojiType: string): Promise<unknown> {
      const c = client();
      if (!c?.addReaction) throw new Error("lark 客户端未就绪");
      return withRetry(() => c.addReaction({ message_id: messageId, emoji_type: emojiType }));
    },
    /** 更新已发送的卡片消息（StreamingCard 单卡流式） */
    async updateCard(messageId: string, cardJson: string): Promise<unknown> {
      const c = client();
      if (!c?.updateMessage) throw new Error("lark 客户端未就绪");
      return withRetry(() => c.updateMessage({ message_id: messageId, content: cardJson }));
    },
  };
}

export type Sender = ReturnType<typeof createSender>;
