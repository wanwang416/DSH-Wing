/**
 * session 映射（铁律 2：session 隔离第一优先级）
 *
 * - sessionKey(chatId) = `feishu:${chatId}`，绝不复用 Web GUI 会话
 *   （阿深桥事故 ash-f4089db2 直接教训）
 * - chatId → agent handle 的 Map，惰性创建
 */

import { randomBytes } from "node:crypto";

export const SESSION_PREFIX = "feishu";

/** chatId → DSH session key（路由/会话标识） */
export function sessionKey(chatId: string): string {
  return `${SESSION_PREFIX}:${chatId}`;
}

/** 生成 DSH session id：feishu:<chatId>:<random8>:<generation> */
export function makeSessionId(chatId: string, generation = 0): string {
  const random8 = randomBytes(4).toString("hex").slice(0, 8);
  return `${sessionKey(chatId)}:${random8}:${generation}`;
}

export interface AgentHandleLike {
  agentId: string;
  sessionId: string;
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
 */
export function createSessionMapper(opts: {
  createAgent(chatId: string): Promise<AgentHandleLike>;
  disposeAgent?(handle: AgentHandleLike): Promise<void>;
}) {
  const agents = new Map<string, AgentHandleLike>();
  const idleAt = new Map<string, number>();

  return {
    get(chatId: string): AgentHandleLike | undefined {
      return agents.get(chatId);
    },
    async getOrCreateAgent(chatId: string): Promise<AgentHandleLike> {
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
      const victims: Array<{ chatId: string; handle: AgentHandleLike }> = [];
      for (const [chatId, handle] of agents) {
        if (handle.status === "idle" && (idleAt.get(chatId) ?? 0) < cutoff) {
          victims.push({ chatId, handle });
        }
      }
      for (const { chatId, handle } of victims) {
        agents.delete(chatId);
        idleAt.delete(chatId);
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
