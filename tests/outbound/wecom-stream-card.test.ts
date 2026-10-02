/**
 * 企微流式卡片（WecomStreamCard）单测
 *
 * 返工 D5/M3/N1(a)：无回调帧时中途不发、收尾一次性发完整终稿。
 *   - canReply=false → push 前置短路，beginStream 不被调用（真正零中途发送）
 *   - 收尾恰好 1 次 onFallback（完整终稿，不残稿）
 *   - 有回调帧 → 走 replyStream 正常流式（回归）
 */
import { describe, expect, it, vi } from "vitest";
import { WecomStreamCard } from "../../src/outbound/wecom-stream-card.js";

function makeSender(overrides: Record<string, unknown> = {}) {
  const canReply = vi.fn().mockReturnValue(true);
  const beginStream = vi.fn().mockResolvedValue({ chatId: "u1", streamId: "s1" });
  const stream = vi.fn().mockResolvedValue(undefined);
  return {
    sender: { canReply, beginStream, stream, ...overrides },
    canReply,
    beginStream,
    stream,
  };
}

function makeCard(sender: any) {
  const onFallback = vi.fn().mockResolvedValue(undefined);
  const card = new WecomStreamCard("u1", {
    sender,
    logger: { info: vi.fn(), warn: vi.fn() },
    onFallback,
  });
  return { card, onFallback };
}

describe("WecomStreamCard：N1(a)/M3 无帧降级", () => {
  it("无回调帧（canReply=false）→ 中途零发送：beginStream 不被调用", async () => {
    const { sender, canReply, beginStream } = makeSender();
    canReply.mockReturnValue(false);
    const { card, onFallback } = makeCard(sender);
    await card.addText("你好");
    await card.addText("，这是");
    await card.addText("中间内容");
    expect(beginStream).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("收尾恰好 1 次 onFallback 完整终稿（不残稿、不刷屏）", async () => {
    const { sender, canReply, beginStream } = makeSender();
    canReply.mockReturnValue(false);
    const { card, onFallback } = makeCard(sender);
    await card.addText("你好");
    await card.addText("，这是中间内容");
    await card.addText("，收尾完整终稿");
    await card.finalizeToNewCard("你好，这是中间内容，收尾完整终稿");
    expect(beginStream).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("u1", "你好，这是中间内容，收尾完整终稿");
  });

  it("有回调帧 → 正常流式（回归：beginStream 一次 + stream 刷新）", async () => {
    const { sender, beginStream, stream } = makeSender();
    const { card, onFallback } = makeCard(sender);
    await card.addText("开头");
    expect(beginStream).toHaveBeenCalledTimes(1);
    await card.addText("中".repeat(40)); // 40 字符 ≥ WECOM_STREAM_MIN_DELTA，跳过节流直接推帧
    expect(stream).toHaveBeenCalled();
    await card.finalizeToNewCard("完整回答");
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("流式失败 → 降级 onFallback 完整终稿（不重复发送）", async () => {
    const { sender, stream } = makeSender();
    stream.mockRejectedValueOnce(new Error("网络中断"));
    const { card, onFallback } = makeCard(sender);
    await card.addText("开头");
    await card.finalizeToNewCard("完整回答");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("u1", "完整回答");
  });
});
