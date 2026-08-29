import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboundWal } from "../../src/inbound/wal.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wing-wal-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("inbound WAL", () => {
  it("accept → delivered 生命周期", () => {
    const dir = tmpDir();
    const wal = createInboundWal({ dir, replayRetentionMs: 60_000, maxReplayAttempts: 2 });
    wal.accept({ messageId: "m1", chatId: "oc_1", chatType: "p2p", text: "你好" });
    expect(wal.pendingCount()).toBe(1);
    wal.delivered("m1");
    expect(wal.pendingReplays()).toHaveLength(0); // delivered 不重放
    rmSync(dir, { recursive: true, force: true });
  });

  it("重启后重建：未 delivered 的消息可重放（崩溃补发）", async () => {
    const dir = tmpDir();
    const wal1 = createInboundWal({ dir, replayRetentionMs: 60_000, maxReplayAttempts: 2 });
    wal1.accept({ messageId: "m1", chatId: "oc_1", chatType: "p2p", text: "未处理的消息" });
    await sleep(20);

    // 模拟重启：新实例从磁盘重建
    const wal2 = createInboundWal({ dir, replayRetentionMs: 60_000, maxReplayAttempts: 2 });
    expect(wal2.pendingCount()).toBe(1);
    // 未 delivered 且未超次 → 可重放
    expect(wal2.pendingReplays().some((r) => r.messageId === "m1")).toBe(true);
    expect(wal2.markReplay("m1")).toBe(true);
    // delivered 后不再重放
    wal2.delivered("m1");
    expect(wal2.pendingReplays()).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pendingCount 只计未 delivered（哈马收尾项：原 records.size 把已处理完的也算进去，/status 虚高）", () => {
    const dir = tmpDir();
    const wal = createInboundWal({ dir, replayRetentionMs: 60_000, maxReplayAttempts: 2 });
    wal.accept({ messageId: "m1", chatId: "oc_1", chatType: "p2p", text: "a" });
    wal.accept({ messageId: "m2", chatId: "oc_1", chatType: "p2p", text: "b" });
    wal.delivered("m1");
    expect(wal.pendingCount()).toBe(1); // 只 m2 未 delivered
    wal.delivered("m2");
    expect(wal.pendingCount()).toBe(0); // 全部处理完 → 0
    rmSync(dir, { recursive: true, force: true });
  });

  it("超过 maxReplayAttempts 不再重放", () => {
    const dir = tmpDir();
    const wal = createInboundWal({ dir, replayRetentionMs: 60_000, maxReplayAttempts: 2 });
    wal.accept({ messageId: "m1", chatId: "oc_1", chatType: "p2p", text: "重试耗尽" });
    expect(wal.markReplay("m1")).toBe(true);
    expect(wal.markReplay("m1")).toBe(true);
    expect(wal.markReplay("m1")).toBe(false); // 第 3 次拒绝
    rmSync(dir, { recursive: true, force: true });
  });
});
