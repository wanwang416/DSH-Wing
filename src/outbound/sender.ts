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
    /** 发送 ask-user-question 交互式提问卡片（带选项按钮，和 DSH 原生格式对齐 */
    async sendAskUserQuestionCard(chatId: string, questions: any[]): Promise<unknown> {
      const c = client();
      if (!c?.sendMessage) throw new Error("lark 客户端未就绪");
      // 构造飞书交互式卡片，按 DSH ask-user-question 格式
      const elements = questions.map(q => ({
        "tag": "markdown",
        "content": `### ${q.header}\n\n${q.description || ""}`,
      }));
      elements.push({
        "tag": "markdown",
        "content": "点击下方选项:",
      });
      const actions = questions.flatMap(q => q.options.map((opt: any, idx: number) => ({
        "tag": "button",
        "text": {
          "content": opt.label,
          "type": "default",
        },
        "type": "action",
        "name": `answer:${q.id}:${idx}`,
        "value": JSON.stringify({ questionId: q.id, optionId: idx, label: opt.label }),
      })));
      const card = {
        "schema": "2.0",
        "header": {
          "title": {
            "content": "请选择偏好",
            "template": "blue",
          },
        },
        "body": elements,
        "actions": actions,
      };
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
