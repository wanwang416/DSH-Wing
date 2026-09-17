/**
 * 企微流式卡片适配（对齐 StreamingCard 被体验层使用的接口，内部走企微 replyStream）。
 *
 * 差异与降级：
 *   - 企微长连接一期无「模板卡片」富面板（思考/工具/上下文不推，仅日志）；
 *     体验层仍会调 addThinking/addTool/addContext —— 这里静默忽略，保持接口兼容。
 *   - 回答流式：beginStream（首个 chunk，finish=false）→ stream（节流刷新）→ finish=true。
 *   - 无回调帧（outbox 补发/主动场景）→ beginStream 内部降级 sendMarkdown 终稿，返回 undefined handle。
 *   - 节流对齐 StreamingCard：STREAM_INTERVAL_MS=1500 / STREAM_MIN_DELTA=30（防企微单会话限频 30 条/分）。
 */

import type { WecomSender, WecomStreamHandle } from "./wecom-sender.js";
import type { StreamCardHandle } from "./streaming-card.js";

export interface WecomStreamCardDeps {
  sender: WecomSender;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** 降级回调：流式不可用时回退普通文本（对齐 StreamingCard.onFallback 语义） */
  onFallback?(chatId: string, text: string): Promise<void>;
}

export const WECOM_STREAM_INTERVAL_MS = 1500;
export const WECOM_STREAM_MIN_DELTA = 30;

export class WecomStreamCard implements StreamCardHandle {
  private chatId: string;
  private deps: WecomStreamCardDeps;
  private answer = "";
  private handle: WecomStreamHandle | undefined;
  private failed = false;
  private lastStreamAt = 0;
  private lastStreamLen = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(chatId: string, deps: WecomStreamCardDeps) {
    this.chatId = chatId;
    this.deps = deps;
  }

  /** 思考流式：企微一期无面板，静默（保持接口兼容） */
  async addThinking(_delta: string): Promise<void> {
    void _delta;
  }

  /** 回答流式累积：节流刷新（1500ms / 30 字符，对齐 StreamingCard 打字机节流） */
  async addText(delta: string): Promise<void> {
    if (this.failed || !delta) return;
    this.answer += delta;
    const now = Date.now();
    const deltaLen = this.answer.length - this.lastStreamLen;
    if (this.lastStreamAt !== 0 && deltaLen < WECOM_STREAM_MIN_DELTA && now - this.lastStreamAt < WECOM_STREAM_INTERVAL_MS) {
      // 节流命中：安排一次防抖刷新，避免连续小 chunk 高频发帧
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => {
        void this.push(false).catch(() => void 0);
      }, WECOM_STREAM_INTERVAL_MS);
      return;
    }
    await this.push(false);
  }

  /** 工具调用步骤：企微一期无面板，静默 */
  async addTool(_name: string, _input?: string): Promise<void> {
    void _name;
    void _input;
  }

  /** 工具结果：静默 */
  async setToolResult(_name: string, _error?: unknown): Promise<void> {
    void _name;
    void _error;
  }

  /** 上下文注入：静默 */
  async addContext(_text?: string): Promise<void> {
    void _text;
  }

  /** 当前累积正文（供 finalize 判断是否有产出） */
  get latestAnswer(): string {
    return this.answer;
  }

  /** 企微无卡片 ID（无模板卡片能力），恒返回空串（对齐 StreamCardHandle） */
  get cardId(): string {
    return "";
  }

  /** 真正落地：finish=true 结束流；无流式 handle → 降级普通文本 */
  async finalize(answer: string): Promise<void> {
    await this.finish(answer);
  }

  /** ★ 对齐 StreamingCard.finalizeToNewCard：企微无「独立结果卡」概念，语义同 finalize（结束流式） */
  async finalizeToNewCard(answer: string): Promise<boolean> {
    const text = (answer ?? "").trim();
    if (!text || text === "No response.") return false;
    try {
      await this.finish(text);
      return true;
    } catch (err) {
      this.deps.logger?.warn?.(`企微流式收尾失败: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async push(finish: boolean): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const content = this.answer.trim();
    if (!content) return;
    this.lastStreamAt = Date.now();
    this.lastStreamLen = this.answer.length;
    if (!this.handle) {
      // 首个 chunk：开启流式（无回调帧时 sender 内部降级 sendMarkdown 终稿，返回 undefined）
      this.handle = (await this.deps.sender.beginStream(this.chatId, content)) ?? undefined;
      return;
    }
    await this.deps.sender.stream(this.handle, content, finish);
  }

  private async finish(answer: string): Promise<void> {
    const text = (answer ?? "").trim();
    if (this.failed) {
      if (text && text !== "No response.") await this.deps.onFallback?.(this.chatId, text);
      return;
    }
    if (!text) return;
    this.answer = text;
    if (this.handle) {
      try {
        await this.deps.sender.stream(this.handle, text, true);
        this.handle = undefined;
        return;
      } catch (err) {
        this.deps.logger?.warn?.(`企微流式 finish 失败，降级普通文本: ${err instanceof Error ? err.message : String(err)}`);
        this.failed = true;
      }
    }
    // 无流式 handle（无回调帧）或流式失败 → 终稿普通文本
    if (text !== "No response.") await this.deps.onFallback?.(this.chatId, text);
  }
}
