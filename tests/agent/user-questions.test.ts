import { describe, expect, it, vi } from "vitest";
import {
  createUserQuestionBridge,
  buildQuestionCard,
  buildAnsweredCard,
  buildQuestionText,
  resolveTextAnswer,
  messageIdOfRes,
  ASK_ABORTED,
} from "../../src/agent/user-questions.js";

function makeBridge(opts: { timeoutMs?: number } = {}) {
  const sendCard = vi.fn().mockResolvedValue({ data: { message_id: "om_1" } });
  const updateCard = vi.fn().mockResolvedValue({});
  const sendText = vi.fn().mockResolvedValue({});
  const logger = { warn: vi.fn(), info: vi.fn() };
  const bridge = createUserQuestionBridge({
    sendCard,
    updateCard,
    sendText,
    messageIdOf: messageIdOfRes,
    timeoutMs: opts.timeoutMs ?? 30_000,
    logger: logger as never,
  });
  return { bridge, sendCard, updateCard, sendText, logger };
}

/** 模拟 DSH ctx：patchAsk 需要的 userQuestions.ask */
function makeCtx(originalAsk = vi.fn().mockResolvedValue({ answers: [] })) {
  return { userQuestions: { ask: originalAsk } };
}

describe("提问卡片构建（对齐基底 sendAskQuestionPrompt / renderCardMap）", () => {
  it("单选：每选项一个按钮，name=answer:qid:idx，header 用 plain_text", () => {
    const card = buildQuestionCard({
      id: "q1",
      question: "选方案？",
      header: "确认",
      options: [{ label: "A" }, { label: "B" }],
    }) as any;
    expect(card.schema).toBe("2.0");
    expect(card.header.title.tag).toBe("plain_text");
    expect(card.header.title.content).toBe("❓ 确认");
    expect(card.header.template).toBe("blue");
    // ★ M3 真机修复：schema 2.0 无顶层 actions、不支持 {tag:"action"} 组件（飞书 200861），
    //   按钮平铺在 body.elements 尾部
    const elements = card.body.elements as Array<Record<string, unknown>>;
    const buttons = elements.filter((e) => e.tag === "button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].name).toBe("answer:q1:0");
    expect(buttons[1].name).toBe("answer:q1:1");
    expect(JSON.parse(buttons[0].value as string).label).toBe("A");
    expect(card.actions).toBeUndefined();
  });

  it("多选：无按钮，编号文本列表（对齐基底多选分支）", () => {
    const card = buildQuestionCard({
      id: "q2",
      question: "多选？",
      multiSelect: true,
      options: [{ label: "X" }, { label: "Y" }],
    }) as any;
    expect(card.actions).toBeUndefined();
    const md = card.body.elements[1].content;
    expect(md).toContain("1. **X**");
    expect(md).toContain("2. **Y**");
    expect(card.body.elements[2].tag).toBe("note");
  });

  it("✅ 已选择卡片：header 变 green，含 → 答案", () => {
    const card = buildAnsweredCard({ id: "q1", question: "选方案？" }, "B") as any;
    expect(card.header.template).toBe("green");
    expect(card.header.title.content).toBe("✅ B");
    expect(card.body.elements[0].content).toContain("→ **B**");
  });

  it("messageIdOfRes 兼容多种返回", () => {
    expect(messageIdOfRes({ data: { message_id: "m1" } })).toBe("m1");
    expect(messageIdOfRes({ message_id: "m2" })).toBe("m2");
    expect(messageIdOfRes({ data: { item: { message_id: "m3" } } })).toBe("m3");
    expect(messageIdOfRes(undefined)).toBeUndefined();
  });
});

describe("文本回复解析（对齐基底 resolveAskQuestionAnswer）", () => {
  const q = { id: "q", question: "?", options: [{ label: "甲" }, { label: "乙" }, { label: "丙" }] };

  it("单选数字", () => expect(resolveTextAnswer(q, "2").selected).toEqual(["乙"]));
  it("多选逗号分隔", () => expect(resolveTextAnswer({ ...q, multiSelect: true }, "1,3").selected).toEqual(["甲", "丙"]));
  it("全角逗号 + 空格", () => expect(resolveTextAnswer({ ...q, multiSelect: true }, "1， 2").selected).toEqual(["甲", "乙"]));
  it("选项文字直接匹配", () => expect(resolveTextAnswer(q, "乙").selected).toEqual(["乙"]));
  it("非法输入 → 空", () => expect(resolveTextAnswer(q, "zzz").selected).toEqual([]));
  it("无预设选项 → 自由文本 custom", () => expect(resolveTextAnswer({ id: "q", question: "?" }, "任何回复").custom).toBe("任何回复"));
});

describe("bridge 端到端（A1/A2/A3）", () => {
  it("onCardAction 按钮 → resolve 答案 + 更新卡片 ✅", async () => {
    const { bridge, updateCard } = makeBridge();
    const ctx = makeCtx();
    const restore = bridge.patchAsk(ctx);
    const promise = (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q1", question: "选方案？", options: [{ label: "A" }, { label: "B" }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    const consumed = bridge.onCardAction("oc_1", "answer:q1:1");
    expect(consumed).toBe(true);
    await expect(promise).resolves.toEqual({ answers: [{ id: "q1", selected: ["B"] }] });
    expect(updateCard).toHaveBeenCalled();
    restore();
  });

  it("超时 30s → ASK_ABORTED，agent 不卡死（A2）", async () => {
    const { bridge } = makeBridge({ timeoutMs: 10 });
    const ctx = makeCtx();
    bridge.patchAsk(ctx);
    const p = (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q", question: "?" }],
    });
    await expect(p).rejects.toMatchObject({ code: ASK_ABORTED });
  });

  it("Web agent（非 feishu: 前缀）→ 转发原 ask（Web UI 不受影响）", async () => {
    const { bridge } = makeBridge();
    const originalAsk = vi.fn().mockResolvedValue({ answers: [{ id: "x", selected: ["y"] }] });
    const ctx = makeCtx(originalAsk);
    bridge.patchAsk(ctx);
    const res = await (ctx.userQuestions as any).ask({ agent: { id: "web-session-1" }, questions: [{ id: "x", question: "?" }] });
    expect(originalAsk).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ answers: [{ id: "x", selected: ["y"] }] });
  });

  it("降级：卡片发送失败 → 文本提问（A3）", async () => {
    const { bridge, sendCard, sendText } = makeBridge();
    sendCard.mockRejectedValue(new Error("network"));
    const ctx = makeCtx();
    bridge.patchAsk(ctx);
    void (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q", question: "选？", options: [{ label: "A" }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendText).toHaveBeenCalledWith("oc_1", expect.stringContaining("❓"));
  });

  it("多选文本回复 → resolve 多个 label", async () => {
    const { bridge } = makeBridge();
    const ctx = makeCtx();
    bridge.patchAsk(ctx);
    const p = (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q", question: "多选", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.onTextInbound("oc_1", "1,2")).toBe(true);
    await expect(p).resolves.toEqual({ answers: [{ id: "q", selected: ["X", "Y"] }] });
  });

  it("非法文本回复 → 提示重试，消费该消息不污染 agent", async () => {
    const { bridge, sendText } = makeBridge();
    const ctx = makeCtx();
    bridge.patchAsk(ctx);
    void (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q", question: "选？", options: [{ label: "A" }, { label: "B" }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.onTextInbound("oc_1", "zzz")).toBe(true);
    expect(sendText).toHaveBeenCalledWith("oc_1", expect.stringContaining("⚠️"));
  });
});

describe("降级文本构建", () => {
  it("buildQuestionText 含编号选项与提示", () => {
    const t = buildQuestionText({ id: "q", question: "选？", multiSelect: true, options: [{ label: "A" }, { label: "B" }] });
    expect(t).toContain("❓ 选？");
    expect(t).toContain("1. A");
    expect(t).toContain("请回复数字");
  });
});
