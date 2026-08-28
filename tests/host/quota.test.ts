import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaGovernor } from "../../src/host/quota.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "wing-quota-")), "conn-history.jsonl");
}

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("createQuotaGovernor", () => {
  it("失败累积到 limit → tripped；remaining 递减", () => {
    const file = tmpFile();
    const q = createQuotaGovernor(file, { windowMinutes: 60, limit: 3 });
    q.recordFailure();
    q.recordFailure();
    expect(q.tripped()).toBe(false);
    expect(q.remaining()).toBe(1);
    q.recordFailure();
    expect(q.tripped()).toBe(true);
    expect(q.remaining()).toBe(0);
  });

  it("recordConnect 不计数为失败", () => {
    const file = tmpFile();
    const q = createQuotaGovernor(file, { windowMinutes: 60, limit: 2 });
    q.recordConnect();
    q.recordConnect();
    expect(q.tripped()).toBe(false);
    expect(q.remaining()).toBe(2);
  });

  it("窗口过期 prune 自动解除熔断", () => {
    const file = tmpFile();
    const clock = makeClock();
    const q = createQuotaGovernor(file, { windowMinutes: 60, limit: 1, now: clock.now });
    q.recordFailure();
    expect(q.tripped()).toBe(true);
    // 推进超过窗口
    clock.advance(61 * 60_000);
    expect(q.tripped()).toBe(false);
    expect(q.remaining()).toBe(1);
  });

  it("resetAt 返回最早失败的窗口到期时间", () => {
    const file = tmpFile();
    const clock = makeClock();
    const q = createQuotaGovernor(file, { windowMinutes: 60, limit: 2, now: clock.now });
    q.recordFailure();
    clock.advance(10_000);
    q.recordFailure();
    expect(q.resetAt()).toBe(1_000_000 + 60 * 60_000);
  });

  it("reset 清空历史", () => {
    const file = tmpFile();
    const q = createQuotaGovernor(file, { windowMinutes: 60, limit: 1 });
    q.recordFailure();
    expect(q.tripped()).toBe(true);
    q.reset();
    expect(q.tripped()).toBe(false);
    expect(q.resetAt()).toBeUndefined();
  });

  it("历史持久化：重启后仍在窗口内", () => {
    const file = tmpFile();
    const q1 = createQuotaGovernor(file, { windowMinutes: 60, limit: 1 });
    q1.recordFailure();
    expect(q1.tripped()).toBe(true);
    // 模拟重启
    const q2 = createQuotaGovernor(file, { windowMinutes: 60, limit: 1 });
    expect(q2.tripped()).toBe(true);
    expect(q2.remaining()).toBe(0);
  });

  it("损坏行忽略，不崩溃", () => {
    const file = tmpFile();
    const clock = makeClock();
    const { writeFileSync } = require("node:fs");
    writeFileSync(file, "not-json\n{\"at\":1000000,\"ok\":false}\n");
    const q = createQuotaGovernor(file, { windowMinutes: 60, limit: 1, now: clock.now });
    expect(q.tripped()).toBe(true);
  });

  it("历史文件不存在 → 空历史", () => {
    const q = createQuotaGovernor(join(tmpdir(), "nonexistent-" + Math.random() + ".jsonl"), { windowMinutes: 60, limit: 1 });
    expect(q.tripped()).toBe(false);
    expect(q.remaining()).toBe(1);
  });
});
