/**
 * ★ 体验契约（阿深体感核心修正 + M2 前置 4 参考成熟桥接实现）
 *
 * - StreamingCard 单卡流式：💭思考 + 🔧工具 + 回答 聚合**一张可更新卡片**
 *   （复用已验证的单卡构建模式；替换 M1 的 text 多消息+合并缓冲）
 * - 插话：agent.status === "running" → steer()（★M0 Spike 7：温和打断）；idle → followup()
 * - 停止："停"/"停下来"/"别写了"等 → cancel({kind:"user"})
 * - 工具可见：tool/call + tool/result → 进卡片（🔧 Tool #N），不单独发消息
 * - 表情：收到→随机；完成→DONE；失败→CrossMark
 * - 降级：卡片创建/更新失败 → 回退普通 text 消息（完整回答单条）
 */

import type { WingConfig } from "../config/defaults.js";
import { StreamingCard } from "../outbound/streaming-card.js";

/** 诊断日志：落盘 本地目录/wing/steer-diag.log（steer 真机排障用，问题定位后移除） */
function diagLog(msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs");
    fs.appendFileSync("本地目录/wing/steer-diag.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // 忽略
  }
}

export interface TurnSupervisorLike {
  arm(key: string): void;
  disarm(key: string): void;
}

export interface ExperienceDeps {
  /** 普通消息发送（卡片降级用） */
  sendText(chatId: string, text: string): Promise<void>;
  /** StreamingCard 工厂（index.ts 组装时提供 sender/onFallback） */
  createStreamCard(chatId: string): StreamingCard;
  addReaction(messageId: string, emoji: string): Promise<void>;
  turnSupervisor: TurnSupervisorLike;
  cfg: () => WingConfig;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

interface StreamState {
  card?: StreamingCard;
  hasOutput: boolean;
}

export function createExperience(deps: ExperienceDeps) {
  const streams = new Map<string, StreamState>();
  /** chatId → 最近入站 messageId（reaction 目标） */
  const reactionTarget = new Map<string, string>();

  const st = (chatId: string): StreamState => {
    let s = streams.get(chatId);
    if (!s) {
      s = { hasOutput: false };
      streams.set(chatId, s);
    }
    return s;
  };

  return {
    /** 入站消息已接收：记录 reaction 目标 + 加"已收到"随机表情 */
    onInbound(chatId: string, messageId: string): void {
      reactionTarget.set(chatId, messageId);
      if (deps.cfg().reactions.enabled) {
        deps.addReaction(messageId, pickReaction(deps.cfg())).catch(() => void 0);
      }
    },

    /** turn/start：创建 StreamingCard（"思考中"）+ arm 轮次监督 */
    onTurnStart(chatId: string): void {
      const s = st(chatId);
      s.hasOutput = false;
      // ★ 单卡流式：本轮一张卡片，思考/工具/回答全进卡
      s.card = deps.createStreamCard(chatId);
    /** turn/start：预创建卡片（"💭 思考中…"），但不立即 patch → 第一次 addThinking 再 patch，减少一次推送 */
    s.card.addThinking("💭 思考中…").catch(() => void 0);
    deps.turnSupervisor.arm(chatId);
    },

    /** assistant/chunk（text-delta）：回答流式 → main_text 打字机（不刷屏） */
    onChunk(chatId: string, text: string): void {
      const s = st(chatId);
      s.hasOutput = true;
      void s.card?.addText(text).catch(() => void 0);
    },

    /** assistant/thinking（reasoning-delta）：思考流式 → Reasoning 面板累积 */
    onThinking(chatId: string, text: string): void {
      const s = st(chatId);
      void s.card?.addThinking(text).catch(() => void 0);
    },

    /** assistant/message：最终回答 → 卡片落地（一个框，含思考+工具+回答）
     * 按单卡流式约定：全程一张卡片增量更新，最终回答在卡片内，不单独发重复文本
     * （ALAN 反馈：我上次改错了，发了两次同样内容，现在改回 成熟桥接实现 正确逻辑）
     */
    async onAssistantMessage(chatId: string, text: string): Promise<void> {
      const s = st(chatId);
      s.hasOutput = true;
      deps.turnSupervisor.disarm(chatId);
      if (s.card) {
        await s.card.finalize(text);
      } else if (text && text.trim() !== "" && text.trim() !== "No response.") {
        // 卡片不可用且未创建：降级普通消息（完整单条）
        try {
          await deps.sendText(chatId, text);
        } catch (err) {
          deps.logger?.warn?.(`最终回复发送失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const mid = reactionTarget.get(chatId);
      if (mid && deps.cfg().reactions.enabled) {
        deps.addReaction(mid, deps.cfg().reactions.done).catch(() => void 0);
      }
    },

    /** tool/call：Tools 面板新增一行（🔧 <工具名>，带参数摘要） */
    async onToolCall(chatId: string, name: string, input?: string): Promise<void> {
      const s = st(chatId);
      await s.card?.addTool(name, input).catch(() => void 0);
    },

    /** tool/result：更新对应工具行状态（✅/❌ + 结果摘要） */
    async onToolResult(chatId: string, name: string, error: unknown): Promise<void> {
      const s = st(chatId);
      await s.card?.setToolResult(name, error).catch(() => void 0);
    },

    /** user/message（上下文注入）：Tools 面板新增 📥 行 */
    async onContext(chatId: string, text?: string): Promise<void> {
      const s = st(chatId);
      await s.card?.addContext(text).catch(() => void 0);
    },

    /** turn/end：无输出警告 + 失败表情 */
    async onTurnEnd(chatId: string, reason: string): Promise<void> {
      const s = st(chatId);
      if (!s.hasOutput && reason !== "completed") {
        try {
          await deps.sendText(chatId, "⚠️ 本轮没有产出回复");
        } catch {
          // 忽略
        }
      }
      if (reason === "error" || reason === "aborted" || reason === "max-tokens") {
        const mid = reactionTarget.get(chatId);
        if (mid && deps.cfg().reactions.enabled) {
          deps.addReaction(mid, deps.cfg().reactions.failed).catch(() => void 0);
        }
      }
      streams.delete(chatId);
    },

    /**
     * 插话/停止判定：
     * - 停止词（含"停下来/停一下/别写了"等口语）→ cancel（立即停止）
     * - agent running → steer（温和打断，next-step 边界消费）
     * - agent idle → followup（排队）
     */
    handleUserMessage(
      chatId: string,
      agent: { status: string; steer(message: unknown): void; followup(message: unknown): void; cancel(cause: { kind: string }): void },
      text: string,
      message: unknown,
    ): "stopped" | "steered" | "queued" {
      void chatId;
      const t = text.trim().toLowerCase();
      const isStop =
        t === "停" ||
        t === "停止" ||
        t === "stop" ||
        t === "/stop" ||
        t === "/stop".toLowerCase() ||
        t.includes("停下来") ||
        t.includes("停一下") ||
        t.includes("别说了") ||
        t.includes("别写了") ||
        t.includes("不要说了") ||
        t === "算了";
      if (isStop) {
        agent.cancel({ kind: "user" });
        diagLog(`[steer-diag] STOP 分支: text="${text.slice(0, 30)}" status=${agent.status}`);
        return "stopped";
      }
      if (agent.status === "running") {
        // ★ 温和打断
        try {
          agent.steer(message);
          diagLog(`[steer-diag] STEER 分支: text="${text.slice(0, 30)}" status=${agent.status} steer() 调用成功`);
        } catch (err) {
          diagLog(`[steer-diag] STEER 分支但 steer() 抛异常: ${err instanceof Error ? err.message : String(err)}`);
        }
        return "steered";
      }
      diagLog(`[steer-diag] QUEUE 分支(followup): text="${text.slice(0, 30)}" status=${agent.status}`);
      agent.followup(message);
      return "queued";
    },
  };
}

function pickReaction(cfg: WingConfig): string {
  const pool = cfg.reactions.pool;
  return pool[Math.floor(Math.random() * pool.length)] ?? "OK";
}

export type Experience = ReturnType<typeof createExperience>;
