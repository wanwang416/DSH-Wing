/**
 * Outbox：持久化出站队列（JSONL + 幂等 + at-least-once）
 *
 * 参考成熟桥接实现（基底 dsh-lark-link src/outbound/outbox.ts），M1 简化：
 * - 单航道（M2 加分航道）
 * - 每条消息带 dedupeKey（幂等）
 * - 失败不阻塞：retryable 延迟回队，fatal 标记失败离队
 * - rebuildFromDisk()：重启后从 JSONL 重建未发送队列
 *
 * ★ P0-4（2026-10-02）：瞬时失败永久判死修复（对齐基底 outbox.ts:126-131、286-300 与
 *   config.ts:126-130 maxAttempts:50 / backoffMaxMs:60_000）：
 *   1) failed 不进 sentKeys（只有 done / fatal 才进）——sentKeys 语义是"已终结"
 *   2) 重启时 failed 回队重试（基底：pending/failed/sending 都 lane.push）
 *   3) 指数退避 + 抖动：delay = min(60_000, 1000 * 2^(attempts-1))，±20% 抖动
 *   4) maxRetries 缺省 50；只有明确不可重试的错误才 fatal（429/5xx 一律可重试）
 *   5) 死信出口：listFailed() / retryFailed()
 *   8) describeError：平台返回对象序列化出 errcode/errmsg（不再 "[object Object]"）
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface OutboxEnvelope {
  id: string;
  dedupeKey: string;
  chatId: string;
  /** 来源平台（S6：deliver 判定优先用显式标记；未标记走启发式兜底） */
  platform?: "feishu" | "wecom";
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

/** P0-4：重试次数上限（基底 config.ts:126 maxAttempts: 50） */
const DEFAULT_MAX_RETRIES = 50;
/** P0-4：退避封顶（基底 config.ts:127 backoffMaxMs: 60_000） */
const BACKOFF_MAX_MS = 60_000;
/** P0-4：指数退避基数 */
const BACKOFF_BASE_MS = 1_000;

/**
 * P0-4 第 8 点：错误可读化。平台 SDK 返回的对象（axios error 的 response.data、
 * 飞书/企微 errcode 结构）序列化出 errcode/errmsg，不再变成 "[object Object]"。
 */
export function describeError(err: unknown): string {
  if (err == null) return "unknown";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const code = o.errcode ?? o.code;
    const msg = o.errmsg ?? o.msg ?? o.message;
    if (code !== undefined && msg !== undefined) return `${String(code)}: ${String(msg)}`;
    if (msg !== undefined) return String(msg);
    if (code !== undefined) return `errcode ${String(code)}`;
    try {
      const s = JSON.stringify(o);
      if (s && s !== "{}") return s;
    } catch {
      // fallthrough
    }
  }
  return String(err);
}

/**
 * P0-4 第 4 点：明确不可重试的错误才判 fatal。
 * 对齐基底 isFatalError 默认 `/400|403|invalid|not found/i`；429/5xx 一律可重试。
 */
export function isFatalError(error: string | undefined): boolean {
  return /400|403|invalid|not found/i.test(error ?? "");
}

/**
 * P0-4 第 3 点：指数退避 + 抖动。
 * delay = min(60_000, 1000 * 2^(attempts-1))，叠加 ±20% 抖动。
 */
export function backoffDelayMs(attempts: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 10));
  const jitter = base * 0.2;
  return Math.round(base - jitter + Math.random() * jitter * 2);
}

