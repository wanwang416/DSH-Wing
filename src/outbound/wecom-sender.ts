/**
 * 企业微信出站发送器：流式（streamId 关联）/ 主动推送 markdown。
 *
 * 企微回复语义与飞书不同：**回复必须携带消息回调的 req_id（帧上下文）**，
 * 因此依赖 wecom-client 维护的「chatId → 最近回调帧」映射：
 *   - 有帧 → replyStream（「回复」语义，保序）
 *   - 无帧（如 outbox 补发、主动通知）→ sendMessage 主动推送（markdown）
 * ★ 被动回复通道只支持 stream / markdown / template_card / 媒体，**不支持 msgtype:'text'**
 *   （2026-09-17 真机实锤：text 被企微拒收 errcode=40008 invalid message type；
 *    对齐基底 D:\ACC\cc-haha-src\adapters\wecom\index.ts——它只用 replyStream 与 sendMessage(markdown)）
 * 字节上限（SDK 限制）：流式单帧 20480 B；保守起见按 19000 B 切分，
 * 溢出余量转主动推送（不截断）；markdown 主动推送按 4000 B 切分（对齐哈马实现）。
 */

import type { WsFrame } from "@wecom/aibot-node-sdk";

/** 平台流式单帧上限 20480 字节；留出尾部余量 */
const WECOM_STREAM_BYTE_LIMIT = 19_000;
/** markdown 主动推送保守分片 */
const WECOM_TEXT_BYTE_LIMIT = 4_000;

