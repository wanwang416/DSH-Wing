/**
 * ★ 体验契约（阿深体感核心修正）
 *
 * - 流式转发：assistant/chunk 累积 → 节流增量发飞书（M1 用多条 text，M2 换 CardKit 单卡片）
 * - 插话：agent.status === "running" → steer()（★M0 Spike 7 发现：温和打断）；
 *         idle → followup()（排队）
 * - 停止："停"/"stop"/"停止" → cancel({kind:"user"})
 * - 工具可见：tool/call + tool/result → 文本转发（M3 换卡片）
 * - 表情：收到→随机；完成→DONE；失败→CrossMark
 */

import type { WingConfig } from "../config/defaults.js";

export interface TurnSupervisorLike {
  arm(key: string): void;
  disarm(key: string): void;
}

export interface ExperienceDeps {
  sendText(chatId: string, text: string): Promise<void>;
  addReaction(messageId: string, emoji: string): Promise<void>;
  turnSupervisor: TurnSupervisorLike;
  cfg: () => WingConfig;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

interface StreamState {
  buffer: string;
  lastFlushAt: number;
  hasOutput: boolean;
  /** 已流式发送的字符数（assistant/message 只发未覆盖部分，防重复） */
  sent: number;
  /** 本轮已发流式消息数（上限防刷屏） */
  streamCount: number;
}

/** 流式防刷屏：单轮最多 8 条过程消息，超出只发最终回复 */
const MAX_STREAM_MESSAGES = 8;
/** 最小累积字符（达到才发一条流式消息） */
const MIN_CHUNK_LEN = 300;
/** 最大发送间隔（无论多少字符，超时强制发） */
const FLUSH_INTERVAL_MS = 3000;

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createExperience(deps: ExperienceDeps) {
  const streams = new Map<string, StreamState>();
  /** chatId → 最近入站 messageId（reaction 目标） */
  const reactionTarget = new Map<string, string>();
  /** chatId → 工具结果合并缓冲（2 秒窗口，防刷屏） */
  const toolResults = new Map<string, { parts: string[]; timer?: ReturnType<typeof setTimeout> }>();

  /** 工具结果合并发送（一条消息汇总多个工具） */
  async function flushToolResults(chatId: string): Promise<void> {
    const rec = toolResults.get(chatId);
    if (!rec) return;
    toolResults.delete(chatId);
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.parts.length === 0) return;
    const text = rec.parts.length === 1 ? rec.parts[0] : `🔧 工具：${rec.parts.join("、")}`;
    try {
      await deps.sendText(chatId, text);
    } catch {
      // 忽略
    }
  }

  const st = (chatId: string): StreamState => {
    let s = streams.get(chatId);
    if (!s) {
      s = { buffer: "", lastFlushAt: 0, hasOutput: false, sent: 0, streamCount: 0 };
      streams.set(chatId, s);
    }
    return s;
  };

  const pickReaction = (): string => {
    const pool = deps.cfg().reactions.pool;
    return pool[Math.floor(Math.random() * pool.length)] ?? "OK";
  };

  async function flush(chatId: string): Promise<void> {
    const s = st(chatId);
    if (!s.buffer) return;
    const delta = s.buffer;
    s.buffer = "";
    s.lastFlushAt = Date.now();
    s.sent += delta.length;
    s.streamCount += 1;
    try {
      await deps.sendText(chatId, delta);
    } catch (err) {
      deps.logger?.warn?.(`流式发送失败: ${String(err)}`);
    }
  }

  return {
    /** 入站消息已接收：记录 reaction 目标 + 加"已收到"随机表情 */
    onInbound(chatId: string, messageId: string): void {
      reactionTarget.set(chatId, messageId);
      if (deps.cfg().reactions.enabled) {
        deps.addReaction(messageId, pickReaction()).catch(() => void 0);
      }
    },

    /** turn/start：重置流式状态 + arm 轮次监督 */
    onTurnStart(chatId: string): void {
      const s = st(chatId);
      s.hasOutput = false;
      s.buffer = "";
      s.sent = 0;
      s.streamCount = 0;
      deps.turnSupervisor.arm(chatId);
    },

    /**
     * assistant/chunk：M1 不发送中间流式消息（避免多框刷屏，ALAN 反馈 3/4）。
     * 仅累积标记有输出；最终回复由 assistant/message 单条发出。
     * M2 用 CardKit 单卡片流式（一个框内持续更新）。
     */
    onChunk(chatId: string, text: string): void {
      const s = st(chatId);
      s.hasOutput = true;
      s.buffer += text;
    },

    /**
     * assistant/message：最终回复 ★单条完整发出（一个框，方便复制，ALAN 反馈 4）
     * + 表情 DONE + disarm
     */
    async onAssistantMessage(chatId: string, text: string): Promise<void> {
      const s = st(chatId);
      s.hasOutput = true;
      deps.turnSupervisor.disarm(chatId);
      s.buffer = "";
      s.sent = 0;
      await flushToolResults(chatId); // 先清工具合并缓冲
      if (text && text.trim() !== "" && text.trim() !== "No response.") {
        try {
          await deps.sendText(chatId, text);
        } catch (err) {
          deps.logger?.warn?.(`最终回复发送失败: ${String(err)}`);
        }
      }
      const mid = reactionTarget.get(chatId);
      if (mid && deps.cfg().reactions.enabled) {
        deps.addReaction(mid, deps.cfg().reactions.done).catch(() => void 0);
      }
    },

    /**
     * tool/call：M1 不发消息（避免每个工具调一条刷屏）。
     * 工具可见性由 tool/result 承担；M3 换卡片后这里发"调用中"状态。
     */
    async onToolCall(_chatId: string, _name: string): Promise<void> {
      // M1：静默（工具调用过程由流式文本体现）
    },

    /** tool/result：★合并缓冲（2 秒窗口一条汇总，防刷屏，参考 CC-Connect 一次一个状态） */
    async onToolResult(chatId: string, name: string, error: unknown): Promise<void> {
      const rec = toolResults.get(chatId) ?? { parts: [] };
      rec.parts.push(error ? `${name}❌` : name);
      toolResults.set(chatId, rec);
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = setTimeout(() => void flushToolResults(chatId), 2000);
    },

    /** turn/end：无输出警告 + 失败表情 + 清工具缓冲 */
    async onTurnEnd(chatId: string, reason: string): Promise<void> {
      const s = st(chatId);
      await flush(chatId).catch(() => void 0);
      await flushToolResults(chatId);
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
      s.buffer = "";
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
        t.includes("停下来") ||
        t.includes("停一下") ||
        t.includes("别说了") ||
        t.includes("别写了") ||
        t.includes("不要说了") ||
        t === "算了";
      if (isStop) {
        agent.cancel({ kind: "user" });
        return "stopped";
      }
      if (agent.status === "running") {
        agent.steer(message); // ★ 温和打断
        return "steered";
      }
      agent.followup(message);
      return "queued";
    },
  };
}

export type Experience = ReturnType<typeof createExperience>;
