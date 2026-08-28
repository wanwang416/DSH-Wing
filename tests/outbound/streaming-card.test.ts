import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCardJson,
  buildRichCardJson,
  StreamingCard,
  MAX_RICH_CARD_BYTES,
  STREAM_INTERVAL_MS,
} from "../../src/outbound/streaming-card.js";

function makeSender() {
  return {
    sendCard: vi.fn(),
    updateCard: vi.fn(() => Promise.resolve()),
  } as any;
}

function makeCardkit() {
  return {
    create: vi.fn((_chatId: string, _json: string) => Promise.resolve({ messageId: "m_cardkit", cardId: "c_1" })),
    stream: vi.fn(() => Promise.resolve()),
  } as any;
}

describe("buildCardJson", () => {
  it("streaming true → streaming_mode true", () => {
    const j = JSON.parse(buildCardJson("hello"));
    expect(j.config.streaming_mode).toBe(true);
    expect(j.body.elements[0].content).toBe("hello");
  });
  it("streaming false + 空内容 → 空白占位", () => {
    const j = JSON.parse(buildCardJson("", false));
    expect(j.config.streaming_mode).toBe(false);
    expect(j.body.elements[0].content).toBe(" ");
  });
});

describe("buildRichCardJson", () => {
  const steps: any[] = [
    { kind: "thinking", name: "Thinking", summary: "先看问题", done: true },
    { kind: "tool", name: "bash", summary: '{"cmd":"ls"}', done: true },
    { kind: "tool", name: "read", summary: "读文件", done: false, error: true, result: "权限拒绝" },
  ];
  it("带 reasoning + tools panels + main_text", () => {
    const j = JSON.parse(buildRichCardJson(steps, "答案", true, "blue", "Working…"));
    expect(j.header.template).toBe("blue");
    expect(j.body.elements.length).toBe(3); // Reasoning + Tools + main_text
    expect(j.body.elements[0].header.title.content).toBe("Reasoning (1)");
    expect(j.body.elements[1].header.title.content).toBe("Tools (2)");
    expect(j.body.elements[2].content).toBe("答案");
  });
  it("空 steps + streaming → 默认 Reasoning 面板", () => {
    const j = JSON.parse(buildRichCardJson([], "", true));
    expect(j.body.elements[0].header.title.content).toBe("Reasoning");
  });
  it("空 steps + 非 streaming → 只有 main_text", () => {
    const j = JSON.parse(buildRichCardJson([], "ok", false));
    expect(j.body.elements).toHaveLength(1);
  });
  it("headerTemplate green（done）/ red（error）经 headerTitle", () => {
    expect(JSON.parse(buildRichCardJson([], "x", true, "green", "Done")).header.template).toBe("green");
    expect(JSON.parse(buildRichCardJson([], "x", true, "red", "Error")).header.template).toBe("red");
  });
  it("summary 含换行 → 取第一行；result 追加", () => {
    const multi = JSON.parse(buildRichCardJson([{ kind: "tool", name: "bash", summary: "第一行\n第二行", done: true }], "", true));
    const content = multi.body.elements[0].elements[0].text.content as string;
    expect(content).toContain("bash");
    expect(content).toContain("第一行");
    expect(content).not.toContain("第二行");
  });
});

