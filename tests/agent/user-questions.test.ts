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
  it("单选：每选项一个按钮，behaviors 回调 action=answer:qid:idx，header 用 plain_text", () => {
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
    //   按钮平铺在 body.elements 尾部；回调必须用 behaviors[{type:'callback',value}]
    const elements = card.body.elements as Array<Record<string, unknown>>;
    const buttons = elements.filter((e) => e.tag === "button");
    // ★ M4 终审风险1：单选有选项时，底部加「自由输入」按钮 → 共3个按钮（2选项+1自由输入）
    expect(buttons).toHaveLength(3);
    expect(buttons[0].behaviors[0].value.action).toBe("answer:q1:0");
    expect(buttons[1].behaviors[0].value.action).toBe("answer:q1:1");
    expect(buttons[0].behaviors[0].value.label).toBe("A");
    // 自由输入按钮：action=free_text:qid，type=primary
    expect(buttons[2].behaviors[0].value.action).toBe("free_text:q1");
    expect(buttons[2].type).toBe("primary");
    expect(card.actions).toBeUndefined();
  });

  it("多选：无按钮，编号文本列表，note 提示已改 markdown（★ M4-R4 现象 2）", () => {
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
    // ★ M4-R4 修复（现象 2）：schema 2.0 不支持 note 组件（200861 400）→ 全卡无 note，改 markdown 提示
    const tags = (card.body.elements as Array<Record<string, unknown>>).map((e) => e.tag);
    expect(tags).not.toContain("note");
    expect(card.body.elements[2].tag).toBe("markdown");
    expect(card.body.elements[2].content).toContain("请回复数字");
  });

  it("卡片不含 form/input（★ M4-R4 灾难回退：im 直发通道 form 提交按钮三连败 300123/200621/300123）", () => {
    const card = buildQuestionCard({ id: "q1", question: "选方案？", options: [{ label: "A" }] }) as any;
    const elements = card.body.elements as Array<Record<string, unknown>>;
    const tags = elements.map((e) => e.tag);
    // form 在 im.message 直发通道无法声明提交按钮（三版报错见 Obsidian 灾难记录），整体移除
    expect(tags).not.toContain("form");
    expect(tags).not.toContain("input");
    // 末位元素回归为选项按钮
    expect(elements[elements.length - 1].tag).toBe("button");
  });

  it("多选卡片无 note 无 form（★ M4-R4 现象 2 修复保留 + 灾难回退）", () => {
    const card = buildQuestionCard({ id: "q2", question: "多选？", multiSelect: true, options: [{ label: "X" }] }) as any;
    const elements = card.body.elements as Array<Record<string, unknown>>;
    const tags = elements.map((e) => e.tag);
    expect(tags).not.toContain("note");
    expect(tags).not.toContain("form");
  });

  it("无选项卡片：无 note 无 form（★ M4-R4 现象 2 修复保留 + 灾难回退）", () => {
    const card = buildQuestionCard({ id: "q3", question: "自由回答？" }) as any;
    const elements = card.body.elements as Array<Record<string, unknown>>;
    const tags = elements.map((e) => e.tag);
    expect(tags).not.toContain("note");
    expect(tags).not.toContain("form");
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

  it("超时（timeoutMs 到期）→ ASK_ABORTED + warn 留痕（★ R5.1：此前静默删 pending）", async () => {
    const { bridge, logger } = makeBridge({ timeoutMs: 10 });
    const ctx = makeCtx();
    bridge.patchAsk(ctx);
    const p = (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q", question: "?" }],
    });
    await expect(p).rejects.toMatchObject({ code: ASK_ABORTED });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("提问待答窗口已超时"));
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

  it("400 盲降级修复：日志含飞书拒绝响应体 code/msg（axios 错误）", async () => {
    const { bridge, sendCard, sendText, logger } = makeBridge();
    sendCard.mockRejectedValue({
      message: "Request failed with status code 400",
      response: { status: 400, data: { code: 240001, msg: "参数错误: body 校验失败" } },
    });
    const ctx = makeCtx();
    bridge.patchAsk(ctx);
    void (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q3_kpi", question: "当前门店数量？", options: [{ label: "1-5" }, { label: "6-20" }, { label: "20+" }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    // 降级文本仍走（降级路径保留）
    expect(sendText).toHaveBeenCalled();
    // ★ 验收：400 时日志含响应体 code/msg，降级可解释
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("code=240001"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("msg=参数错误"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("(400)"));
  });

  it("非 axios 错误 → 日志仍含 err.message（可解释）", async () => {
    const { bridge, sendCard, logger } = makeBridge();
    sendCard.mockRejectedValue(new Error("network down"));
    const ctx = makeCtx();
    bridge.patchAsk(ctx);
    void (ctx.userQuestions as any).ask({
      agent: { id: "feishu:oc_1:123:0" },
      questions: [{ id: "q", question: "选？", options: [{ label: "A" }] }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("network down"));
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

  it("onCardAction 非 answer: 前缀（feedback 已随 form 移除）→ 不消费", () => {
    const { bridge } = makeBridge();
    expect(bridge.onCardAction("oc_1", "feedback:q1")).toBe(false);
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
