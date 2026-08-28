import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { StreamingCard, buildRichCardJson, STREAM_INTERVAL_MS } from "../../src/outbound/streaming-card.js";
import { contextStep, toolCallStep } from "../../src/outbound/tool-step.js";

function makeCard(opts: { cardkit?: boolean; createFails?: boolean } = {}) {
  const create = vi
    .fn()
    .mockResolvedValue({ messageId: "om_ck", cardId: "cc_1" });
  if (opts.createFails) create.mockRejectedValue(new Error("cardkit create fail"));
  const stream = vi.fn().mockResolvedValue({});
  const sendCard = vi.fn().mockResolvedValue({ data: { message_id: "om_inline" } });
  const updateCard = vi.fn().mockResolvedValue({});
  const onFallback = vi.fn().mockResolvedValue(undefined);
  const sender = {
    sendCard,
    updateCard,
    sendCardKitCard: vi.fn(),
    streamCardContent: vi.fn(),
  };
  const card = new StreamingCard("oc_1", {
    sender: sender as never,
    logger: { warn: vi.fn(), info: vi.fn() },
    onFallback,
    ...(opts.cardkit ? { cardkit: { create, stream } } : {}),
  });
  return { card, create, stream, sendCard, updateCard, onFallback, sender };
}

/** 长文本帮助：触发 30 字符节流 */
const LONG = "x".repeat(60);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("buildRichCardJson 富卡片（C1：多元素分行）", () => {
  it("结构：header + Tools collapsible_panel + main_text element_id", () => {
    const json = buildRichCardJson([toolCallStep("Bash", '{"command":"npm test"}'), contextStep("用户注入")], "最终回答", false, "blue");
    const card = JSON.parse(json) as any;
    expect(card.schema).toBe("2.0");
    expect(card.header.template).toBe("blue");
    const panels = card.body.elements.filter((e: any) => e.tag === "collapsible_panel");
    expect(panels).toHaveLength(1); // 只有 Tools（无 thinking）
    expect(panels[0].header.title.content).toContain("Tools");
    // 工具行分行
    const rows = panels[0].elements.map((e: any) => e.text.content);
    expect(rows.some((r: string) => r.includes("🔧") && r.includes("Bash"))).toBe(true);
    expect(rows.some((r: string) => r.includes("📥") && r.includes("上下文注入"))).toBe(true);
    // main_text 元素带 element_id（CardKit 流式目标）
    const main = card.body.elements.find((e: any) => e.element_id === "main_text");
    expect(main.content).toBe("最终回答");
  });

  it("超 10 步 → 隐藏提示（C2 元素过多）", () => {
    const steps = Array.from({ length: 15 }, (_, i) => toolCallStep(`Tool${i}`, '{"command":"run"}'));
    const json = buildRichCardJson(steps, "", false, "blue");
    const card = JSON.parse(json) as any;
    const tools = card.body.elements.find((e: any) => e.tag === "collapsible_panel");
    const texts = tools.elements.map((e: any) => e.text.content).join("\n");
    expect(texts).toContain("隐藏");
    expect(texts).toContain("Tool14"); // 最近步骤可见
    expect(texts).not.toContain("Tool0"); // 最早步骤隐藏
  });
});