export function createOutbox(deps: OutboxDeps) {
  const envelopes = new Map<string, OutboxEnvelope>();
  /** pending+failed+sending 的 id 队列（FIFO） */
  const queue: string[] = [];
  /** dedupeKey → 已终结（done / fatal）envelope id（幂等，防重启重发）。
   *  ★ P0-4：failed 不再进此集合——failed 意味着"还能重试"，不是"已终结"。 */
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
        const queued = new Set<string>(); // 同一信封多条历史行只回队一次
        for (const line of lines) {
          try {
            const env = JSON.parse(line) as OutboxEnvelope;
            envelopes.set(env.id, env);
            if (env.status === "done") {
              // ★ P0-4 第 1 点：只有 done 才进 sentKeys（"已终结"）。
              //   旧实现 failed 也进 → enqueue 幂等拦截 + 不回队 → 消息永久消失。
              sentKeys.add(env.dedupeKey);
            } else if (env.status === "pending" || env.status === "failed") {
              // ★ P0-4 第 2 点：重启时 failed 回队重试（基底 outbox.ts:126-131：
              //   pending/failed/sending 都 lane.push）。failed 必须重置为 pending，
              //   否则 pump 循环见到 status=failed 直接跳过（回队形同虚设）。
              env.status = "pending";
              env.updatedAt = Date.now();
              if (!queued.has(env.id)) {
                queued.add(env.id);
                queue.push(env.id);
              }
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
    platform?: "feishu" | "wecom";
    kind: OutboxEnvelope["kind"];
    payload: OutboxEnvelope["payload"];
  }): string {
    if (sentKeys.has(input.dedupeKey)) return input.dedupeKey; // 幂等：已终结（done）
    const env: OutboxEnvelope = {
      id: randomUUID(),
      dedupeKey: input.dedupeKey,
      chatId: input.chatId,
      platform: input.platform, // S6：显式平台标记（JSONL 落盘持久化）
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
            const errorText = describeError(result.error);
            env.lastError = errorText;
            if (result.retryable === false || isFatalError(errorText) || env.attempts >= (deps.maxRetries ?? DEFAULT_MAX_RETRIES)) {
              // ★ P0-4：终止 = failed，但 dedupeKey 不进 sentKeys（旧实现塞进去 →
              //   enqueue 幂等拦截 + 重启不回队 → 消息永久消失）。
              //   sentKeys 语义是"已终结"（done）；failed 走 listFailed/retryFailed 或重启回队。
              env.status = "failed";
              env.updatedAt = Date.now();
              queue.shift();
              append(env);
              deps.logger?.warn?.(`outbox 消息 ${env.dedupeKey} 发送失败（终止，第 ${env.attempts} 次尝试，failed 计数 ${failedCount() + 1}）: ${errorText}`);
            } else {
              // 可重试：保持 pending，指数退避 + 抖动回队（基底 outbox.ts:295-299）
              env.status = "pending";
              env.updatedAt = Date.now();
              queue.shift();
              append(env);
              const delay = deps.retryDelayMs ?? backoffDelayMs(env.attempts);
              setTimeout(() => {
                if (stopped) return;
                if (!queue.includes(env.id)) queue.push(env.id);
                void pump();
              }, delay).unref?.();
            }
          }
        } catch (err) {
          env.lastError = describeError(err);
          env.status = "pending";
          env.updatedAt = Date.now();
          queue.shift();
          append(env);
          const delay = deps.retryDelayMs ?? backoffDelayMs(env.attempts);
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
    // ★ P0-4 第 6 点：只算 pending——failed 是"已判死待处置"，不是"待发送"，
    //   旧实现把 failed 算进 pending → status.json 虚高（与体检 M3 同源）
    return [...envelopes.values()].filter((e) => e.status === "pending").length;
  }
  function failedCount(): number {
    return [...envelopes.values()].filter((e) => e.status === "failed").length;
  }

  /**
   * P0-4 第 5 点：死信出口——列举 failed 信封（供人工排查 / 面板展示）。
   */
  function listFailed(): OutboxEnvelope[] {
    return [...envelopes.values()].filter((e) => e.status === "failed");
  }

  /**
   * P0-4 第 5 点：死信出口——手动重放全部 failed 信封（改回 pending 入队）。
   * 返回重放条数。
   */
  function retryFailed(): number {
    const failed = listFailed();
    let n = 0;
    for (const env of failed) {
      env.status = "pending";
      env.updatedAt = Date.now();
      append(env);
      if (!queue.includes(env.id)) queue.push(env.id);
      n += 1;
    }
    if (n > 0) {
      deps.logger?.info?.(`outbox 死信重放：${n} 条 failed 信封重新入队`);
      void pump();
    }
    return n;
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
    listFailed,
    retryFailed,
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
