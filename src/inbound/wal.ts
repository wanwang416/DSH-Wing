/**
 * 入站 WAL（对齐既有桥接实现）
 *
 * 消息处理前 accept() 落盘，处理成功后 delivered() 标记；
 * 启动时 pendingReplays() 重放未完成消息（崩溃补发，最多 2 次）。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface InboundWalRecord {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  text: string;
  senderOpenId?: string;
  acceptedAt: number;
  attempts: number;
  state: "accepted" | "replayed" | "delivered";
}

export interface InboundWalDeps {
  dir: string;
  replayRetentionMs?: number;
  maxReplayAttempts?: number;
  now?: () => number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

export function createInboundWal(deps: InboundWalDeps) {
  const dir = deps.dir;
  const replayRetentionMs = deps.replayRetentionMs ?? 30 * 60_000;
  const maxReplayAttempts = deps.maxReplayAttempts ?? 2;
  const now = deps.now ?? Date.now;
  mkdirSync(dir, { recursive: true });

  const records = new Map<string, InboundWalRecord>();

  function load(): void {
    let segs: string[] = [];
    try {
      segs = readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f)).sort();
    } catch {
      segs = [];
    }
    for (const seg of segs) {
      try {
        const lines = readFileSync(join(dir, seg), "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line) as InboundWalRecord;
            if (rec?.messageId) records.set(rec.messageId, rec);
          } catch {
            // 跳过坏行
          }
        }
      } catch {
        // 跳过坏文件
      }
    }
  }

  function persistAll(): void {
    try {
      const segFile = join(dir, `seg-${Date.now()}.jsonl`);
      const tmp = `${segFile}.tmp`;
      const lines = [...records.values()].map((r) => JSON.stringify(r));
      // ★ M1（2026-10-02 阶段4）：WAL 段语义与 outbox 不同——每段本就是**全量快照**（persistAll
      //   每次写全部记录），不是 outbox 那种追加日志。因此旧段无需超期判定：新段写出成功后，
      //   所有旧段都已被新段完全取代，全部删除即可（模式对齐 outbox M48 的"先写成功、后删旧段"）。
      //   写新段失败 → 不删任何旧段（宁可占空间，也不丢状态）。
      writeFileSync(tmp, lines.length > 0 ? lines.join("\n") + "\n" : "", { mode: 0o600 });
      renameSync(tmp, segFile);
      // 回收旧段（保留刚写出的最新 1 段）
      const newest = segFile.split(/[\\/]/).pop()!;
      let removed = 0;
      let failed = 0;
      try {
        for (const f of readdirSync(dir)) {
          if (!/^seg-.*\.jsonl$/.test(f) || f === newest) continue;
          try {
            rmSync(join(dir, f));
            removed += 1;
          } catch (err) {
            failed += 1;
            deps.logger?.warn?.(`WAL 段回收失败（${f}）: ${describeWalError(err)}`);
          }
        }
      } catch (err) {
        failed += 1;
        deps.logger?.warn?.(`WAL 段回收（列目录失败）: ${describeWalError(err)}`);
      }
      if (removed > 0 || failed > 0) {
        deps.logger?.info?.(`WAL 段回收：删除 ${removed} 个旧段（保留最新 1 个）${failed > 0 ? `，失败 ${failed} 个` : ""}`);
      }
    } catch {
      // 写新段失败：不动任何旧段（宁可不回收，也不丢状态）——不抛出，WAL 写失败不阻断消息处理
    }
  }

  /** WAL 模块内错误可读化（不引 outbox 依赖，保持 inbound 模块独立） */
  function describeWalError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try { return JSON.stringify(err) ?? "unknown"; } catch { return "unknown"; }
  }

  load();

  return {
    /** 消息开始处理前：落盘 */
    accept(rec: Omit<InboundWalRecord, "acceptedAt" | "attempts" | "state">): InboundWalRecord {
      const full: InboundWalRecord = { ...rec, acceptedAt: now(), attempts: 0, state: "accepted" };
      records.set(rec.messageId, full);
      persistAll();
      return full;
    },
    /** 消息处理成功：标记 delivered */
    delivered(messageId: string): void {
      const rec = records.get(messageId);
      if (!rec || rec.state === "delivered") return;
      rec.state = "delivered";
      persistAll();
    },
    /** 重放：返回 true 才处理（未超时/未超次/未 delivered） */
    markReplay(messageId: string): boolean {
      const rec = records.get(messageId);
      if (!rec) return false;
      if (rec.state === "delivered") return false;
      if (rec.attempts >= maxReplayAttempts) return false;
      if (now() - rec.acceptedAt > replayRetentionMs) return false;
      rec.attempts += 1;
      rec.state = "replayed";
      persistAll();
      return true;
    },
    pendingReplays(): InboundWalRecord[] {
      const cutoff = now() - replayRetentionMs;
      return [...records.values()]
        .filter((r) => r.state !== "delivered" && r.attempts < maxReplayAttempts && r.acceptedAt >= cutoff)
        .sort((a, b) => a.acceptedAt - b.acceptedAt);
    },
    prune(): void {
      const cutoff = now() - replayRetentionMs;
      let changed = 0;
      const breakdown = { delivered: 0, overAttempts: 0, expired: 0 };
      for (const [id, r] of records) {
        if (r.acceptedAt >= cutoff) continue; // 保留期内不动
        // ★ M20（2026-10-02 阶段4）：超保留期一律清理（delivered / 超次 / 过期未投递都算）。
        //   旧实现只清 delivered+超次，"accepted 且 attempts<2"的过期记录两边都不沾 → 永久滞留。
        if (r.state === "delivered") {
          records.delete(id);
          changed += 1;
          breakdown.delivered += 1;
        } else if (r.attempts >= maxReplayAttempts) {
          records.delete(id);
          changed += 1;
          breakdown.overAttempts += 1;
        } else {
          records.delete(id);
          changed += 1;
          breakdown.expired += 1;
        }
      }
      if (changed > 0) {
        persistAll();
        deps.logger?.info?.(
          `WAL prune：清理 ${changed} 条超期记录（delivered ${breakdown.delivered} / 超次 ${breakdown.overAttempts} / 过期未投递 ${breakdown.expired}），保留期内 ${records.size} 条`,
        );
      }
    },
    remove(messageId: string): void {
      if (records.delete(messageId)) persistAll();
    },
    // 待消化计数：只计未 delivered 的记录（哈马 2026-08-29 收尾项——原 records.size 把已处理完的也算进去，/status 虚高）
    pendingCount: () => {
      let n = 0;
      for (const r of records.values()) {
        if (r.state !== "delivered") n++;
      }
      return n;
    },
  };
}

export type InboundWal = ReturnType<typeof createInboundWal>;