describe("StreamingCard（inline 模式）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(overrides: any = {}) {
    const sender = makeSender();
    const onFallback = vi.fn(() => Promise.resolve());
    const logger = { info: vi.fn(), warn: vi.fn() };
    const card = new StreamingCard("oc_1", { sender, onFallback, logger, ...overrides });
    return { sender, onFallback, logger, card };
  }

  it("并发 addTool + addText（inline 模式）→ sendCard 只调用 1 次（单飞保护）", async () => {
    const sender = makeSender();
    let resolveSend!: (v: { data: { message_id: string } }) => void;
    sender.sendCard.mockImplementation(() => new Promise((res) => { resolveSend = res; }));
    const card = new StreamingCard("oc_1", {
      sender,
      onFallback: vi.fn(() => Promise.resolve()),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    card.addTool("bash");
    const pAdd = card.addText("你好");
    await Promise.resolve();
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    resolveSend({ data: { message_id: "m_1" } });
    await pAdd;
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
  });

  it("addThinking 建 thinking 步骤 → patchFull → sendCard + updateCard（sendCard 返回 SDK 标准 data.message_id）", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    card.addThinking("分析中");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    expect(sender.updateCard).toHaveBeenCalled();
    expect(JSON.parse(sender.updateCard.mock.calls[0][1]).body.elements[0].elements[0].text.content).toContain("分析中");
  });

  it("addThinking 连续 delta → 追加同一 thinking 步骤（合并）", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    card.addThinking("第一步");
    card.addThinking("第二步");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    const json = JSON.parse(sender.updateCard.mock.calls[0][1]);
    const content = json.body.elements[0].elements[0].text.content as string;
    expect(content).toContain("第一步第二步");
  });

  it("sendCard 直接返回 { message_id }", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ message_id: "m_direct" });
    card.addTool("bash");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(sender.updateCard).toHaveBeenCalled();
  });

  it("sendCard 返回 { data: { item: { message_id } } }", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { item: { message_id: "m_item" } } });
    card.addContext("上下文");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(sender.updateCard).toHaveBeenCalled();
  });

  it("addText → patchAnswer → patchDebounced → updateCard（打字机）", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    await card.addText("你好世界"); // 首个 delta 等卡片创建
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    expect(sender.updateCard).toHaveBeenCalled();
  });

  it("addText 节流：短间隔小增量 → 跳过 updateCard", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    await card.addText("很长很长很长很长很长很长很长很长很长很长很长很长很长"); // >30 字符，突破节流
    const callsBefore = sender.updateCard.mock.calls.length;
    await card.addText("b"); // delta=1 <30 且 timeDiff≈0 → 节流 return
    expect(sender.updateCard.mock.calls.length).toBe(callsBefore);
  });

  it("addTool / setToolResult（成功）/ setToolResult（error → status error）", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    card.addTool("bash", '{"cmd":"ls"}');
    card.setToolResult("bash");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    const j = JSON.parse(sender.updateCard.mock.calls.at(-1)[1]);
    // 两个 addTool 各触发一次 patch，但结果步骤已 done ✅
    expect(j.header.template).toBe("blue");
  });

  it("setToolResult error → header 变 red", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    card.addTool("bash");
    card.setToolResult("bash", new Error("命令失败"));
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    const j = JSON.parse(sender.updateCard.mock.calls.at(-1)[1]);
    expect(j.header.template).toBe("red");
  });

  it("setToolResult 找不到对应未 done 步骤 → 不报错且不触发 patch", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    card.setToolResult("不存在的工具"); // 无 addTool → step undefined → return
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(sender.updateCard).not.toHaveBeenCalled();
  });

  it("finalize → status done + updateCard（header green）", async () => {
    const { sender, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    await card.finalize("完整答案");
    const j = JSON.parse(sender.updateCard.mock.calls.at(-1)[1]);
    expect(j.header.template).toBe("green");
    expect(j.header.title.content).toBe("Done");
    expect(j.body.elements.at(-1).content).toBe("完整答案");
  });

  it("sendCard 未返回 message_id → throw → failed，后续 addText 短路", async () => {
    const { sender, logger, card } = setup();
    sender.sendCard.mockResolvedValue({});
    const originalWarn = console.warn;
    console.warn = vi.fn();
    await card.addText("会失败");
    console.warn = originalWarn;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("降级普通消息"));
    await card.addText("已被 failed 短路");
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
  });

  it("updateCard 抛错 → onFallback 降级普通消息（patchFull 路径）", async () => {
    const { sender, onFallback, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    sender.updateCard.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("card full"));
    // 先有 answer（onFallback 需要非空文本）
    await card.addText("有答案");
    card.addTool("bash");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(onFallback).toHaveBeenCalledWith("oc_1", "有答案");
  });

  it("finalize updateCard 抛错 → failed + onFallback", async () => {
    const { sender, onFallback, card } = setup();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    sender.updateCard.mockRejectedValueOnce(new Error("finalize fail"));
    await card.finalize("有答案");
    expect(onFallback).toHaveBeenCalledWith("oc_1", "有答案");
  });

  it("finalize failed 短路分支 → 直接 onFallback", async () => {
    const { sender, onFallback, card } = setup();
    sender.sendCard.mockResolvedValue({});
    const originalWarn = console.warn;
    console.warn = vi.fn();
    await card.addText("x");
    console.warn = originalWarn;
    await card.finalize("失败后的答案");
    expect(onFallback).toHaveBeenCalledWith("oc_1", "失败后的答案");
  });

  it("finalize 空答案（failed 分支）→ 不 onFallback", async () => {
    const { sender, onFallback, card } = setup();
    sender.sendCard.mockResolvedValue({});
    const originalWarn = console.warn;
    console.warn = vi.fn();
    await card.addText("x");
    console.warn = originalWarn;
    await card.finalize("No response.");
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("StreamingCard（cardkit 模式）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(cardkit: any) {
    const sender = makeSender();
    const onFallback = vi.fn(() => Promise.resolve());
    const logger = { info: vi.fn(), warn: vi.fn() };
    const card = new StreamingCard("oc_1", { sender, onFallback, logger, cardkit });
    return { sender, onFallback, logger, card };
  }

  it("并发 addTool + addText 首次激活 → cardkit.create 只调用 1 次（单飞保护）", async () => {
    const cardkit = makeCardkit();
    let resolveCreate!: (v: { messageId: string; cardId: string }) => void;
    cardkit.create.mockImplementation(() => new Promise((res) => { resolveCreate = res; }));
    const { card } = setup(cardkit);
    card.addTool("bash"); // 创建线 A：schedulePatch 1500ms 后 patchFull → ensureCreated
    const pAdd = card.addText("你好"); // 创建线 B：立即 patchAnswer → ensureCreated
    await Promise.resolve();
    expect(cardkit.create).toHaveBeenCalledTimes(1);
    // 打字机定时触发线 A 的 patchFull → ensureCreated → 必须复用同一 createPromise
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(cardkit.create).toHaveBeenCalledTimes(1);
    // 释放创建 → 两条线都完成，全程仅 1 次 create
    resolveCreate({ messageId: "m_1", cardId: "c_1" });
    await pAdd;
    expect(cardkit.create).toHaveBeenCalledTimes(1);
  });

  it("cardkit.create 失败 → 单飞清空，降级 inline sendCard 成功且后续不二次 create", async () => {
    const cardkit = makeCardkit();
    let rejectCreate!: (e: Error) => void;
    cardkit.create.mockImplementation(() => new Promise((_, rej) => { rejectCreate = rej; }));
    const { sender, card } = setup(cardkit);
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    const p = card.addText("x");
    await Promise.resolve();
    rejectCreate(new Error("boom"));
    await p;
    // CardKit 失败 → 降级 inline sendCard 建卡
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
    // messageId 已设 → 后续 addTool 不再走 create，直接 updateCard
    card.addTool("bash");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(cardkit.create).toHaveBeenCalledTimes(1);
    expect(sender.updateCard).toHaveBeenCalled();
  });

  it("cardkit.create 成功 → addText 走 cardkit.stream（sequence 递增）", async () => {
    const cardkit = makeCardkit();
    const { sender, card } = setup(cardkit);
    await card.addText("打字机文本");
    expect(cardkit.create).toHaveBeenCalledWith("oc_1", expect.any(String));
    expect(cardkit.stream).toHaveBeenCalledWith("c_1", "打字机文本", 1);
    expect(sender.updateCard).not.toHaveBeenCalled();
  });

  it("cardkit.create 失败 → 降级 inline sendCard", async () => {
    const cardkit = makeCardkit();
    cardkit.create.mockRejectedValue(new Error("create boom"));
    const { sender, logger, card } = setup(cardkit);
    await card.addText("降级路径");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("CardKit 创建失败"));
    expect(sender.sendCard).toHaveBeenCalledTimes(1);
  });

  it("cardkit.stream 抛错 → 一级降级 updateMessage（inline）", async () => {
    const cardkit = makeCardkit();
    cardkit.stream.mockRejectedValue(new Error("stream boom"));
    const { sender, logger, card } = setup(cardkit);
    await card.addText("流式失败");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("CardKit 流式失败"));
    expect(sender.updateCard).toHaveBeenCalled();
  });

  it("cardkit.stream 抛错 → 一级降级 inline 也抛错 → 二级降级 failed + warn", async () => {
    const cardkit = makeCardkit();
    cardkit.stream.mockRejectedValue(new Error("stream boom"));
    const { sender, logger, card } = setup(cardkit);
    sender.updateCard.mockRejectedValue(new Error("inline also fail"));
    await card.addText("双重降级");
    // 一级降级：updateCard 被调（转 inline）
    expect(sender.updateCard).toHaveBeenCalled();
    // 二级降级：failed 置位 + warn
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("回答更新失败"));
    // failed 后 addTool 短路
    card.addTool("bash");
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    expect(sender.updateCard).toHaveBeenCalledTimes(1);
  });
});

