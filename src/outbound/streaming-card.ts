/**
 * StreamingCard — 单卡流式（★M2 前置 4：单卡流式呈现机制）
 *
 * 参考：
 * - 成熟桥接实现 `engine.go` 流式卡片构建 + 卡片构建逻辑：
 *   💭思考 + 🔧工具 + 回答 聚合进**一张可持续更新的卡片**，工具可见不单独发消息
 * - 飞书实现：interactive 卡片（markdown 元素）+ im.message.update 更新
 *   （基础卡片接口，权限要求低于 成熟桥接 的 CardKit 高级 API）
 *
 * 降级：卡片创建/更新失败 → onFallback 回调（调用方回退普通 text 消息）
 */

import type { Sender } from "./sender.js";

export interface CardToolEntry {
  index: number;
  name: string;
  input?: string;
}

/** 复用已验证的单卡构建模式：构造卡片 markdown */
export function buildCardMarkdown(thinking: string, tools: CardToolEntry[], answer: string): string {
  const sb: string[] = [];
  if (thinking) {
    sb.push("💭 **Thinking**\n\n" + thinking + "\n\n---\n\n");
  }
  for (const t of tools) {
    sb.push(`🔧 **Tool #${t.index}**: \`${t.name}\``);
    if (t.input) sb.push("\n" + t.input);
    sb.push("\n\n");
  }
  if (answer) {
    if (tools.length > 0 || thinking) sb.push("---\n\n");
    sb.push(answer);
  }
  return sb.join("");
}

/** 飞书 interactive 卡片 JSON（markdown 单元素） */
export function buildCardJson(markdown: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: "markdown",
          content: markdown || " ",
        },
      ],
    },
  });
}

export interface StreamingCardDeps {
  sender: Sender;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** 降级回调：卡片不可用时回退普通消息 */
  onFallback?(chatId: string, text: string): Promise<void>;
}

export class StreamingCard {
  private chatId: string;
  private deps: StreamingCardDeps;
  private messageId: string | undefined;
  private thinking = "";
  private tools: CardToolEntry[] = [];
  private answer = "";
  private toolCounter = 0;
  private lastPatchLength = 0;  // 上次更新时的内容长度
  private lastPatchAt = 0;
  private failed = false;

  constructor(chatId: string, deps: StreamingCardDeps) {
    this.chatId = chatId;
    this.deps = deps;
  }

  private markdown(): string {
    return buildCardMarkdown(this.thinking, this.tools, this.answer);
  }

  private async ensureCreated(): Promise<boolean> {
    if (this.messageId) return true;
    try {
      const res = (await this.deps.sender.sendCard(this.chatId, JSON.parse(buildCardJson(this.markdown() || "💭 思考中…")))) as any;
      // 兼容多种返回格式：
      // - { data: { message_id } } (SDK 标准)
      // - { message_id } (直接返回)
      // - { data: { item: { message_id } } } (某些 API 变体)
      this.messageId = 
        res?.data?.message_id ?? 
        res?.message_id ?? 
        res?.data?.item?.message_id;
      if (!this.messageId) {
        // 调试：把整个响应打出来，方便定位
        console.warn("[dsh-wing] sendCard response didn't have message_id. Full response:", JSON.stringify(res, null, 2));
        throw new Error(`sendCard 未返回 message_id. Response: ${JSON.stringify(res).slice(0, 200)}`);
      }
      this.lastPatchLength = this.markdown().length;
      this.lastPatchAt = Date.now();
      return true;
    } catch (err) {
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard 创建失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
      // 额外把错误写到文件方便诊断
      try {
        const fs = require("fs");
        fs.appendFileSync("本地目录/wing/streaming-card-error.log", `${new Date().toISOString()} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      } catch {}
      return false;
    }
  }

  /** 更新卡片：混合节流 → 时间间隔 ≥ 3000ms **OR** 内容变化 ≥ 50 字符 → 满足一个就更新，避免飞书限流 */
  private async shouldPatch(): Promise<void> {
    if (!(await this.ensureCreated())) return;
    const currentLen = this.markdown().length;
    const lenDiff = Math.abs(currentLen - this.lastPatchLength);
    const now = Date.now();
    const timeDiff = now - this.lastPatchAt;
    // 满足一个就更新
    if (lenDiff < 50 && timeDiff < 3000) return;
    this.lastPatchLength = currentLen;
    this.lastPatchAt = now;
    try {
      await this.deps.sender.updateCard(this.messageId!, buildCardJson(this.markdown()));
    } catch (err) {
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard 更新失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 思考流式累积（assistant/chunk） */
  async addThinking(delta: string): Promise<void> {
    if (this.failed) return;
    this.thinking += delta;
    await this.shouldPatch();
  }

  /** 工具调用记录（tool/call + tool/result） */
  async addTool(name: string, input?: string, error?: unknown): Promise<void> {
    if (this.failed) return;
    this.toolCounter += 1;
    this.tools.push({
      index: this.toolCounter,
      name: error ? `${name} ❌` : name,
      input,
    });
    await this.shouldPatch();
  }

  /** 最终回答（assistant/message）：完整卡片落地 */
  async finalize(answer: string): Promise<void> {
    if (this.failed) {
      // 卡片不可用：降级为普通消息（完整回答）
      if (answer && answer.trim() !== "" && answer.trim() !== "No response.") {
        await this.deps.onFallback?.(this.chatId, answer);
      }
      return;
    }
    this.answer = answer;
    if (!(await this.ensureCreated())) return;
    try {
      // 最终更新：包含完整的 思考+工具+回答
      await this.deps.sender.updateCard(this.messageId!, buildCardJson(this.markdown()));
    } catch (err) {
      this.failed = true;
      this.deps.logger?.warn?.(`StreamingCard finalize 失败，降级普通消息: ${err instanceof Error ? err.message : String(err)}`);
      if (answer && answer.trim() !== "" && answer.trim() !== "No response.") {
        await this.deps.onFallback?.(this.chatId, answer);
      }
    }
  }

  get cardId(): string {
    return this.messageId ?? "";
  }
}