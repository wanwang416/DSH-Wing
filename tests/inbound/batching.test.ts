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

  it("超过 maxCount 时立即 flush 并单独处理", () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 1000, maxCount: 3, maxChars: 4000 }, onFlush });
    expect(batching.add("oc_1", { messageId: "m1", text: "1" })).toBe(true); // 创建批次
    expect(batching.add("oc_1", { messageId: "m2", text: "2" })).toBe(true); // 2 条
    // 第 3 条满 maxCount → 触发 flush（返回 false，调用方单独处理）
    expect(batching.add("oc_1", { messageId: "m3", text: "3" })).toBe(false);
    expect(batching.size()).toBe(0); // 批次已 flush
    // 后续消息重新开批次
    expect(batching.add("oc_1", { messageId: "m4", text: "4" })).toBe(true);
  });

  it("不同 chat 独立合批", async () => {
    const onFlush = vi.fn();
    const batching = createBatching({ cfg: { windowMs: 50, maxCount: 8, maxChars: 4000 }, onFlush });
    batching.add("oc_1", { messageId: "a1", text: "甲" });
    batching.add("oc_2", { messageId: "b1", text: "乙" });
    await sleep(100);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });
});
