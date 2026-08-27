/**
 * StreamingCard — 单卡流式（★M2 前置 4：单卡流式呈现机制；★M3 任务 2：CardKit 打字机；★M3 任务 3：ToolStep 富卡片）
 *
 * 参考成熟桥接实现（本地目录\tools\既有桥接源码\）：
 * - core/streaming.go：StreamPreviewCfg（IntervalMs=1500, MinDeltaChars=30）+ ToolStep 结构
 * - platform/feishu/feishu.go：buildRichCardJSONBytes (6537) 多元素卡片 + richPanelElements (6453) 分行 + maxRichCardJSONBytes=28000 (6489)
 * - platform/feishu/feishu.go：StreamRichCardText (4637) CardKit 流式 PUT + createCardEntity (4594) + SendPreviewStart (4486)
 *
 * 卡片结构（对齐基底 BuildRichCard）：
 *   header（状态色） + [Reasoning collapsible_panel] + [Tools collapsible_panel] + main_text（回答，element_id） + [footer]
 *
 * 更新策略（对齐基底：reasoning/tool 走 panels 全量更新，回答走 CardKit 流式打字机）：
 *   - 回答 text-delta → CardKit PUT main_text（打字机），失败降级 inline updateMessage
 *   - 思考/工具步骤变化 → 全量 updateMessage（buildRichCardJson），>28KB 自动压缩/降级单 markdown
 *   - 三级降级链（B2/C2）：CardKit 流式 PUT → im.message.update（全量）→ 普通 text（onFallback）
 */

import type { Sender } from "./sender.js";
import { ToolStep, truncateText, compactSteps, stepsFallbackMarkdown } from "./tool-step.js";

export type { ToolStep } from "./tool-step.js";

/** 流式节流（对齐基底 StreamPreviewCfg：IntervalMs=1500, MinDeltaChars=30） */
export const STREAM_INTERVAL_MS = 1500;
export const STREAM_MIN_DELTA = 30;
/** 思考面板最大长度（对齐基底 display.ThinkingMaxLen 量级） */
export const THINKING_MAX_LEN = 2000;
/** 飞书卡片 payload 上限（对齐基底 maxRichCardJSONBytes） */
export const MAX_RICH_CARD_BYTES = 28000;
/** 富卡片面板单类最多展示步骤（对齐基底 richPanelElements maxPanelSteps） */
export const MAX_PANEL_STEPS = 10;

export interface CardToolEntry {
  index: number;
  name: string;
  input?: string;
}

/** 单 markdown 卡片（inline 降级 / CardKit 创建兜底用） */
export function buildCardJson(markdown: string, streaming = true): string {
  return JSON.stringify({
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: streaming,
      enable_forward_interaction: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: "main_text",
          content: markdown || " ",
        },
      ],
    },
  });
}

function buildPanelElements(steps: ToolStep[]): Array<Record<string, unknown>> {
  const { visible, hidden } = compactSteps(steps, MAX_PANEL_STEPS);
  const elements: Array<Record<string, unknown>> = [];
  if (hidden > 0) {
    elements.push({
      tag: "div",
      text: { tag: "plain_text", content: `... ${hidden} 个更早步骤已隐藏`, text_size: "notation", text_color: "grey" },
    });
  }
  for (const step of visible) {
    const icon = step.kind === "context" ? "📥" : step.kind === "thinking" ? "💭" : step.error ? "❌" : step.done ? "✅" : "🔧";
    const name = step.kind === "thinking" ? "Thinking" : step.kind === "context" ? "上下文注入" : step.name;
    let content = `${icon} ${name}`;
    if (step.summary) {
      const line = step.summary.includes("\n") ? step.summary.split("\n")[0] : step.summary;
      if (line && line !== name) content += ` — ${line}`;
    }
    if (step.result && step.result !== step.summary) {
      const line = step.result.includes("\n") ? step.result.split("\n")[0] : step.result;
      if (line) content += ` · ${line}`;
    }
    const text: Record<string, unknown> = { tag: "plain_text", content, text_size: "notation" };
    if (step.kind === "thinking") text.text_color = "grey";
    elements.push({ tag: "div", text });
  }
  return elements;
}