describe("StreamingCard（超长压缩降级）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answer 超 28KB → 富卡片超限 → 三级压缩仍超 → 降级单 markdown（无 header）", async () => {
    const sender = makeSender();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    const card = new StreamingCard("oc_1", { sender, onFallback: vi.fn(() => Promise.resolve()) });
    // 先小内容创建卡片（富卡片）
    await card.addText("初始");
    expect(JSON.parse(sender.updateCard.mock.calls[0][1]).header).toBeDefined();
    // answer 巨大 → 压缩无法缩减 answer → 最终降级 markdown
    await card.addText("A".repeat(30_000));
    const lastJson = sender.updateCard.mock.calls.at(-1)[1];
    const parsed = JSON.parse(lastJson);
    // 降级 markdown 无 header（富卡片必有 header）
    expect(parsed.header).toBeUndefined();
    expect(parsed.body.elements[0].tag).toBe("markdown");
  });

  it("大量工具步骤 → 压缩到每类 ≤10 并截断 summary（buildRichCardJson 仍富卡片）", async () => {
    const sender = makeSender();
    sender.sendCard.mockResolvedValue({ data: { message_id: "m_1" } });
    const card = new StreamingCard("oc_1", { sender, onFallback: vi.fn(() => Promise.resolve()) });
    for (let i = 0; i < 40; i++) {
      card.addTool(`tool_${i}`, "x".repeat(500));
    }
    await vi.advanceTimersByTimeAsync(STREAM_INTERVAL_MS + 10);
    const lastJson = sender.updateCard.mock.calls.at(-1)[1];
    // 40 工具被 compactSteps 压缩（每类 ≤10）且截断，未超限 → 仍富卡片
    expect(JSON.parse(lastJson).header).toBeDefined();
  });
});
