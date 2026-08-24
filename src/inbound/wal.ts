/**
 * 入站 WAL（对齐既有桥接实现）
 *
 * 消息处理前 accept() 落盘，处理成功后 delivered() 标记；
 * 启动时 pendingReplays() 重放未完成消息（崩溃补发，最多 2 次）。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
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
      writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
      renameSync(tmp, segFile);
    } catch {
      // 忽略
    }
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
      let changed = false;
      for (const [id, r] of records) {
        if (r.acceptedAt < cutoff && (r.state === "delivered" || r.attempts >= maxReplayAttempts)) {
          records.delete(id);
          changed = true;
        }
      }
      if (changed) persistAll();
    },
    remove(messageId: string): void {
      if (records.delete(messageId)) persistAll();
    },
    pendingCount: () => records.size,
  };
}

export type InboundWal = ReturnType<typeof createInboundWal>;