function buildRichPanel(title: string, expanded: boolean, elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded,
    background_color: "grey",
    header: { title: { tag: "plain_text", content: title } },
    border: { color: "grey" },
    vertical_spacing: "8px",
    padding: "4px 8px",
    elements,
  };
}

export function buildRichCardJson(
  steps: ToolStep[],
  answer: string,
  streaming: boolean,
  headerTemplate: "blue" | "green" | "red" = "blue",
  headerTitle = "Working…",
): string {
  const reasoning = steps.filter((s) => s.kind === "thinking");
  const tools = steps.filter((s) => s.kind !== "thinking");
  const panels: Array<Record<string, unknown>> = [];
  if (reasoning.length > 0) {
    panels.push(buildRichPanel(`Reasoning (${reasoning.length})`, false, buildPanelElements(reasoning)));
  }
  if (tools.length > 0) {
    panels.push(buildRichPanel(`Tools (${tools.length})`, false, buildPanelElements(tools)));
  }
  if (panels.length === 0 && streaming) {
    panels.push(buildRichPanel("Reasoning", true, buildPanelElements([{ kind: "thinking", name: "Thinking", summary: "Thinking...", done: true }])));
  }

  const elements: Array<Record<string, unknown>> = [
    ...panels,
    {
      tag: "markdown",
      element_id: "main_text",
      content: answer || " ",
    },
  ];

  return JSON.stringify({
    schema: "2.0",
    config: { streaming_mode: streaming, update_multi: true, enable_forward_interaction: true },
    header: {
      template: headerTemplate,
      title: { tag: "plain_text", content: headerTitle },
    },
    body: { elements },
  });
}

/** 超限压缩：逐步减少每类步骤数 + 截断文本（对齐基底 compactRichStepsForCardSize 三级） */
function compactStepsForSize(steps: ToolStep[], perLane: number, textLen: number): ToolStep[] {
  const reasoning: ToolStep[] = [];
  const tools: ToolStep[] = [];
  for (const s of steps) {
    if (s.kind === "thinking") reasoning.push(s);
    else tools.push(s);
  }
  const pick = (arr: ToolStep[]): ToolStep[] => {
    if (arr.length <= perLane) return arr.map((s) => ({ ...s, summary: truncateText(s.summary, textLen), result: s.result ? truncateText(s.result, textLen) : undefined }));
    return arr
      .slice(arr.length - perLane)
      .map((s) => ({ ...s, summary: truncateText(s.summary, textLen), result: s.result ? truncateText(s.result, textLen) : undefined }));
  };
  return [...pick(reasoning), ...pick(tools)];
}

export interface StreamingCardDeps {
  sender: Sender;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** 降级回调：卡片不可用时回退普通消息 */
  onFallback?(chatId: string, text: string): Promise<void>;
  /** ★ M3 任务 2：CardKit 流式能力（可选；无则纯 updateMessage 降级） */
  cardkit?: {
    create(chatId: string, cardJson: string): Promise<{ messageId: string; cardId: string }>;
    stream(cardId: string, content: string, sequence: number): Promise<unknown>;
  };
}

export class StreamingCard {
  private chatId: string;
  private deps: StreamingCardDeps;
  private messageId: string | undefined;
  private _cardId: string | undefined;
  private streamMode: "cardkit" | "inline" = "inline";
  private sequence = 0;
  /** 串行化 CardKit PUT：保证 sequence 单调递增（对齐基底 StreamRichCardText 的 mutex） */
  private streamQueue: Promise<unknown> = Promise.resolve();
  /** ★M3：工具/思考/上下文步骤列表（分行展示） */
  private steps: ToolStep[] = [];
  private answer = "";
  private status: "working" | "done" | "error" = "working";
  private lastPatchLength = 0; // 上次全量更新时的内容长度（面板+回答）
  private lastPatchAt = 0;
  private lastStreamAt = 0;
  private lastStreamText = "";
  private failed = false;

