import { describe, expect, it, vi } from "vitest";
import { createEventHandler } from "../../src/inbound/event-handler.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const agent = { sessionId: "s1", cancel: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) };
  const deps = {
    outbox: { enqueue: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mapper: {
      get: vi.fn(),
      getOrCreateAgent: vi.fn().mockResolvedValue(agent),
    },
    userQuestionBridge: { onCardAction: vi.fn().mockReturnValue(false) },
    experience: { handleUserMessage: vi.fn().mockReturnValue("steered") },
    ...(overrides as any),
  };
  return { deps, agent };
}

describe("createEventHandler（M4 提取重构）", () => {
  it("bot_added：有 chat_id → 入队欢迎消息", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("im.chat.member.bot.added_v1", { chat_id: "oc_1" });
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "oc_1", kind: "text", payload: expect.objectContaining({ text: "👋 我是 dsh-wing，随时待命！" }) })
    );
  });

  it("bot_added：无 chat_id → 不 enqueue", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("im.chat.member.bot.added_v1", {});
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it("p2p_entered：有 operator open_id → 入队 P2P 欢迎", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("im.chat.access_event.bot_p2p_chat_entered_v1", { operator: { operator_id: { open_id: "ou_1" } } });
    expect(deps.outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ chatId: "ou_1", payload: expect.objectContaining({ text: "👋 你好！我是 dsh-wing，直接说需求就行。" }) }));
  });

  it("p2p_entered：无 open_id → 不 enqueue", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("im.chat.access_event.bot_p2p_chat_entered_v1", { operator: {} });
    expect(deps.outbox.enqueue).not.toHaveBeenCalled();
  });

  it("card.action：取不到 chatId → warn 不崩溃", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("card.action.trigger", { action: { value: { action: "answer:1" } } });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("取不到 chatId"));
  });

  it("card.action：actionName 非 answer: 前缀 → warn", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("card.action.trigger", { context: { open_chat_id: "oc_1" }, action: { value: { action: "other" } } });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("actionName 不匹配 answer: 前缀"));
  });

  it("card.action：提问桥已消费（onCardAction true）→ 不 steer", async () => {
    const { deps } = makeDeps({ userQuestionBridge: { onCardAction: vi.fn().mockReturnValue(true) } });
    const onEvent = createEventHandler(deps as any);
    onEvent("card.action.trigger", { context: { open_chat_id: "oc_1" }, action: { value: { action: "answer:1", label: "选A" } } });
    await vi.waitFor(() => {});
    expect(deps.mapper.getOrCreateAgent).not.toHaveBeenCalled();
  });

  it("card.action：无 value.label → warn", async () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("card.action.trigger", { context: { open_chat_id: "oc_1" }, action: { value: { action: "answer:1" } } });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("value 无 label"));
    expect(deps.mapper.getOrCreateAgent).not.toHaveBeenCalled();
  });

  it("card.action：完整路径 → 取 agent + steer 注入 label", async () => {
    const { deps, agent } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("card.action.trigger", {
      context: { open_chat_id: "oc_1" },
      action: { value: { action: "answer:q1", questionId: "q1", optionId: "o1", label: "选B" } },
    });
    await vi.waitFor(() => expect(deps.mapper.getOrCreateAgent).toHaveBeenCalledWith("oc_1"));
    await vi.waitFor(() => expect(deps.experience.handleUserMessage).toHaveBeenCalled());
    expect(deps.experience.handleUserMessage).toHaveBeenCalledWith("oc_1", agent, "选B", expect.any(Object));
  });

  it("card.action：event 包裹兼容路径（event.action.value + event.action.name）", async () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("card.action.trigger", {
      event: { open_chat_id: "oc_9", action: { name: "answer:legacy", value: { label: "老格式" } } },
    });
    await vi.waitFor(() => expect(deps.experience.handleUserMessage).toHaveBeenCalled());
    expect(deps.experience.handleUserMessage).toHaveBeenCalledWith("oc_9", expect.anything(), "老格式", expect.any(Object));
  });

  it("card.action：getOrCreateAgent 抛错 → warn 处理失败", async () => {
    const { deps } = makeDeps({
      mapper: { get: vi.fn(), getOrCreateAgent: vi.fn().mockRejectedValue(new Error("agent boom")) },
    });
    const onEvent = createEventHandler(deps as any);
    onEvent("card.action.trigger", { context: { open_chat_id: "oc_1" }, action: { value: { action: "answer:1", label: "x" } } });
    await vi.waitFor(() => expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("处理失败")));
  });

  it("recalled：取不到 chatId → warn 跳过", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("im.message.recalled_v1", {});
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("取不到 chatId"));
    expect(deps.mapper.get).not.toHaveBeenCalled();
  });

  it("recalled：有进行中 agent → cancel({kind: recalled})", () => {
    const { deps, agent } = makeDeps();
    deps.mapper.get.mockReturnValue(agent);
    const onEvent = createEventHandler(deps as any);
    onEvent("im.message.recalled_v1", { message: { chat_id: "oc_1", message_id: "om_1" } });
    expect(deps.mapper.get).toHaveBeenCalledWith("oc_1");
    expect(agent.cancel).toHaveBeenCalledWith({ kind: "recalled" });
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("已停止 agent 生成"));
  });

  it("recalled：chat_id 顶层字段 + 无 agent → info 跳过", () => {
    const { deps } = makeDeps();
    deps.mapper.get.mockReturnValue(undefined);
    const onEvent = createEventHandler(deps as any);
    onEvent("im.message.recalled_v1", { chat_id: "oc_1", message_id: "om_2" });
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("无进行中 agent，跳过"));
    expect(deps.mapper.get).toHaveBeenCalledWith("oc_1");
  });

  it("recalled：cancel 抛错 → warn 停止失败", () => {
    const { deps } = makeDeps();
    const agent = { cancel: vi.fn(() => { throw new Error("cancel boom"); }) };
    deps.mapper.get.mockReturnValue(agent);
    const onEvent = createEventHandler(deps as any);
    onEvent("im.message.recalled_v1", { message: { chat_id: "oc_1", message_id: "om_3" } });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("停止 agent 失败"));
  });

  it("default：reaction 事件 → info 日志响应", () => {
    const { deps } = makeDeps();
    const onEvent = createEventHandler(deps as any);
    onEvent("im.message.reaction.created_v1", { a: 1 });
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining("事件 im.message.reaction.created_v1 收到"));
  });
});