/** 生成企微流式消息 ID（同一 streamId 复用 = 刷新同一气泡） */
function newStreamId(): string {
  return `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 字节长度（UTF-8） */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * L5：重试退避延迟 = 基准 500ms × 2^attemptIndex（封顶 4s），叠加 ±20% 抖动。
 * 独立导出供单测（P0 先例：outbox.backoffDelayMs 同款做法）。
 */
export function wecomBackoffDelayMs(attemptIndex: number): number {
  const base = Math.min(500 * 2 ** attemptIndex, 4000);
  const jitter = base * 0.4 * (Math.random() - 0.5); // ±20%
  return Math.max(50, Math.round(base + jitter));
}

/** 按字节上限切分（纯字节累加，自动避免切断多字节字符——按码点遍历） */
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
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  maxRetries?: number;
  /** L6：流式条目空闲超时（ms），默认 10 分钟；超时清理残留并 warn */
  streamIdleTimeoutMs?: number;
}

export interface WecomStreamHandle {
  chatId: string;
  streamId: string;
}

export function createWecomSender(deps: WecomSenderDeps) {
  const maxRetries = deps.maxRetries ?? 3;
  /** chatId → 进行中的流式 id（finish 后清除） */
  const activeStreams = new Map<string, string>();
  /** chatId → 失效帧标记（G3：replyStream 失败即失效，后续走主动推送通道） */
  const invalidatedFrames = new Set<string>();
  /** L6：流式空闲超时（ms）——超过即清理 activeStreams 残留并告警 */
  const STREAM_IDLE_TIMEOUT_MS = deps.streamIdleTimeoutMs ?? 10 * 60_000;
  /** L6：清理计数（可核对） */
  let activeStreamCleanups = 0;
  /** L6：chatId → 最近一次流式活动时间（begin/stream 更新；空闲超时清理用） */
  const activeStreamSeenAt = new Map<string, number>();
  /** L6：清理定时器（单例） */
  let idleSweepTimer: NodeJS.Timeout | null = null;

  /** L6：空闲清理——超时未活动的流式条目移除，防 hasActiveStream 恒 true（turn 卡死场景） */
  function scheduleIdleSweep(): void {
    if (idleSweepTimer) return;
    idleSweepTimer = setTimeout(() => {
      idleSweepTimer = null;
      const now = Date.now();
      for (const [chatId, streamId] of activeStreams) {
        const seen = activeStreamSeenAt.get(chatId) ?? 0;
        if (now - seen >= STREAM_IDLE_TIMEOUT_MS) {
          activeStreams.delete(chatId);
          activeStreamSeenAt.delete(chatId);
          activeStreamCleanups += 1;
          deps.logger?.warn?.(
            `企微出站：activeStreams 残留清理（空闲超 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s，chatId=${chatId}，streamId=${streamId}）；累计清理 ${activeStreamCleanups} 次`,
          );
        }
      }
      if (activeStreams.size > 0) scheduleIdleSweep();
    }, STREAM_IDLE_TIMEOUT_MS);
    if (typeof idleSweepTimer === "object" && "unref" in idleSweepTimer) idleSweepTimer.unref();
  }

  /** L5：重试退避（导出版 wecomBackoffDelayMs：500ms × 2^i ± 20%，封顶 4s） */
  function backoffDelayMs(attemptIndex: number): number {
    return wecomBackoffDelayMs(attemptIndex);
  }

  async function withRetry(fn: () => Promise<unknown>): Promise<unknown> {
    let lastErr: unknown;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, backoffDelayMs(i)));
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
      if (invalidatedFrames.has(chatId)) return false;
      const c = client();
      return c?.replyFrameFor(chatId) !== undefined;
    },

    /**
     * 发送文本回复（对齐基底 cc-haha 的两条通道）：
     *   - 有帧 → replyStream 单发（一次成型的流气泡，finish=true）
     *   - 无帧 → 主动推送 markdown
     * 超 19000 字节的余量转主动推送，**不截断**（基底同策略）。
     * ★ 不再使用 msgtype:'text'：企微被动回复通道不认，实测 errcode=40008（2026-09-17 真机）。
     */
    async sendText(chatId: string, text: string): Promise<unknown> {
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      if (!text.trim()) return undefined;
      // G3：已失效的帧直接用主动推送（不再死磕失效帧）
      const frame = invalidatedFrames.has(chatId) ? undefined : c.replyFrameFor(chatId);
      if (!frame) return this.sendMarkdown(chatId, text);
      const [head = "", ...rest] = splitMessageByBytes(text, WECOM_STREAM_BYTE_LIMIT);
      // ★ 正向出站日志：成功路径原本静默（SDK debug 关闭），验收时无法拿日志说话
      deps.logger?.info?.(
        `企微出站：帧回复 replyStream ${utf8Length(head)}B${rest.length ? ` + 溢出转主动推送 ${utf8Length(rest.join(""))}B` : ""}`,
      );
      try {
        await withRetry(() => c.replyStream(frame, newStreamId(), head, true));
      } catch (err) {
        // ★ 阿深修正（2026-10-02 验收）：G3 要求"replyStream 失败 → 立即失效该帧 + 同函数内降级"，
        //   而这里原本**没有 try/catch**（beginStream 与 stream 两处都有）→ 帧失效时会直接抛给上层，
        //   让普通回复落进 outbox 死信（生产那条 [object Object] 失败项即此类）。
        //   由 tests/outbound/wecom-sender-stage3.test.ts 的 G3 用例抓到（它断言后续 sendText 走 markdown 通道）。
        invalidatedFrames.add(chatId);
        deps.logger?.warn?.(
          `企微出站：sendText replyStream 失败，失效该帧并降级主动推送: ${err instanceof Error ? err.message : String(err)}`,
        );
        return this.sendMarkdown(chatId, text); // 用原文整篇推送，不丢内容
      }
      if (rest.length) await this.sendMarkdown(chatId, rest.join(""));
      return undefined;
    },

    /** 主动推送 markdown（sendMessage 通道，无需回调帧） */
    async sendMarkdown(chatId: string, text: string): Promise<unknown> {
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      const chunks = splitMessageByBytes(text, WECOM_TEXT_BYTE_LIMIT);
      deps.logger?.info?.(`企微出站：主动推送 markdown ${chunks.length} 片 / ${utf8Length(text)}B`);
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
     * ★ G3：replyStream 失败 → 失效帧 + 降级主动推送，返回 undefined。
     */
    async beginStream(chatId: string, firstChunk: string): Promise<WecomStreamHandle | undefined> {
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      const frame = invalidatedFrames.has(chatId) ? undefined : c.replyFrameFor(chatId);
      if (!frame) {
        await this.sendMarkdown(chatId, firstChunk);
        return undefined;
      }
      const streamId = newStreamId();
      // 首片按字节上限取，不用 slice 按字符截断（同一单位混用缺陷族）
      const head = splitMessageByBytes(firstChunk, WECOM_STREAM_BYTE_LIMIT)[0] ?? "";
      try {
        await withRetry(() => c.replyStream(frame, streamId, head, false));
      } catch (err) {
        invalidatedFrames.add(chatId);
        deps.logger?.warn?.(
          `企微出站：beginStream replyStream 失败，失效该帧并降级主动推送: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.sendMarkdown(chatId, firstChunk);
        return undefined;
      }
      deps.logger?.info?.(`企微出站：开启流式 ${utf8Length(head)}B`);
      activeStreams.set(chatId, streamId);
      activeStreamSeenAt.set(chatId, Date.now());
      scheduleIdleSweep();
      return { chatId, streamId };
    },

    /**
     * 刷新流式内容；finish=true 结束并清除登记。
     * ★ G1（2026-10-02）：企微 stream 帧是**全量替换**语义（同 streamId 刷新同一条气泡）——
     *   旧实现对同一 streamId 按 19000B 连发多片 → 前面内容被覆盖丢失（>6000 汉字只剩最后一片）。
     *   修法：同一 streamId 只发一帧；超上限时复用 sendText 的正确路径（head 走 replyStream +
     *   溢出转 sendMarkdown），全文不丢。
     * ★ G3（2026-10-02）：replyStream 失败 → 立即失效该帧 + 降级 sendMarkdown 重发（不再死磕失效帧）。
     */
    async stream(handle: WecomStreamHandle | undefined, content: string, finish: boolean): Promise<unknown> {
      if (!handle) return undefined; // 已降级为终稿直发
      const c = client();
      if (!c) throw new Error("企微客户端未就绪");
      const finishAndCleanup = (): void => {
        if (finish) {
          activeStreams.delete(handle.chatId);
          deps.logger?.info?.(`企微出站：流式收尾 ${utf8Length(content)}B`);
        }
      };
      // G3：帧已失效或无帧 → 降级主动推送（不重试同一张帧）
      const frame = invalidatedFrames.has(handle.chatId) ? undefined : c.replyFrameFor(handle.chatId);
      if (!frame) {
        activeStreams.delete(handle.chatId);
        deps.logger?.warn?.(`企微出站：无可用回调帧，流式降级主动推送 markdown（${utf8Length(content)}B）`);
        return this.sendMarkdown(handle.chatId, content);
      }
      if (utf8Length(content) <= WECOM_STREAM_BYTE_LIMIT) {
        // 常规路径：单帧全量
        activeStreamSeenAt.set(handle.chatId, Date.now());
        try {
          await withRetry(() => c.replyStream(frame, handle.streamId, content, finish));
          finishAndCleanup();
          return undefined;
        } catch (err) {
          invalidatedFrames.add(handle.chatId);
          deps.logger?.warn?.(
            `企微出站：replyStream 失败，失效该帧并降级主动推送: ${err instanceof Error ? err.message : String(err)}`,
          );
          finishAndCleanup();
          return this.sendMarkdown(handle.chatId, content);
        }
      }
      // G1：内容超单帧上限 → head 走流式气泡 + 溢出转主动推送（全文不丢，绝不连发多片）
      const [head = "", ...rest] = splitMessageByBytes(content, WECOM_STREAM_BYTE_LIMIT);
      try {
        // ★ 阿深修正（2026-10-02 验收）：head 帧必须**照常透传 finish**。
        //   溢出内容走的是**独立的 sendMarkdown 消息**，不会回填这条气泡，所以 finish 与
        //   rest.length 无关。原写法 `finish && rest.length === 0` 会让"超限 + finish=true"
        //   场景**永不发出 finish** → 企微气泡永久停在"生成中"。
        //   （这一点由既有用例 tests/outbound/wecom-sender.test.ts 的 R3 抓到，当时被误判为
        //    "G1 语义变更需要改测试"——实际是实现的收尾缺陷。）
        await withRetry(() => c.replyStream(frame, handle.streamId, head, finish));
      } catch (err) {
        invalidatedFrames.add(handle.chatId);
        deps.logger?.warn?.(
          `企微出站：replyStream（超限 head）失败，整篇降级主动推送: ${err instanceof Error ? err.message : String(err)}`,
        );
        finishAndCleanup();
        return this.sendMarkdown(handle.chatId, content);
      }
      if (rest.length) {
        deps.logger?.info?.(`企微出站：流式超限，溢出 ${utf8Length(rest.join(""))}B 转主动推送（G1：不再连发多片）`);
        await this.sendMarkdown(handle.chatId, rest.join(""));
      }
      finishAndCleanup();
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