describe("StreamingCard 分行 + 状态（C1）", () => {
  it("addTool → Tools panel 加一行；setToolResult → ✅", async () => {
    const { card, updateCard } = makeCard({ cardkit: true });
    await card.addTool("Bash", '{"command":"npm test"}');
    await vi.advanceTimersByTimeAsync(2000); // ★M4：schedulePatch 防抖 timer 触发 + 微任务 flush（patchFull#1: 🔧）
    await card.setToolResult("Bash");
    await vi.advanceTimersByTimeAsync(2000); // ★M4：setToolResult 防抖 → patchFull#2: ✅
    const lastJson = updateCard.mock.calls.at(-1)![1];
    const parsed = JSON.parse(lastJson) as any;
    const tools = parsed.body.elements.find((e: any) => e.tag === "collapsible_panel");
    const rows = tools.elements.map((e: any) => e.text.content).join("\n");
    expect(rows).toContain("✅");
    expect(rows).toContain("Bash");
  });

  it("addTool 失败 → setToolResult(error) → ❌", async () => {
    const { card, updateCard } = makeCard({ cardkit: true });
    await card.addTool("Bash", '{"command":"npm test"}');
    await vi.advanceTimersByTimeAsync(2000); // ★M4：防抖 timer 触发 + flush
    await card.setToolResult("Bash", new Error("boom"));
    await vi.advanceTimersByTimeAsync(2000); // ★M4：setToolResult 防抖 → patchFull(❌)
    const parsed = JSON.parse(updateCard.mock.calls.at(-1)![1]) as any;
    const tools = parsed.body.elements.find((e: any) => e.tag === "collapsible_panel");
    expect(tools.elements[0].text.content).toContain("❌");
  });

  it("addThinking → Reasoning panel（💭）", async () => {
    // ★M4 修复：thinkingTimeout 防抖用 fake timer 推进（含 Date.now）+ flush 微任务；updateCard 第 2 参数才是 cardJson
    const { card, updateCard } = makeCard({ cardkit: true });
    await card.addThinking("让我想想" + LONG);
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 100);
    const parsed = JSON.parse(updateCard.mock.calls.at(-1)![1] as any) as any;
    const panels = parsed.body.elements.filter((e: any) => e.tag === "collapsible_panel");
    expect(panels[0].header.title.content).toContain("Reasoning");
    expect(panels[0].elements[0].text.content).toContain("💭");
  });
});

describe("CardKit 流式打字机 + 三级降级链（B1/B2）", () => {
  it("text-delta → CardKit PUT main_text（打字机），非全量 updateMessage", async () => {
    const { card, stream, updateCard } = makeCard({ cardkit: true });
    await card.addText("这是回答内容用于触发流式更新测试文本长度" + LONG);
    expect(stream).toHaveBeenCalledTimes(1);
    const [cardId, content] = stream.mock.calls[0];
    expect(cardId).toBe("cc_1");
    expect(content).toContain("这是回答内容");
    // 打字机路径下 main_text 更新不触发全量 updateCard
    const fullCalls = updateCard.mock.calls.filter((c) => JSON.parse(c[1]).body?.elements?.some((e: any) => e.tag === "collapsible_panel"));
    expect(fullCalls.length).toBe(0);
  });

  it("CardKit create 失败 → 降级 inline sendCard（B2 一级）", async () => {
    const { card, sendCard, onFallback } = makeCard({ cardkit: true, createFails: true });
    await card.addTool("Bash", '{"command":"npm test"}');
    vi.advanceTimersByTime(2000);
    await card.finalize("最终回答");
    expect(sendCard).toHaveBeenCalled(); // inline 卡片路径
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("CardKit stream 失败 → 降级 updateMessage（B2 二级）", async () => {
    const { card, stream, updateCard, onFallback } = makeCard({ cardkit: true });
    stream.mockRejectedValueOnce(new Error("stream fail"));
    await card.addText("这是回答内容用于触发流式更新测试文本长度" + LONG);
    // stream 失败 → 一级降级 updateCard（含 panels 或单 markdown）
    expect(updateCard).toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("全量 updateCard 失败 → onFallback 普通文本（B2 三级）", async () => {
    const { card, updateCard, onFallback } = makeCard({ cardkit: true });
    updateCard.mockRejectedValue(new Error("update fail"));
    await card.addTool("Bash", '{"command":"npm test"}');
    await card.finalize("最终回答");
    expect(onFallback).toHaveBeenCalledWith("oc_1", expect.stringContaining("最终回答"));
  });

  it("无 cardkit → 纯 inline 全量更新（updateCard），不崩溃", async () => {
    const { card, sendCard, updateCard, stream } = makeCard({ cardkit: false });
    await card.addTool("Bash", '{"command":"npm test"}');
    await vi.advanceTimersByTimeAsync(2000); // ★M4：防抖 timer 触发 → patchFull → ensureCreated(inline) → updateCard
    expect(sendCard).toHaveBeenCalled(); // inline 创建
    expect(updateCard).toHaveBeenCalled(); // 全量更新
    expect(stream).not.toHaveBeenCalled();
  });
});
