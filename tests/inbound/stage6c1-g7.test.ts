/**
 * ★ 阶段 6c-1 · G7 集成级先红：合批成员 messageId 未进去重表 → 平台重投即重复执行
 *
 * 场景：群里连发 3 条（合批）→ 窗口 flush 合并投递 → 平台 WS 重投第 1 条。
 * 修复后语义：flush 时批次内**每个** messageId 都被登记去重 → 重投第 1 条被拦。
 * 旧实现：只有 last.messageId（合并事件 id）进去重表 → 重投第 1 条被当新消息 → 重复执行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDedupeStore } from "../../src/inbound/dedup.js";
import { createBatching } from "../../src/inbound/batching.js";

// 独立复刻 index.ts 的 onFlush 语义（修复后的正确接线）：
// flush 整批 → 每条 messageId 占去重位 → 用批尾 id 构造合并事件投递
function makePipline() {
  const dedupe = createDedupeStore(join(mkdtempSync(join(tmpdir(), "g7-")), "dedupe.jsonl"));
  const delivered: string[] = [];
  const batching = createBatching({
    cfg: { windowMs: 100, maxCount: 8, maxChars: 4000 },
    onFlush: (_chatId, items) => {
      // ★ G7 修复：整批逐条登记（旧实现缺这一步 → 成员 id 不进去重表）
      for (const item of items) dedupe.add(item.messageId);
      const last = items[items.length - 1];
      delivered.push(last.messageId);
    },
  });
  return {
    add: (id: string, text: string) => batching.add("oc_1", { messageId: id, text }),
    /** 平台重投：模拟 dispatcher 的去重闸门 */
    replay: (id: string): boolean => dedupe.isDuplicate(id), // true = 被拦（不重复执行）
    deliveredCount: () => delivered.length,
    dispose: () => {},
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("G7 · 合批成员 messageId 进去重表（重投防护）", () => {
  it("批次成员重投被去重拦截；合并事件仍正常投递一次", () => {
    const p = makePipline();
    p.add("m1", "a");
    p.add("m2", "b");
    p.add("m3", "c");
    vi.advanceTimersByTime(101);
    expect(p.deliveredCount()).toBe(1); // 合并事件投递一次
    // 平台重投每个成员 → 全部被拦（旧实现：m1/m2 isDuplicate=false → 当新消息重复执行）
    expect(p.replay("m1")).toBe(true);
    expect(p.replay("m2")).toBe(true);
    expect(p.replay("m3")).toBe(true);
  });

  it("去重登记发生在「决定处理」之后（M22 原则不回归）：flush 前重投同一 id 不占双位", () => {
    const p = makePipline();
    p.add("m1", "a");
    // 窗口未到期、尚未 flush → m1 还没进处理管线；此时平台重投 m1
    // （合批 add 返回 true=已合并，调用方不会单独处理 m1；重投的 m1 也走 add → 仍合批）
    expect(p.replay("m1")).toBe(false); // 尚未决定处理 → 不占位（M22 语义保持）
    vi.advanceTimersByTime(101);
    expect(p.deliveredCount()).toBe(1); // m1 仍在批次里，flush 一次
    expect(p.replay("m1")).toBe(true); // flush 后已登记
  });
});
