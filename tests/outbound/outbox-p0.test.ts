import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutbox, describeError, backoffDelayMs, type OutboxEnvelope } from "../../src/outbound/outbox.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wing-outbox-p0-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("outbox P0-4：瞬时失败永久判死修复", () => {
  it("deliver 连续 429 → 重试到 maxRetries(50) 前不判死，dedupeKey 不进 sentKeys，重启回队", async () => {
    const dir = tmpDir();
    let attempts = 0;
    const deliver = vi.fn().mockImplementation(async () => {
      attempts += 1;
      return { ok: false, retryable: true, error: "Request failed with status code 429" };
    });
    const outbox = createOutbox({ dir, deliver, maxRetries: 50, retryDelayMs: 5 });
    await outbox.start();
    outbox.enqueue({
      dedupeKey: "k-429",
      chatId: "oc_1",
      kind: "text",
      payload: { kind: "text", text: "限流受害者" },
    });
    await sleep(600); // 5ms 退避 × 若干轮 → 至少十几轮
    expect(attempts).toBeGreaterThanOrEqual(10); // 旧实现 3 轮就判死
    expect(outbox.failedCount()).toBe(0); // ★ 未到 50 不判死
    await outbox.stop(); // 落盘：status=pending

    // 模拟重启：failed/pending 回队重试（基底 outbox.ts:126-131）
    const deliver2 = vi.fn().mockResolvedValue({ ok: true });
    const outbox2 = createOutbox({ dir, deliver: deliver2, maxRetries: 50 });
    await outbox2.start();
    await sleep(100);
    expect(deliver2.mock.calls.some((c) => (c[0] as OutboxEnvelope).dedupeKey === "k-429")).toBe(true);
    await outbox2.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("429 耗尽次数 → failed，但 dedupeKey 不进 sentKeys（同 key 可再次 enqueue），重启回队", async () => {
    const dir = tmpDir();
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: "429 永动机" });
    const outbox = createOutbox({ dir, deliver, maxRetries: 4, retryDelayMs: 5 });
    await outbox.start();
    outbox.enqueue({ dedupeKey: "k-exhaust-p0", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "x" } });
    await sleep(300);
    expect(outbox.failedCount()).toBe(1);
    // ★ 旧实现：failed 的 dedupeKey 进 sentKeys → enqueue 幂等拦截（返回原 key），消息永久消失
    const id2 = outbox.enqueue({ dedupeKey: "k-exhaust-p0", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "x" } });
    expect(id2).not.toBe("k-exhaust-p0"); // failed 不进 sentKeys → 不被幂等拦截
    await outbox.stop();

    // 重启回队：failed 也回队重试（基底 outbox.ts:126-131）
    const deliver2 = vi.fn().mockResolvedValue({ ok: true });
    const outbox2 = createOutbox({ dir, deliver: deliver2, maxRetries: 4 });
    await outbox2.start();
    await sleep(200);
    expect(deliver2.mock.calls.some((c) => (c[0] as OutboxEnvelope).dedupeKey === "k-exhaust-p0")).toBe(true);
    await outbox2.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("400/403 类错误仍判 fatal（不可重试路径没被破坏）", async () => {
    const errTexts = ["Request failed with status code 400", "invalid open_id", "403 forbidden", "not found"];
    for (const [i, errText] of errTexts.entries()) {
      const dir = tmpDir(); // 每轮独立目录：旧 failed 信封会被新实例回队（P0-4 正确行为），不干扰计数
      const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: errText });
      const outbox = createOutbox({ dir, deliver, maxRetries: 50, retryDelayMs: 5 });
      await outbox.start();
      outbox.enqueue({ dedupeKey: `k-fatal-${i}`, chatId: "oc_1", kind: "text", payload: { kind: "text", text: "x" } });
      await sleep(120);
      expect(deliver).toHaveBeenCalledTimes(1); // 首次尝试即判 fatal，不重试
      expect(outbox.failedCount()).toBe(1);
      await outbox.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("指数退避 + 抖动：1s/2s/4s/8s 递增、封顶 60s、±20% 区间内", () => {
    const lo = [800, 1600, 3200, 6400];
    const hi = [1200, 2400, 4800, 9600];
    for (let i = 0; i < 4; i++) {
      // 抽样多次确保落在 ±20% 区间
      for (let k = 0; k < 50; k++) {
        const d = backoffDelayMs(i + 1);
        expect(d).toBeGreaterThanOrEqual(lo[i]);
        expect(d).toBeLessThanOrEqual(hi[i]);
      }
    }
    // 封顶 60s（±20%）
    for (let attempts = 11; attempts <= 50; attempts += 5) {
      const d = backoffDelayMs(attempts);
      expect(d).toBeGreaterThanOrEqual(48_000);
      expect(d).toBeLessThanOrEqual(72_000);
      expect(d).toBeLessThanOrEqual(60_000 * 1.2);
    }
    // attempts=1 起步（不是固定 2s）
    expect(backoffDelayMs(1)).toBeLessThan(1500);
  });

  it("listFailed / retryFailed：failed 信封可列举、可手动重放（死信出口）", async () => {
    const dir = tmpDir();
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: false, error: "400 fatal" });
    const outbox = createOutbox({ dir, deliver, maxRetries: 5 });
    await outbox.start();
    outbox.enqueue({ dedupeKey: "k-dlq", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "死信" } });
    await sleep(120);
    const failed = outbox.listFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0].dedupeKey).toBe("k-dlq");
    expect(failed[0].status).toBe("failed");

    // 手动重放：改回 pending 入队，deliver 恢复后成功
    deliver.mockResolvedValue({ ok: true });
    expect(outbox.retryFailed()).toBe(1);
    await sleep(100);
    expect(outbox.failedCount()).toBe(0);
    expect(outbox.pendingCount()).toBe(0);
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pendingCount 只算 pending，failed 不再虚增（P0-4 第 6 点）", async () => {
    const dir = tmpDir();
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: false, error: "400 fatal" });
    const outbox = createOutbox({ dir, deliver, maxRetries: 5 });
    await outbox.start();
    outbox.enqueue({ dedupeKey: "k-pc", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "x" } });
    await sleep(120);
    expect(outbox.failedCount()).toBe(1);
    expect(outbox.pendingCount()).toBe(0); // ★ 旧实现返回 1（status.json 虚高）
    await outbox.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("describeError：[object Object] → 可读 errcode/errmsg", () => {
    expect(describeError(new Error("Request failed with status code 429"))).toContain("429");
    expect(describeError({ code: 99991668, msg: "too many request" })).toBe("99991668: too many request");
    expect(describeError({ errmsg: "system busy" })).toBe("system busy");
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(undefined)).toBe("unknown");
  });
});
