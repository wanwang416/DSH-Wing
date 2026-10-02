/**
 * 阶段 3 · B 组回归测试（M8 双卡 / M9 sequence / M10 定时器清理）
 * 先红依据：
 *  - M8：旧 finalizeToNewCard 中 cardkit.create 成功后 stream 抛错 → fall through 到 inline sendCard →
 *        同屏两张卡（CardKit 占位卡 + inline 全量卡）。
 *  - M9：旧 streamContent 的 sequence += 1 在 streamQueue.then 内、withRetry（sender 层）之外 →
 *        sender 层重试用同一 sequence，被平台拒绝。
 *  - M10：旧 finalize/finalizeToNewCard 不清 updateTimeout/thinkingTimeout → 迟到 patchFull 事后改写
 *         过程卡，其 catch 分支走 onFallback 再发一遍正文。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StreamingCard } from "../../src/outbound/streaming-card.js";
import { createSender } from "../../src/outbound/sender.js";

let m9Seq = 0; // M9 用例的 sequence 计数器

function makeDeps(over: Partial<ConstructorParameters<typeof StreamingCard>[1]> = {}) {
  return {
    sender: {
      sendCard: vi.fn().mockResolvedValue({ data: { message_id: "msg_inline" } }),
      updateCard: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    onFallback: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as ConstructorParameters<typeof StreamingCard>[1];
}

describe("阶段3 B组：飞书卡片质量", () => {
  // 注意（坑 3 教训）：不用 describe 级 fake timers——M9 的 sender 层重试链需要真实时钟推进，
  // 需要假定时器的用例在自己内部 useFakeTimers/useRealTimers 成对控制。

  it("M8：cardkit.create 成功后 stream 失败 → 不再新建 inline 卡（同屏不出现两张）", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        cardkit: {
          create: vi.fn().mockResolvedValue({ messageId: "msg_ck", cardId: "card_ck" }),
          stream: vi.fn().mockRejectedValue(new Error("stream failed")),
        },
      });
      const card = new StreamingCard("chat1", deps);
      const ok = await card.finalizeToNewCard("最终答案");
      await vi.runAllTimersAsync();
      expect(ok).toBe(true); // 结果卡已发出（CardKit 那张）
      // 不再 fall through 到 inline sendCard（旧实现 sendCard 也会被调用 → 双卡）
      expect((deps.sender.sendCard as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M9：重试链中每次真实 PUT 拿到新 sequence（严格递增）——下沉到 sender 层验证", async () => {
    // 旧实现病灶在 sender 层 withRetry：固定 sequence 重试 → 平台拒绝。
    // mock cardkit 会把重试链 mock 掉，故此处用真实 sender + mock client 复现完整链路（坑 3 教训）。
    const seen: number[] = [];
    let calls = 0;
    const client = {
      streamMessageContent: vi.fn().mockImplementation((_cid: string, _c: string, seq: number) => {
        calls += 1;
        seen.push(seq);
        if (calls < 3) return Promise.reject(new Error("transient"));
        return Promise.resolve({});
      }),
    };
    const sender = createSender({
      getClient: () => client,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    await sender.streamCardContent("card_ck", "内容", () => {
      m9Seq += 1;
      return m9Seq;
    });
    expect(calls).toBe(3);
    // 重试的每次真实 PUT，sequence 严格递增
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("M9：StreamingCard 传给 cardkit.stream 的是 sequence 工厂（调用两次递增）", async () => {
    vi.useFakeTimers();
    try {
      const captured: unknown[] = [];
      const deps = makeDeps({
        cardkit: {
          create: vi.fn().mockResolvedValue({ messageId: "msg_ck", cardId: "card_ck" }),
          stream: vi.fn().mockImplementation((_cid: string, _c: string, seq: unknown) => {
            captured.push(seq);
            return Promise.resolve(undefined);
          }),
        },
      });
      const card = new StreamingCard("chat1", deps);
      await card.addText("回答内容超三十个字符了吗看看这行够不够三十个字符的长度限制呢继续补一点字");
      await vi.runAllTimersAsync();
      expect(captured.length).toBeGreaterThan(0);
      const factory = captured[0] as () => number;
      expect(typeof factory).toBe("function");
      const a = factory();
      const b = factory();
      expect(b).toBe(a + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M10：finalize 前已调度的防抖定时器，finalize 后触发 → 不再 PATCH、不重复 fallback", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const card = new StreamingCard("chat1", deps);
      // addTool → schedulePatch 定时器挂起（尚未触发）
      await card.addTool("工具A");
      const updateCallsBefore = (deps.sender.updateCard as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(updateCallsBefore).toBe(0); // 定时器未到，还没 PATCH
      await card.finalize("答案A");
      const fallbackCalls = (deps.onFallback as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.runAllTimersAsync(); // 推进时钟：若定时器未被清理，patchFull 会在此触发
      expect((deps.sender.updateCard as ReturnType<typeof vi.fn>).mock.calls.length).toBe(updateCallsBefore + 1); // 仅 finalize 自己的一次全量
      expect((deps.onFallback as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fallbackCalls); // 无重复 fallback
    } finally {
      vi.useRealTimers();
    }
  });

  it("M10：finalize 后迟到 addText → 直接被 closed 守卫拒绝（不发任何 PATCH）", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const card = new StreamingCard("chat1", deps);
      await card.finalize("答案A");
      const updateCalls = (deps.sender.updateCard as ReturnType<typeof vi.fn>).mock.calls.length;
      await card.addText("迟到内容".repeat(10)); // 大内容，绕过防抖节流直通 patchAnswer
      await vi.runAllTimersAsync();
      expect((deps.sender.updateCard as ReturnType<typeof vi.fn>).mock.calls.length).toBe(updateCalls);
      expect((deps.onFallback as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M10：finalizeToNewCard 后迟到 addThinking → 不再触发 PATCH", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        cardkit: {
          create: vi.fn().mockResolvedValue({ messageId: "m1", cardId: "c1" }),
          stream: vi.fn().mockResolvedValue(undefined),
        },
      });
      const card = new StreamingCard("chat1", deps);
      await card.finalizeToNewCard("答案B");
      await vi.runAllTimersAsync();
      const streamCalls =
        ((deps.cardkit as { stream: ReturnType<typeof vi.fn> }).stream as ReturnType<typeof vi.fn>).mock.calls.length;
      await card.addThinking("迟到思考");
      await vi.runAllTimersAsync();
      expect(
        ((deps.cardkit as { stream: ReturnType<typeof vi.fn> }).stream as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(streamCalls);
    } finally {
      vi.useRealTimers();
    }
  });
});
