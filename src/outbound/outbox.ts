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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  /** P1-2A/2B：保留天数——超期 failed 不回队、超期 seg 段回收（基底 config.ts:128 retainDays: 7） */
  retainDays?: number;
  /** ★ M12（阶段6b）：sentKeys 上限（默认 5000；理由见交付说明——8B/键 × 5000 ≈ 400KB 内存封顶，7 天保留期足够幂等） */
  sentKeysLimit?: number;
  /** ★ M12（阶段6b）：done 信封内存保留期（默认 24h；超期从内存清理，段盘上仍在） */
  envelopeRetentionMs?: number;
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
/** P1-2A/2B：保留天数缺省（基底 config.ts:128 retainDays: 7） */
const DEFAULT_RETAIN_DAYS = 7;
const RETAIN_MS = DEFAULT_RETAIN_DAYS * 86_400_000;

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
  // ★ M12（阶段6b）：容器上限。sentKeys = FIFO 淘汰（Set 迭代序 = 插入序）；envelopes 终态按 updatedAt 清理。
  const SENT_KEYS_LIMIT = deps.sentKeysLimit ?? 5000;
  const ENVELOPE_RETENTION_MS = deps.envelopeRetentionMs ?? 24 * 3_600_000;

  /** M12：sentKeys 超 LIMit 时淘汰最旧（插入序），留日志与计数（不许静默） */
  function trimSentKeys(): number {
    if (sentKeys.size <= SENT_KEYS_LIMIT) return 0;
    const overflow = sentKeys.size - SENT_KEYS_LIMIT;
    let removed = 0;
    for (const k of sentKeys) {
      if (removed >= overflow) break;
      sentKeys.delete(k);
      removed++;
    }
    deps.logger?.info?.(`outbox sentKeys 清理：淘汰最旧 ${removed} 条（上限 ${SENT_KEYS_LIMIT}，现 ${sentKeys.size} 条）`);
    return removed;
  }

  /** M12：清理已终结（done/fatal）且超保留期的信封（内存）；pending/sending/failed 绝不清理（红线）。
   *  段文件在盘上仍全量保留（M46 语义不变），清理只影响内存容器。返回清理条数。 */
  function 清理终态信封(retentionMs: number): number {
    const cutoff = Date.now() - retentionMs;
    let removed = 0;
    for (const [id, env] of envelopes) {
      if (env.status === "done" && env.updatedAt < cutoff) {
        envelopes.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      deps.logger?.info?.(
        `outbox 终态信封清理：删除 ${removed} 条 done 超期条目（保留期 ${retentionMs}ms，现 ${envelopes.size} 条；pending/failed 不受影响）`,
      );
    }
    return removed;
  }
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
    const retainDays = deps.retainDays ?? DEFAULT_RETAIN_DAYS;
    const retainMs = retainDays * 86_400_000;
    const nowMs = Date.now();
    let expiredSkipped = 0;
    let segs: string[] = [];
    try {
      segs = readdirSync(deps.dir)
        .filter((f) => /^seg-\d+\.jsonl$/.test(f))
        .sort();
    } catch {
      segs = [];
    }

    // ① 先读**全部**段（含即将被回收的超期段），按"后写覆盖先写"得到每个信封的最终状态。
    //   ★ M48（2026-10-02 阿深）：段是**追加日志**（每行一条状态），**不是全量快照**——
    //     同一信封的状态行会分散在多个段里。因此"先删段、再读段"会丢状态：
    //     若某信封的最后一行只存在于超期段，删段后该信封直接消失 →
    //       · pending 消息永远发不出去（丢消息）
    //       · failed 从死信列表消失（无法重放）
    //       · done 的幂等键（sentKeys）丢失
    //     实测（10-02 重启）：回收前 14 条信封 → 回收后 9 条，消失的 5 条最后状态行全在被删段里。
    for (const seg of segs) {
      try {
        const lines = readFileSync(join(deps.dir, seg), "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const env = JSON.parse(line) as OutboxEnvelope;
            if (env?.id) envelopes.set(env.id, env); // 覆盖 → 该信封的最终状态
          } catch {
            // 跳过坏行
          }
        }
      } catch {
        // 跳过坏文件
      }
    }

    // ② 段回收（含 compaction）：★ M48 修法——删超期段**之前**，先把最终状态写成
    //   一个新的全量快照段（每信封一行），这样删段不丢任何信封的最终状态。
    //   ★ M46：最新段永不回收。
    const newestSeg = segs.length > 0 ? segs[segs.length - 1] : undefined;
    const expiredSegs = segs.filter((s) => {
      if (s === newestSeg) return false; // ★ M46：保留最新 1 段
      return nowMs - Number(s.slice(4, -6)) * 1000 > retainMs;
    });
    if (expiredSegs.length > 0) {
      let snapSeg: string | undefined;
      if (envelopes.size > 0) {
        let sec = Math.floor(nowMs / 1000);
        while (existsSync(join(deps.dir, `seg-${sec}.jsonl`))) sec += 1; // 不撞名
        const candidate = `seg-${sec}.jsonl`;
        try {
          const lines = [...envelopes.values()].map((e) => JSON.stringify(e));
          writeFileSync(join(deps.dir, candidate), lines.join("\n") + "\n", { mode: 0o600 });
          snapSeg = candidate;
        } catch (err) {
          // 快照写失败 → 本轮放弃回收（宁可占空间，也不丢状态）
          deps.logger?.warn?.(`outbox 快照段写入失败，本轮跳过段回收: ${describeError(err)}`);
          snapSeg = undefined;
        }
      }
      if (snapSeg !== undefined || envelopes.size === 0) {
        // envelopes 为空时无状态可丢，直接回收（也避免写出 1 字节空段）
        let removed = 0;
        for (const seg of expiredSegs) {
          try {
            rmSync(join(deps.dir, seg));
            removed += 1;
          } catch (err) {
            deps.logger?.warn?.(`outbox 段回收失败（${seg}）: ${describeError(err)}`);
          }
        }
        if (removed > 0) {
          deps.logger?.info?.(
            `outbox 段回收：删除 ${removed} 个旧段（>${retainDays} 天，回收前已写全量快照段${snapSeg ? ` ${snapSeg}` : ""}，保留最新 1 段）`,
          );
        }
      }
    }

    // ③ 基于**最终状态**统一入队。
    //   ★ M47（2026-10-02 阿深）：旧实现边读边入队——读到某 id 早期的 pending 行就 push，
    //     即使更晚的行已把它标为 done → 队列与日志虚高（实测「队列 6 条」而实际待发 0；
    //     pump 的状态守卫兜住了投递，但计数误导）。现在先读完再统一判定。
    const queued = new Set<string>();
    for (const env of envelopes.values()) {
      if (env.status === "done") {
        // ★ P0-4 第 1 点：只有 done 才进 sentKeys（"已终结"）。
        //   旧实现 failed 也进 → enqueue 幂等拦截 + 不回队 → 消息永久消失。
        sentKeys.add(env.dedupeKey);
        continue;
      }
      if (env.status === "failed" && nowMs - env.createdAt > retainMs) {
        // ★ P1-2A：超期 failed 不回队（防"重启翻旧账"）。保持 failed，不删除。
        //   对齐基底 config.ts:128 retainDays: 7。
        expiredSkipped += 1;
        continue;
      }
      // ★ P0-4 第 2 点：pending / failed / sending 回队重试（基底 outbox.ts:126-131）。
      //   sending 视为 at-least-once 重投；failed 必须重置为 pending，
      //   否则 pump 循环见到 status=failed 直接跳过（回队形同虚设）。
      env.status = "pending";
      env.updatedAt = nowMs;
      if (!queued.has(env.id)) {
        queued.add(env.id);
        queue.push(env.id);
      }
    }
    if (expiredSkipped > 0) {
      deps.logger?.warn?.(`outbox 重建：跳过 ${expiredSkipped} 条超期 failed（>${retainDays} 天，不回队不删除）`);
    }
    // ★ P1-2C（体检 M45）+ M47：文案区分信封数与队列条数
    deps.logger?.info?.(`outbox 重建：${envelopes.size} 条信封，队列 ${queue.length} 条（唯一 id ${queued.size}）`);
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
            trimSentKeys(); // ★ M12：幂等键上限（淘汰最旧，日志留痕）
            清理终态信封(ENVELOPE_RETENTION_MS); // ★ M12：终态信封超期清理（pending/failed 绝不动）
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
    /** ★ M12（阶段6b）：测试与运维可手动触发清理（正常路径在投递成功后自动跑） */
    清理终态信封,
    trimSentKeys,
    /** ★ M12（阶段6b）：只读快照——按 id 查信封（红线断言用：断言"条目还在不在"，不借计数） */
    getEnvelope(id: string): OutboxEnvelope | undefined {
      const env = envelopes.get(id);
      return env ? { ...env } : undefined;
    },
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