  // ★ M3 修复：addThinking 防抖合并：避免 reasoning 每小段都 PATCH，短时间多 chunk 合并
  private thinkingTimeout: NodeJS.Timeout | null = null;
  private pendingThinking = false;
  // ★ 全局防抖：所有面板更新合并，短时间多次操作只发一次 PATCH，避免飞书 230020 限频
  private updateTimeout: NodeJS.Timeout | null = null;

  constructor(chatId: string, deps: StreamingCardDeps) {
    this.chatId = chatId;
    this.deps = deps;
  }

  /** 全量内容长度（面板行 + 回答，用于节流判断） */
  private contentLength(): number {
    return this.steps.reduce((n, s) => n + s.name.length + s.summary.length + (s.result?.length ?? 0), 0) + this.answer.length;
  }

  private headerTemplate(): "blue" | "green" | "red" {
    if (this.status === "done") return "green";
    if (this.status === "error") return "red";
    return "blue";
  }

  private headerTitle(): string {
    if (this.status === "done") return "Done";
    if (this.status === "error") return "Error";
    return "Working…";
  }

  /**
   * 完整富卡片 JSON，超限自动压缩/降级单 markdown（C2）。
   * 返回 { json, degraded }；degraded=true 表示已降级为单 markdown 卡片。
   */
  private fullCardJson(streaming: boolean): { json: string; degraded: boolean } {
    let json = buildRichCardJson(this.steps, this.answer, streaming, this.headerTemplate(), this.headerTitle());
    if (json.length <= MAX_RICH_CARD_BYTES) return { json, degraded: false };
    for (const [perLane, textLen] of [
      [10, 180],
      [6, 120],
      [3, 80],
    ] as const) {
      const compacted = compactStepsForSize(this.steps, perLane, textLen);
      json = buildRichCardJson(compacted, this.answer, streaming, this.headerTemplate(), this.headerTitle());
      if (json.length <= MAX_RICH_CARD_BYTES) return { json, degraded: false };
    }
    // 最终降级：单 markdown 卡片（步骤摘要列表 + 回答）
    const fallbackMd = stepsFallbackMarkdown(this.steps);
    const md = fallbackMd ? `${fallbackMd}\n\n${this.answer}` : this.answer;
    return { json: buildCardJson(md, streaming), degraded: true };
  }

