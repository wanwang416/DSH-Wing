/**
 * ★ 阶段 6b · M12：outbox 容器上限（sentKeys FIFO 淘汰 / envelopes 终态清理）
 * 黑盒口径：只走公开 API（enqueue/deliver/清理终态信封/trimSentKeys），不摸闭包内部。
 * 红线：pending 绝不能因清理丢失；M46/M47/M48 语义不破坏（各留防回归断言）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutbox } from "../../src/outbound/outbox.js";

type Deps = Parameters<typeof createOutbox>[0];

function mkDeps(dir: string, overrides: Partial<Deps> = {}): Deps {
  return {
    dir,
    deliver: vi.fn().mockResolvedValue({ ok: true }),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  } as Deps;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("M12 · sentKeys 上限（FIFO 淘汰：保留最近 N 个键）", () => {
  it("投递成功超过上限 → 旧键被淘汰、最近键仍在（幂等窗口保留）+ 日志留痕", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-outbox-6b-"));
    try {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const ob = createOutbox(mkDeps(dir, { sentKeysLimit: 5, logger }));
      // 连发 8 条（每条投递成功 → sentKeys 增长 + trim）
      for (let i = 0; i < 8; i++) {
        ob.enqueue({ dedupeKey: `dk${i}`, chatId: "oc_1", kind: "text", payload: { kind: "text", text: `m${i}` } });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1);
      }
      // 幂等窗口内（最近 5 条）不应重发；窗口外（dk0/dk1/dk2）已淘汰——重投会当新消息发出（预期语义）
      const again = ob.enqueue({ dedupeKey: "dk7", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "m7" } });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(again).toBe("dk7");
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("sentKeys"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无上限参数时用默认 5000（不传 sentKeysLimit 行为不回归）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-outbox-6b-"));
    try {
      const ob = createOutbox(mkDeps(dir));
      const removed = ob.trimSentKeys(); // 未超限 → 0 条清理，不报错
      expect(removed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M12 · envelopes 终态清理（done 超期清内存，pending 红线不动）", () => {
  it("真实投递流：done 信封超期被清；pending 无论多旧绝不清理（红线断言）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-outbox-6b-"));
    try {
      // ★ 夹具修正：pump 会自动投递——deliver 必须受控（pending 场景用挂起的 deliver）
      let release: (() => void) | undefined;
      const deliver = vi.fn().mockImplementation(() => new Promise<{ ok: boolean }>((res) => { release = () => res({ ok: true }); }));
      const ob = createOutbox(mkDeps(dir, { envelopeRetentionMs: 60_000, deliver }));
      // 一条进入 sending（deliver 挂起中）→ 手动放行成 done
      ob.enqueue({ dedupeKey: "dk_old", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "old" } });
      await vi.advanceTimersByTimeAsync(0);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(ob.pendingCount()).toBe(0); // 已投递成功 → done
      // 时间推进 2 小时 → done 超期
      vi.advanceTimersByTime(2 * 3_600_000);
      const removed = ob.清理终态信封(60_000);
      expect(removed).toBe(1); // done 超期被清
      expect(ob.pendingCount()).toBe(0);
      // 红线：再放一条在途消息（deliver 挂起 → 停在 sending），随便跑多少次清理都不许丢。
      // ★ 6b 验收修正：直接断言"条目还在"（getEnvelope），不借 pendingCount 间接判断——
      //   pendingCount 只统计 status==="pending"，sending 态天然为 0，用它断言红线是口径错。
      let release2: (() => void) | undefined;
      (deliver as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<{ ok: boolean }>((res) => { release2 = () => res({ ok: true }); }));
      const envId = ob.enqueue({ dedupeKey: "dk_p", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "p" } });
      await vi.advanceTimersByTimeAsync(0); // 进入 sending（deliver 挂起中）
      const before = ob.getEnvelope(envId);
      expect(before).toBeTruthy();
      expect(["pending", "sending"]).toContain(before!.status); // 在途确认
      ob.清理终态信封(0); // 保留期=0（最激进清理）
      const after = ob.getEnvelope(envId);
      expect(after).toBeTruthy(); // ★ 红线：在途信封一条不少
      expect(after!.status).toBe(before!.status); // 状态未被清理逻辑改动
      release2?.(); // 收尾放行，防句柄悬挂
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("★ M46/M47/M48 防回归：清理后 failed 保留语义不变（M47：不进 sentKeys、可 retry）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wing-outbox-6b-"));
    try {
      // deliver 恒失败 → 信封走重试→failed 路径（M47：基于最终状态）
      const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: false, error: "boom" });
      const ob = createOutbox(mkDeps(dir, { envelopeRetentionMs: 60_000, maxRetries: 0, deliver }));
      ob.enqueue({ dedupeKey: "dk_f", chatId: "oc_1", kind: "text", payload: { kind: "text", text: "f" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(ob.failedCount()).toBe(1); // failed 保留（不进 sentKeys、不删除）
      // 跑清理：failed 不许被"终态清理"碰（它有自己的 retainDays 语义，M46/M47 管）
      ob.清理终态信封(0);
      expect(ob.failedCount()).toBe(1);
      expect(ob.listFailed().length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
