/**
 * 企业微信出站发送器：text / markdown / 流式（streamId 关联）。
 *
 * 企微回复语义与飞书不同：**回复必须携带消息回调的 req_id（帧上下文）**，
 * 因此依赖 wecom-client 维护的「chatId → 最近回调帧」映射：
 *   - 有帧 → replyStream / reply（「回复」语义，保序）
 *   - 无帧（如 outbox 补发、主动通知）→ sendMessage 主动推送（markdown）
 * 字节上限（SDK 限制）：流式单帧 20480 B；保守起见流式按 19000 B 切分，
 * markdown 主动推送按 4000 B 切分（对齐哈马实现）。
 */

import type { WsFrame } from "@wecom/aibot-node-sdk";

/** 平台流式单帧上限 20480 字节；留出尾部余量 */
const WECOM_STREAM_BYTE_LIMIT = 19_000;
/** markdown 主动推送保守分片 */
const WECOM_TEXT_BYTE_LIMIT = 4_000;
/** S7：帧回复分片上限（单会话 30 条/分限频账，约 5 万字节封顶，超出截断提示） */
const WECOM_MAX_TEXT_CHUNKS = 13;

/** 字节长度（UTF-8） */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 按字节上限切分，优先在换行处断，避免切断多字节字符 */
export function splitMessageByBytes(text: string, limit: number): string[] {
  if (utf8Length(text) <= limit) return [text];
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface WecomClientLike {
  /** 取该会话最近的回调帧（用于回复）；无则 undefined */
  replyFrameFor(chatId: string): WsFrame | undefined;
  /** 回复流式消息（SDK replyStream：自动透传帧 req_id） */
  replyStream(frame: WsFrame, streamId: string, content: string, finish?: boolean): Promise<unknown>;
  /** 回复普通消息（SDK reply：frame + body） */
  reply(frame: WsFrame, body: Record<string, unknown>): Promise<unknown>;
  /** 主动推送 markdown（SDK sendMessage） */
  sendMarkdown(chatId: string, body: Record<string, unknown>): Promise<unknown>;
  /** 主动推送任意消息体 */
  sendMessage(chatId: string, body: Record<string, unknown>): Promise<unknown>;
  /** 欢迎语（enter_chat 5 秒内） */
  replyWelcome(frame: WsFrame, body: Record<string, unknown>): Promise<unknown>;
  isConnected(): boolean;
}

export interface WecomSenderDeps {
  getClient(): WecomClientLike | undefined;
  logger?: { warn?: (m: string) => void; error?: (m: string) => void };
  maxRetries?: number;
}

export interface WecomStreamHandle {
  chatId: string;
  streamId: string;
}

export function createWecomSender(deps: WecomSenderDeps) {
  const maxRetries = deps.maxRetries ?? 3;
  /** chatId → 进行中的流式 id（finish 后清除） */
  const activeStreams = new Map<string, string>();

  async function withRetry(fn: () => Promise<unknown>): Promise<unknown> {
    let lastErr: unknown;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < maxRetries - 1) {
          const delay = 500 * (i + 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  const client = () => deps.getClient();

  return {
    /** 当前是否有进行中的流式会话（供体验层决定走流式还是直发） */
    hasActiveStream(chatId: string): boolean {
      return activeStreams.has(chatId);
    },

    /** N1(a)：当前是否有可用的回调帧（无帧 → 流式会降级直发；供上层提前判定避免中途直发） */
    canReply(chatId: string): boolean {
      const c = client();
      return c?.replyFrameFor(chatId) !== undefined;
    },

    /** 发送文本回复：优先帧回复（R2：按字节分片，S7：超 13 片截断），无帧则 markdown 主动推送 */
    async sendText(chatId: string, text: string): Promise<unknown> {
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      const frame = c.replyFrameFor(chatId);
      if (!frame) return this.sendMarkdown(chatId, text);
      let chunks = splitMessageByBytes(text, WECOM_TEXT_BYTE_LIMIT);
      if (chunks.length > WECOM_MAX_TEXT_CHUNKS) {
        const tail = chunks.slice(WECOM_MAX_TEXT_CHUNKS - 1).join("").slice(0, WECOM_TEXT_BYTE_LIMIT) + "\n…（回答过长已截断）";
        chunks = [...chunks.slice(0, WECOM_MAX_TEXT_CHUNKS - 1), tail];
        deps.logger?.warn?.(`企微帧回复超 ${WECOM_MAX_TEXT_CHUNKS} 片已截断（chatId=${chatId}）`);
      }
      for (const chunk of chunks) {
        await withRetry(() =>
          c.reply(frame, {
            msgtype: "text",
            text: { content: chunk },
          }),
        );
      }
      return undefined;
    },

    /** 主动推送 markdown（sendMessage 通道，无需回调帧） */
    async sendMarkdown(chatId: string, text: string): Promise<unknown> {
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      const chunks = splitMessageByBytes(text, WECOM_TEXT_BYTE_LIMIT);
      for (const chunk of chunks) {
        await withRetry(() =>
          c.sendMarkdown(chatId, { msgtype: "markdown", markdown: { content: chunk } }),
        );
      }
      return undefined;
    },

    /**
     * 开启流式回复：首个分片（finish=false）并登记 streamId。
     * 无回调帧 → 降级为 sendMarkdown 终稿（一次性），返回 undefined。
     */
    async beginStream(chatId: string, firstChunk: string): Promise<WecomStreamHandle | undefined> {
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      const frame = c.replyFrameFor(chatId);
      if (!frame) {
        await this.sendMarkdown(chatId, firstChunk);
        return undefined;
      }
      const streamId = `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await withRetry(() => c.replyStream(frame, streamId, firstChunk.slice(0, WECOM_STREAM_BYTE_LIMIT), false));
      activeStreams.set(chatId, streamId);
      return { chatId, streamId };
    },

    /** 刷新流式内容；finish=true 结束并清除登记 */
    async stream(handle: WecomStreamHandle | undefined, content: string, finish: boolean): Promise<unknown> {
      if (!handle) return undefined; // 已降级为终稿直发
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      const frame = c.replyFrameFor(handle.chatId);
      if (!frame) {
        activeStreams.delete(handle.chatId);
        return this.sendMarkdown(handle.chatId, content);
      }
      const chunks = splitMessageByBytes(content, WECOM_STREAM_BYTE_LIMIT);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        await withRetry(() => c.replyStream(frame, handle.streamId, chunks[i], finish && isLast)); // R3：仅末片透传 finish
      }
      if (finish) activeStreams.delete(handle.chatId);
      return undefined;
    },

    /** 发送欢迎语（enter_chat 5 秒内有效） */
    async sendWelcome(frame: WsFrame, text: string): Promise<unknown> {
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      // S3：欢迎语有 5 秒回复窗口，保持单片（字节截断，不切分多片）
      const first = splitMessageByBytes(text, WECOM_TEXT_BYTE_LIMIT)[0] ?? "";
      if (utf8Length(text) > WECOM_TEXT_BYTE_LIMIT) {
        deps.logger?.warn?.(`企微欢迎语 ${utf8Length(text)} 字节超限，已按 ${WECOM_TEXT_BYTE_LIMIT} 字节截断（5 秒窗口内单片发送）`);
      }
      return withRetry(() =>
        c.replyWelcome(frame, {
          msgtype: "text",
          text: { content: first },
        }),
      );
    },
  };
}

export type WecomSender = ReturnType<typeof createWecomSender>;
