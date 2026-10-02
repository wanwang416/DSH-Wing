import { describe, expect, it, vi } from "vitest";
import { createBatching } from "../../src/inbound/batching.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("batching 合批", () => {
  it("窗口内同 chat 消息合并，flush 回调收到合并批次", async () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 50, maxCount: 8, maxChars: 4000 }, onFlush });
    batching.add("oc_1", { messageId: "m1", text: "你好" });
    batching.add("oc_1", { messageId: "m2", text: "在吗" });
    await sleep(100);
    expect(onFlush).toHaveBeenCalledTimes(1);
    const [chatId, items] = onFlush.mock.calls[0] as [string, Array<{ text: string }>];
    expect(chatId).toBe("oc_1");
    expect(items.map((i) => i.text)).toEqual(["你好", "在吗"]);
    expect(batching.merge(items)).toBe("你好\n在吗");
  });

  it("超过 maxCount 时整批 flush，返回 true，不丢批次内消息（P0 施工项 1）", () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 1000, maxCount: 3, maxChars: 4000 }, onFlush });
    expect(batching.add("oc_1", { messageId: "m1", text: "1" })).toBe(true); // 创建批次
    expect(batching.add("oc_1", { messageId: "m2", text: "2" })).toBe(true); // 2 条
    // 第 3 条满 maxCount → 整批（含第 3 条）交给 onFlush，返回 true（调用方不再单独处理）
    expect(batching.add("oc_1", { messageId: "m3", text: "3" })).toBe(true);
    expect(onFlush).toHaveBeenCalledTimes(1); // ★ 恰好一次（旧实现丢弃返回值 → 0 次回调 + 批次丢失）
    const [chatId, items] = onFlush.mock.calls[0] as [string, Array<{ messageId: string; text: string }>];
    expect(chatId).toBe("oc_1");
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(batching.merge(items)).toBe("1\n2\n3");
    expect(batching.size()).toBe(0); // 批次已 flush
    // 后续消息重新开批次
    expect(batching.add("oc_1", { messageId: "m4", text: "4" })).toBe(true);
  });

  it("满员 flush 后 onFlush 恰好一次且合并文本含全部消息（8 条满员复现，P0 施工项 1 验收）", async () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 60_000, maxCount: 8, maxChars: 4000 }, onFlush });
    for (let i = 1; i <= 8; i++) {
      batching.add("oc_group", { messageId: `om_${i}`, text: `消息${i}` });
    }
    // 满 8 条立即 flush（不等窗口）→ onFlush 一次收全 8 条
    expect(onFlush).toHaveBeenCalledTimes(1);
    const [, items] = onFlush.mock.calls[0] as [string, Array<{ text: string }>];
    expect(items).toHaveLength(8);
    const merged = batching.merge(items);
    for (let i = 1; i <= 8; i++) expect(merged).toContain(`消息${i}`);
    await sleep(50);
    expect(onFlush).toHaveBeenCalledTimes(1); // 窗口到期不会重复 flush
  });

  it("不同 chat 独立合批", async () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 50, maxCount: 8, maxChars: 4000 }, onFlush });
    batching.add("oc_1", { messageId: "a1", text: "甲" });
    batching.add("oc_2", { messageId: "b1", text: "乙" });
    await sleep(100);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("BatchItem 带 chatType → flush 保留真实 chatType（透传，M4-R3 任务 4）", async () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 50, maxCount: 8, maxChars: 4000 }, onFlush });
    // oc_ 前缀 chatId 但事件真值是 p2p（P2P 会话实证）→ 透传 p2p
    batching.add("oc_FAKE_CHAT_FOR_TEST5febf004d34aa554d341b3d8a", { messageId: "m1", text: "你好", chatType: "p2p" });
    batching.add("oc_FAKE_CHAT_FOR_TEST5febf004d34aa554d341b3d8a", { messageId: "m2", text: "在吗", chatType: "p2p" });
    await sleep(100);
    const items = onFlush.mock.calls[0][1] as Array<{ chatType?: string }>;
    expect(items).toHaveLength(2);
    expect(items[0].chatType).toBe("p2p");
    expect(items[1].chatType).toBe("p2p");
  });

  it("BatchItem 无 chatType → flush 条目 chatType 为 undefined（调用方兜底）", async () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 50, maxCount: 8, maxChars: 4000 }, onFlush });
    batching.add("oc_1", { messageId: "m1", text: "旧格式" });
    await sleep(100);
    const items = onFlush.mock.calls[0][1] as Array<{ chatType?: string }>;
    expect(items[0].chatType).toBeUndefined();
  });
});
