/**
 * session 映射（铁律 2：session 隔离第一优先级）
 *
 * - sessionKey(chatId) = `feishu:${chatId}`，绝不复用 Web GUI 会话
 *   （阿深桥事故 ash-f4089db2 直接教训）
 * - chatId → agent handle 的 Map，惰性创建
 */

import { randomBytes } from "node:crypto";

export const SESSION_PREFIX = "feishu";

/**
 * ★ session id 生成：进程级 runNonce + per-chat generation 计数
 * （对齐既有桥接的 session 命名：${prefix}:${key}:${runNonce}:${generations}）
 *
 * - 同一 chat 在同一进程内（runNonce 不变）生成**稳定 id** → resume 落点一致 → 上下文接得上
 * - generation：dispose 后重建时递增（同一 chat 的新一轮会话）
 * - 对齐依据：M1 终审教训——random8 导致"9 个 session 文件、上下文接不上"
 */

/** 进程级 nonce（插件生命周期内不变；id 冲突 mint fresh 时重置） */
let runNonce = randomBytes(6).toString("hex");
/** chatId → generation（dispose 后重建递增） */
const generations = new Map<string, number>();

/** chatId → DSH session key（路由/会话标识） */
export function sessionKey(chatId: string): string {
  return `${SESSION_PREFIX}:${chatId}`;
}

/** 生成 DSH session id：feishu:<chatId>:<runNonce>:<generation>（稳定，对齐 session 命名键） */
export function makeSessionId(chatId: string): string {
  return `${sessionKey(chatId)}:${runNonce}:${generations.get(chatId) ?? 0}`;
}

/** 同一 chat 的新一轮会话（dispose 后重建时调用） */
export function bumpGeneration(chatId: string): void {
  generations.set(chatId, (generations.get(chatId) ?? 0) + 1);
}

/** /new 对齐基底 rotate 语义：generation 归零（成熟桥接.ts:941 注释：fresh runNonce + generation 0 → 无碰撞新 id） */
export function resetGeneration(chatId: string): void {
  generations.set(chatId, 0);
}

/** 重置进程级 nonce（id 冲突 mint fresh 时调用，对齐既有桥接实现：只重置 nonce，不清 generations） */
export function resetRunNonce(): void {
  runNonce = randomBytes(6).toString("hex");
}

export interface AgentHandleLike {
  agentId: string;
  sessionId: string;
  /** DSH 原生 agent 对象（P0-2 命令路由 Tier2 需要；WingAgentHandle 必填，此处宽松可选） */
  rawAgent?: unknown;
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void;
  status: string;
  whenIdle?(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * chatId → agent handle 映射。
 * getOrCreateAgent：有则取，无则调用 createAgent 创建（惰性）。
 * 泛型 THandle：调用方可收敛到具体 handle 类型（如 WingAgentHandle，P0-2 需要 rawAgent）。
 */
export function createSessionMapper<THandle extends AgentHandleLike>(opts: {
  createAgent(chatId: string): Promise<THandle>;
  disposeAgent?(handle: THandle): Promise<void>;
}) {
  const agents = new Map<string, THandle>();
  const idleAt = new Map<string, number>();

  return {
    get(chatId: string): THandle | undefined {
      return agents.get(chatId);
    },
    async getOrCreateAgent(chatId: string): Promise<THandle> {
      const existing = agents.get(chatId);
      if (existing) {
        idleAt.set(chatId, Date.now());
        return existing;
      }
      const handle = await opts.createAgent(chatId);
      agents.set(chatId, handle);
      idleAt.set(chatId, Date.now());
      return handle;
    },
    /** 空闲超过 ttlMs 的 agent 逐个 dispose（sweep 用） */
    async 空闲清理(ttlMs: number): Promise<number> {
      const cutoff = Date.now() - ttlMs;
      const victims: Array<{ chatId: string; handle: THandle }> = [];
      for (const [chatId, handle] of agents) {
        if (handle.status === "idle" && (idleAt.get(chatId) ?? 0) < cutoff) {
          victims.push({ chatId, handle });
        }
      }
      for (const { chatId, handle } of victims) {
        agents.delete(chatId);
        idleAt.delete(chatId);
        bumpGeneration(chatId); // 对齐既有桥接实现 空闲清理：generation 递增（对照基底）
        await opts.disposeAgent?.(handle).catch(() => void 0);
      }
      return victims.length;
    },
    /** dispose 单个 chatId 的 agent（轮次超时解锁用） */
    async disposeAgentFor(chatId: string): Promise<void> {
      const handle = agents.get(chatId);
      if (!handle) return;
      agents.delete(chatId);
      idleAt.delete(chatId);
      bumpGeneration(chatId); // 对齐 dispose 语义：同一 chat 重建时 generation+1
      await opts.disposeAgent?.(handle).catch(() => void 0);
    },
    async disposeAll(): Promise<void> {
      for (const [chatId, handle] of agents) {
        agents.delete(chatId);
        idleAt.delete(chatId);
        await opts.disposeAgent?.(handle).catch(() => void 0);
      }
    },
    size: () => agents.size,
    keys: () => [...agents.keys()],
  };
}

export type SessionMapper = ReturnType<typeof createSessionMapper>;
