import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutbox, type OutboxEnvelope } from "../../src/outbound/outbox.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wing-outbox-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("outbox", () => {
  it("enqueue 后能发送", async () => {
    const dir = tmpDir();
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const outbox = createOutbox({ dir, deliver });
    await outbox.start();
    outbox.enqueue({
      dedupeKey: "k1",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "你好" },
    });
    await sleep(100);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(outbox.pendingCount()).toBe(0);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("重启后 rebuildFromDisk 恢复未发送消息并续投", async () => {
    const dir = tmpDir();
    // 第一次运行：发送失败（模拟进程被杀前只入队未发送）
    const deliver1 = vi.fn().mockImplementation(() => new Promise(() => {})); // 永不 resolve
    const outbox1 = createOutbox({ dir, deliver: deliver1 });
    await outbox1.start();
    outbox1.enqueue({
      dedupeKey: "k-unsent",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "未发送的消息" },
    });
    await sleep(50);
    await outbox1.stop();
    expect(readdirSync(dir).some((f) => f.startsWith("seg-"))).toBe(true);

    // 模拟重启：新 outbox 实例 rebuildFromDisk
    const deliver2 = vi.fn().mockResolvedValue({ ok: true });
    const outbox2 = createOutbox({ dir, deliver: deliver2 });
    await outbox2.start();
    await sleep(200);
    // 未发送的消息被续投
    expect(deliver2.mock.calls.some((c) => (c[0] as OutboxEnvelope).dedupeKey === "k-unsent")).toBe(true);
    await outbox2.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("发送失败重试不阻塞（可重试后成功）", async () => {
    const dir = tmpDir();
    let attempts = 0;
    const deliver = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) return { ok: false, retryable: true, error: "网络抖动" };
      return { ok: true };
    });
    const outbox = createOutbox({ dir, deliver, maxRetries: 5, retryDelayMs: 30 });
    await outbox.start();
    outbox.enqueue({
      dedupeKey: "k-retry",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "重试消息" },
    });
    await sleep(500);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(outbox.pendingCount()).toBe(0);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("同一 dedupeKey 重复 enqueue → 幂等不重发", async () => {
    const dir = tmpDir();
    const deliver = vi.fn().mockResolvedValue({ ok: true });
    const outbox = createOutbox({ dir, deliver });
    await outbox.start();
    outbox.enqueue({
      dedupeKey: "k-dedup",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "a" },
    });
    await sleep(100); // 第一次已发送完成，sentKeys 已记录
    const id2 = outbox.enqueue({
      dedupeKey: "k-dedup",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "a" },
    });
    expect(id2).toBe("k-dedup"); // 幂等：返回 dedupeKey，不新建 envelope
    expect(deliver).toHaveBeenCalledTimes(1);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deliver 返回 retryable:false → 立即 failed 离队", async () => {
    const dir = tmpDir();
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: false, error: "fatal" });
    const outbox = createOutbox({ dir, deliver, maxRetries: 5 });
    await outbox.start();
    outbox.enqueue({
      dedupeKey: "k-fatal",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "x" },
    });
    await sleep(100);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(outbox.failedCount()).toBe(1);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("可重试但持续失败到 maxRetries → failed 离队", async () => {
    const dir = tmpDir();
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: "总是失败" });
    const outbox = createOutbox({ dir, deliver, maxRetries: 3, retryDelayMs: 10 });
    await outbox.start();
    outbox.enqueue({
      dedupeKey: "k-exhaust",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "x" },
    });
    await sleep(600);
    expect(outbox.failedCount()).toBe(1);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deliver 抛异常 → 延迟回队重试，最终成功", async () => {
    const dir = tmpDir();
    let n = 0;
    const deliver = vi.fn().mockImplementation(async () => {
      n += 1;
      if (n < 3) throw new Error("crash");
      return { ok: true };
    });
    const outbox = createOutbox({ dir, deliver, maxRetries: 5, retryDelayMs: 10 });
    await outbox.start();
    outbox.enqueue({
      dedupeKey: "k-throw",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "x" },
    });
    await sleep(500);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(outbox.pendingCount()).toBe(0);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