  private async ensureCreated(): Promise<boolean> {
    if (this.messageId) return true;
    const initial = this.fullCardJson(true).json;
    // 1) CardKit 两步创建（打字机路径）
    if (this.deps.cardkit) {
      try {
        const res = await this.deps.cardkit.create(this.chatId, initial);
        this.messageId = res.messageId;
        this._cardId = res.cardId;
        this.streamMode = "cardkit";
        // 不设 lastPatch*：创建后首次 patch 强制发送，保证步骤/回答可见
        return true;
      } catch (err) {
        this.deps.logger?.warn?.(`CardKit 创建失败，降级 inline 卡片: ${err instanceof Error ? err.message : String(err)}`);
        // fall through 到 inline 路径
      }
    }
    // 2) inline 卡片（im.message.update 全量更新）
    try {
      const res = (await this.deps.sender.sendCard(this.chatId, JSON.parse(initial))) as any;
      // 兼容多种返回格式：
      // - { data: { message_id } } (SDK 标准)
      // - { message_id } (直接返回)
      // - { data: { item: { message_id } } } (某些 API 变体)
      this.messageId = res?.data?.message_id ?? res?.message_id ?? res?.data?.item?.message_id;
      if (!this.messageId) {
        console.warn("[dsh-wing] sendCard response didn't have message_id. Full response:", JSON.stringify(res, null, 2));
        throw new Error(`sendCard 未返回 message_id. Response: ${JSON.stringify(res).slice(0, 200)}`);
      }
      this.streamMode = "inline";
      // 不设 lastPatch*：创建后首次 patch 强制发送，保证步骤/回答可见
      return true;
    } catch (err) {
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard 创建失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** CardKit PUT 串行化：sequence 单调递增，避免并发竞争（对齐基底 mutex） */
  private streamContent(content: string): Promise<unknown> {
    const task = this.streamQueue.then(() => {
      if (!this.deps.cardkit || !this._cardId) throw new Error("cardkit 不可用");
      this.sequence += 1;
      return this.deps.cardkit.stream(this._cardId!, content, this.sequence);
    });
    this.streamQueue = task.catch(() => void 0);
    return task;
  }

  /**
   * 全量更新卡片（步骤变化 / 最终落地）：buildRichCardJson（含 panels + main_text）。
   * 节流：时间 ≥ 1500ms OR 内容变化 ≥ 30 字符 → 满足一个就更新。
   * 失败降级链：cardkit 模式 → inline updateMessage → text（onFallback）
   */
  private async patchFull(): Promise<void> {
    if (!(await this.ensureCreated())) return;
    const currentLen = this.contentLength();
    const lenDiff = Math.abs(currentLen - this.lastPatchLength);
    const now = Date.now();
    const timeDiff = now - this.lastPatchAt;
    // 节流：非首次（lastPatchAt 已设）且（内容变化小 且 时间间隔短）→ 跳过合并。
    // 工具步骤是离散事件（done/error 状态变化不影响长度），故只做时间防抖，不限制 delta。
    if (this.lastPatchAt !== 0 && timeDiff < STREAM_INTERVAL_MS && lenDiff < STREAM_MIN_DELTA) return;
    this.lastPatchLength = currentLen;
    this.lastPatchAt = now;
    try {
      await this.deps.sender.updateCard(this.messageId!, this.fullCardJson(false).json);
    } catch (err) {
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard 全量更新失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
      const answer = this.answer.trim();
      if (answer && answer !== "No response.") {
        await this.deps.onFallback?.(this.chatId, answer);
      }
    }
  }

  /** 全局防抖：串行化所有 patch，避免飞书限频 */
  private async patchDebounced(): Promise<void> {
    if (this.failed) return;
    const currentLen = this.contentLength();
    const lenDiff = Math.abs(currentLen - this.lastPatchLength);
    const now = Date.now();
    const timeDiff = now - this.lastPatchAt;
    if (this.lastPatchAt !== 0 && timeDiff < STREAM_INTERVAL_MS && lenDiff < STREAM_MIN_DELTA) return;
    this.lastPatchLength = currentLen;
    this.lastPatchAt = now;
    try {
      await this.deps.sender.updateCard(this.messageId!, this.fullCardJson(false).json);
    } catch (err) {
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard 全量更新失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
      const answer = this.answer.trim();
      if (answer && answer !== "No response.") {
        await this.deps.onFallback?.(this.chatId, answer);
      }
    }
  }

  /** 回答流式（text-delta）：CardKit 打字机 PUT main_text；失败降级 inline 全量更新 */
  private async patchAnswer(): Promise<void> {
    if (!(await this.ensureCreated())) return;
    const now = Date.now();
    const timeDiff = now - this.lastStreamAt;
    const delta = this.answer.length - this.lastStreamText.length;
    // 节流：非首次且（字符变化小 且 时间间隔短）→ 跳过合并（打字机节流）
    if (this.lastStreamAt !== 0 && delta < STREAM_MIN_DELTA && timeDiff < STREAM_INTERVAL_MS) return;
    this.lastStreamAt = now;
    this.lastStreamText = this.answer;
    try {
      if (this.streamMode === "cardkit") {
        await this.streamContent(this.answer);
        return;
      }
      await this.patchDebounced();
    } catch (err) {
      // 一级降级：CardKit → inline updateMessage
      if (this.streamMode === "cardkit") {
        this.deps.logger?.warn?.(`CardKit 流式失败，降级 updateMessage: ${err instanceof Error ? err.message : String(err)}`);
        this.streamMode = "inline";
        try {
          await this.deps.sender.updateCard(this.messageId!, this.fullCardJson(false).json);
          return;
        } catch (err2) {
          err = err2;
        }
      }
      // 二级降级：inline → text
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard 回答更新失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 全局防抖调度：短时间多个面板更新合并为一次全量PATCH */
  private schedulePatch(): void {
    if (this.failed) return;
    if (this.updateTimeout) clearTimeout(this.updateTimeout);
    this.updateTimeout = setTimeout(() => {
      this.patchFull();
    }, STREAM_INTERVAL_MS);
  }

  /** 思考流式累积（reasoning-delta）→ 面板更新（全量） */
  async addThinking(delta: string): Promise<void> {
    if (this.failed || !delta) return;
    const last = this.steps[this.steps.length - 1];
    if (last?.kind === "thinking") {
      last.summary = truncateText(last.summary + delta, THINKING_MAX_LEN);
    } else {
      this.steps.push({ kind: "thinking", name: "Thinking", summary: truncateText(delta, THINKING_MAX_LEN), done: true });
    }

    // ★ M3 修复：防抖合并短间隔 delta，避免短时间多次 PATCH 触发飞书限频
    if (this.thinkingTimeout) clearTimeout(this.thinkingTimeout);
    this.thinkingTimeout = setTimeout(() => {
      this.patchFull();
    }, STREAM_INTERVAL_MS);
    this.pendingThinking = true;
  }

  /** 回答流式累积（text-delta）→ main_text 打字机 */
  async addText(delta: string): Promise<void> {
    if (this.failed) return;
    this.answer += delta;
    this.schedulePatch();
  }

  /** 工具调用步骤（tool/call）→ Tools 面板新增一行 */
  async addTool(name: string, input?: string): Promise<void> {
    if (this.failed) return;
    this.steps.push({ kind: "tool", name, summary: input ?? "", done: false });
    this.schedulePatch();
  }

  /** 工具结果（tool/result）→ 更新对应步骤的 done/result（对齐基底 ToolStep.Done/Result） */
  async setToolResult(name: string, error?: unknown): Promise<void> {
    if (this.failed) return;
    // 找最后一个同 name 且未 done 的 tool 步骤
    let step: ToolStep | undefined;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.steps[i].kind === "tool" && this.steps[i].name === name && !this.steps[i].done) {
        step = this.steps[i];
        break;
      }
    }
    if (!step) return;
    step.done = true;
    if (error) {
      step.error = true;
      this.status = "error";
    }
    this.schedulePatch();
  }

  /** 上下文注入（user/message source.kind !== "user"）→ Tools 面板新增 📥 行 */
  async addContext(text?: string): Promise<void> {
    if (this.failed) return;
    this.steps.push({ kind: "context", name: "上下文注入", summary: truncateText(text ?? "", 120), done: true });
    this.schedulePatch();
  }

  /** 最终回答（assistant/message）：完整卡片落地 */
  async finalize(answer: string): Promise<void> {
    if (this.failed) {
      if (answer && answer.trim() !== "" && answer.trim() !== "No response.") {
        await this.deps.onFallback?.(this.chatId, answer);
      }
      return;
    }
    this.answer = answer;
    this.status = answer.trim() ? "done" : this.status;
    if (!(await this.ensureCreated())) return;
    try {
      await this.deps.sender.updateCard(this.messageId!, this.fullCardJson(false).json);
    } catch (err) {
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard finalize 失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
      if (answer && answer.trim() !== "" && answer.trim() !== "No response.") {
        await this.deps.onFallback?.(this.chatId, answer);
      }
    }
  }

  get cardId(): string {
    return this._cardId ?? "";
  }
}
