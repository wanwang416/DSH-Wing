/**
 * 阶段 3 · A 组回归测试（G1 / G3 / L5 / L6）
 * 先红依据：
 *  - G1：旧 stream() 对同一 streamId 连发多片（企微 stream 帧是全量替换语义）→ 前 N-1 片被覆盖丢失。
 *  - G3：旧实现 replyStream 失败只重试同一张失效帧，不失效、不降级 sendMarkdown。
 *  - L5：旧 withRetry 固定 500/1000ms，无抖动。
 *  - L6：旧实现 activeStreams 只在 finish/降级路径删除，异常路径残留 → hasActiveStream 恒 true。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createWecomSender, utf8Length, wecomBackoffDelayMs, type WecomClientLike } from "../../src/outbound/wecom-sender.js";
import type { WsFrame } from "@wecom/aibot-node-sdk";

const FRAME = { header: { req_id: "r1" } } as unknown as WsFrame;

function makeClient(over: Partial<WecomClientLike> = {}): WecomClientLike {
  const frames = new Map<string, WsFrame>([["chat1", FRAME]]);
  return {
    replyFrameFor: (chatId) => frames.get(chatId),
    replyStream: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    replyWelcome: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ...over,
  };
}

describe("阶段3 A组：企微出站质量", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("G1：stream() 全文超单帧上限 → 绝不同一 streamId 连发多片", async () => {
    const c = makeClient();
    const sender = createWecomSender({ getClient: () => c });
    const handle = { chatId: "chat1", streamId: "s1" };
    const big = "汉".repeat(20000); // 60000B，旧实现切成 ≥4 片
    await sender.stream(handle, big, false);
    const calls = (c.replyStream as ReturnType<typeof vi.fn>).mock.calls;
    const sameStream = calls.filter((k) => k[1] === "s1");
    // 全量替换语义下，同一 streamId 出现多次 = 前面的被覆盖
    expect(sameStream.length).toBeLessThanOrEqual(1);
    // 若仍走 stream 通道，单帧内容必须 ≤ 上限（不可能再塞全文，全文校验见下一用例的并集断言）
    for (const k of calls) {
      expect(utf8Length(String(k[2]))).toBeLessThanOrEqual(19000);
    }
  });

  it("G1：stream() 超上限 → 溢出走 sendMarkdown 通道，全文（stream 内容 + markdown 内容）不丢", async () => {
    const c = makeClient();
    const sender = createWecomSender({ getClient: () => c });
    const handle = { chatId: "chat1", streamId: "s1" };
    const big = "汉".repeat(20000);
    await sender.stream(handle, big, false);
    const md = (c.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls;
    const streamSent = (c.replyStream as ReturnType<typeof vi.fn>).mock.calls
      .map((k) => String(k[2]))
      .join("");
    const mdSent = md
      .map((k) => {
        const body = k[1] as { markdown?: { content?: string } };
        return body?.markdown?.content ?? "";
      })
      .join("");
    // 全文必须完整出现在两个通道的并集里（不丢内容）
    expect(streamSent + mdSent).toBe(big);
  });

  it("G1：finish=true 超上限 → 同样不丢全文且终结流式登记", async () => {
    const c = makeClient();
    const sender = createWecomSender({ getClient: () => c });
    const handle = { chatId: "chat1", streamId: "s1" };
    const big = "汉".repeat(20000);
    await sender.stream(handle, big, true);
    expect(sender.hasActiveStream("chat1")).toBe(false);
    const streamSent = (c.replyStream as ReturnType<typeof vi.fn>).mock.calls
      .map((k) => String(k[2]))
      .join("");
    const mdSent = (c.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls
      .map((k) => {
        const body = k[1] as { markdown?: { content?: string } };
        return body?.markdown?.content ?? "";
      })
      .join("");
    expect(streamSent + mdSent).toBe(big);
  });

  it("G3：replyStream 失败 → 降级 sendMarkdown 重发（同一张失效帧不再重试）", async () => {
    const c = makeClient({
      replyStream: vi.fn().mockRejectedValue(new Error("frame expired")),
    });
    // ★ 阿深修正（2026-10-02 验收）：maxRetries=1 → withRetry 首败即抛且**不产生退避定时器**，
    //   这条用例因此与 fake timers 完全解耦，不会再出现"定时器推进与 await 链互相等待"导致的
    //   5s 真实钟超时（原写法 10×5000ms 虚拟推进、runAllTimersAsync、切真实钟三种都实测失败：
    //   前者超时，后者切换时钟会丢弃在途定时器并冒出 frame expired 未处理 rejection）。
    //   本用例要验证的是"失败后是否降级"，与重试次数无关，缩短重试链不影响断言强度。
    const sender = createWecomSender({ getClient: () => c, maxRetries: 1 });
    const handle = { chatId: "chat1", streamId: "s1" };
    const p = sender.stream(handle, "最终回答内容", false);
    await p;
    // 降级：内容走了 sendMarkdown（不再死磕同一张失效帧）
    // ★ 阿深修正（2026-10-02 验收）：必须取**长度数字快照**——直接保存 `mock.calls` 是活引用，
    //   后续调用会同时改变两边，断言 `a > a` 恒为 false（实测报 "expected 2 to be greater than 2"）。
    const mdCallCountAfterDegrade = (c.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(mdCallCountAfterDegrade).toBeGreaterThan(0);
    // 帧失效后：后续 sendText 不再走 replyStream（canReply=false → sendMarkdown 通道）
    await sender.sendText("chat1", "后续消息");
    expect((c.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(mdCallCountAfterDegrade);
  });

  it("G3：replyStream 失败时有 warn 日志（不许静默降级）", async () => {
    const c = makeClient({
      replyStream: vi.fn().mockRejectedValue(new Error("req_id 过期")),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = createWecomSender({ getClient: () => c, logger });
    const p = sender.stream({ chatId: "chat1", streamId: "s1" }, "内容X", false);
    await vi.runAllTimersAsync();
    await p;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("降级"));
  });

  it("L5：退避延迟带 ±20% 抖动（直测 wecomBackoffDelayMs：基准 500×2^i，区间 0.8~1.2 倍）", () => {
    for (let i = 0; i < 40; i++) {
      const d0 = wecomBackoffDelayMs(0);
      expect(d0).toBeGreaterThanOrEqual(400);
      expect(d0).toBeLessThanOrEqual(600);
      const d1 = wecomBackoffDelayMs(1);
      expect(d1).toBeGreaterThanOrEqual(800);
      expect(d1).toBeLessThanOrEqual(1200);
      const d5 = wecomBackoffDelayMs(5);
      expect(d5).toBeLessThanOrEqual(4000 * 1.2); // 封顶 4s ± 抖动
    }
  });

  it("L6：流式条目空闲超时 → activeStreams 清理 + warn 计数（不永久残留）", async () => {
    vi.useRealTimers();
    const c = makeClient();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = createWecomSender({ getClient: () => c, logger, streamIdleTimeoutMs: 100 });
    const h = await sender.beginStream("chat1", "首片");
    expect(h).toBeDefined();
    expect(sender.hasActiveStream("chat1")).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(sender.hasActiveStream("chat1")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("activeStreams"));
  });
});
