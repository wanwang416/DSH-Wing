/**
 * Outbox：持久化出站队列（JSONL + 幂等 + at-least-once）
 *
 * 参考成熟桥接实现，M1 简化：
 * - 单航道（M2 加分航道）
 * - 每条消息带 dedupeKey（幂等）
 * - 失败不阻塞：retryable 延迟回队，fatal 标记失败离队
 * - rebuildFromDisk()：重启后从 JSONL 重建未发送队列
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface OutboxEnvelope {
  id: string;
  dedupeKey: string;
  chatId: string;
  kind: "text" | "card" | "reaction";
  payload: { kind: string; text?: string; card?: unknown; messageId?: string; emojiType?: string };
  status: "pending" | "sending" | "done" | "failed";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface OutboxDeps {
  dir: string;
  deliver(env: OutboxEnvelope): Promise<{ ok: boolean; retryable?: boolean; error?: string }>;
  maxRetries?: number;
  retryDelayMs?: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** 统计变化回调（状态面板用） */
  onStatsChange?(stats: { pending: number; failed: number }): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createOutbox(deps: OutboxDeps) {
  const envelopes = new Map<string, OutboxEnvelope>();
  /** pending+failed+sending 的 id 队列（FIFO） */
  const queue: string[] = [];
  /** dedupeKey → done/fatal envelope id（幂等，防重启重发） */
  const sentKeys = new Set<string>();
  let stopped = false;
  let pumpRunning = false;

  mkdirSync(deps.dir, { recursive: true });

  const segPath = (): string => join(deps.dir, `seg-${Math.floor(Date.now() / 1000)}.jsonl`);

  function append(env: OutboxEnvelope): void {
    try {
      appendFileSync(segPath(), JSON.stringify(env) + "\n", { mode: 0o600 });
    } catch {
      // 忽略
    }
  }

  function rebuildFromDisk(): void {
    envelopes.clear();
    queue.length = 0;
    sentKeys.clear();
    let segs: string[] = [];
    try {
      segs = readdirSync(deps.dir)
        .filter((f) => /^seg-\d+\.jsonl$/.test(f))
        .sort();
    } catch {
      segs = [];
    }
    for (const seg of segs) {
      try {
        const lines = readFileSync(join(deps.dir, seg), "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const env = JSON.parse(line) as OutboxEnvelope;
            envelopes.set(env.id, env);
            if (env.status === "done" || env.status === "failed") {
              sentKeys.add(env.dedupeKey);
            } else if (env.status === "pending") {
              queue.push(env.id);
            } else {
              // sending：重启时视为 pending 重投（at-least-once）
              env.status = "pending";
              env.updatedAt = Date.now();
              queue.push(env.id);
            }
          } catch {
            // 跳过坏行
          }
        }
      } catch {
        // 跳过坏文件
      }
    }
    deps.logger?.info?.(`outbox 重建：${envelopes.size} 条信封，${queue.length} 条待发送`);
  }

  function enqueue(input: {
    dedupeKey: string;
    chatId: string;
    kind: OutboxEnvelope["kind"];
    payload: OutboxEnvelope["payload"];
  }): string {
    if (sentKeys.has(input.dedupeKey)) return input.dedupeKey; // 幂等：已发送过
    const env: OutboxEnvelope = {
      id: randomUUID(),
      dedupeKey: input.dedupeKey,
      chatId: input.chatId,
      kind: input.kind,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    envelopes.set(env.id, env);
    queue.push(env.id);
    append(env);
    void pump();
    return env.id;
  }

  async function pump(): Promise<void> {
    if (pumpRunning) return;
    pumpRunning = true;
    try {
      while (!stopped && queue.length > 0) {
        const id = queue[0];
        const env = envelopes.get(id);
        if (!env) {
          queue.shift();
          continue;
        }
        if (env.status === "done" || env.status === "failed") {
          queue.shift();
          continue;
        }
        env.status = "sending";
        env.attempts += 1;
        env.updatedAt = Date.now();
        try {
          const result = await deps.deliver(env);
          if (result.ok) {
            env.status = "done";
            env.updatedAt = Date.now();
            sentKeys.add(env.dedupeKey);
            queue.shift();
            append(env);
          } else {
            env.lastError = result.error;
            if (env.attempts >= (deps.maxRetries ?? 3) || result.retryable === false) {
              env.status = "failed";
              env.updatedAt = Date.now();
              sentKeys.add(env.dedupeKey);
              queue.shift();
              append(env);
              deps.logger?.warn?.(`outbox 消息 ${env.dedupeKey} 发送失败（终止）: ${result.error}`);
            } else {
              // 可重试：保持 pending（不能标 failed，否则回队后被 pump 跳过），延迟回队
              env.status = "pending";
              env.updatedAt = Date.now();
              queue.shift();
              append(env);
              const delay = deps.retryDelayMs ?? 2000;
              setTimeout(() => {
                if (stopped) return;
                if (!queue.includes(env.id)) queue.push(env.id);
                void pump();
              }, delay).unref?.();
            }
          }
        } catch (err) {
          env.lastError = err instanceof Error ? err.message : String(err);
          env.status = "pending";
          env.updatedAt = Date.now();
          queue.shift();
          append(env);
          const delay = deps.retryDelayMs ?? 2000;
          setTimeout(() => {
            if (stopped) return;
            if (!queue.includes(env.id)) queue.push(env.id);
            void pump();
          }, delay).unref?.();
        }
      }
    } finally {
      pumpRunning = false;
      deps.onStatsChange?.({ pending: pendingCount(), failed: failedCount() });
    }
  }

  function pendingCount(): number {
    return [...envelopes.values()].filter((e) => e.status === "pending" || e.status === "failed").length;
  }
  function failedCount(): number {
    return [...envelopes.values()].filter((e) => e.status === "failed").length;
  }

  return {
    rebuildFromDisk,
    enqueue,
    async start(): Promise<void> {
      stopped = false;
      rebuildFromDisk();
      void pump();
    },
    async stop(): Promise<void> {
      stopped = true;
    },
    pendingCount,
    failedCount,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
