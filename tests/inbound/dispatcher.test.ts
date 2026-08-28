import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../src/inbound/dispatcher.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const deps = {
    dedupe: {
      isDuplicate: vi.fn().mockReturnValue(false),
      add: vi.fn().mockReturnValue(true),
    },
    botOpenId: () => "ou_bot",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    handleInbound: vi.fn().mockResolvedValue(undefined),
    ...(overrides as any),
  };
  return deps;
}

function textMsg(id = "om_1", chatId = "ou_1") {
  return {
    message: {
      message_id: id,
      chat_id: chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "你好" }),
    },
    sender: { sender_id: { open_id: "ou_9" } },
  };
}

describe("createDispatcher（入站分发）", () => {
  it("非 message 事件 → 直接忽略", async () => {
    const deps = makeDeps() as any;
    await createDispatcher(deps).handleEvent("card.action.trigger", {});
    expect(deps.dedupe.add).not.toHaveBeenCalled();
  });

  it("无 message_id → 忽略", async () => {
    const deps = makeDeps() as any;
    await createDispatcher(deps).handleEvent("im.message.receive_v1", { message: {} });
    expect(deps.dedupe.add).not.toHaveBeenCalled();
  });

  it("重复消息（isDuplicate true）→ 去重丢弃 warn", async () => {
    const deps = makeDeps({ dedupe: { isDuplicate: vi.fn().mockReturnValue(true), add: vi.fn().mockReturnValue(false) } });
    await createDispatcher(deps).handleEvent("im.message.receive_v1", textMsg());
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("去重丢弃"));
    expect(deps.handleInbound).not.toHaveBeenCalled();
  });

  it("add 返回 false（并发冲突）→ 忽略", async () => {
    const deps = makeDeps({ dedupe: { isDuplicate: vi.fn().mockReturnValue(false), add: vi.fn().mockReturnValue(false) } });
    await createDispatcher(deps).handleEvent("im.message.receive_v1", textMsg());
    expect(deps.handleInbound).not.toHaveBeenCalled();
  });

  it("非 text / 解析失败 → 忽略", async () => {
    const deps = makeDeps() as any;
    await createDispatcher(deps).handleEvent("im.message.receive_v1", textMsg("om_2", "oc_1")); // 有 message_id 但解析失败（无 text？有 text）
    // 实际 text 能解析；构造解析失败：无 content
    await createDispatcher(deps).handleEvent("im.message.receive_v1", {
      message: { message_id: "om_3", chat_id: "ou_1", message_type: "text" },
    });
    expect(deps.handleInbound).toHaveBeenCalledTimes(1);
  });

  it("正常 text 消息 → handleInbound 被调 + 解析结果", async () => {
    const deps = makeDeps() as any;
    await createDispatcher(deps).handleEvent("im.message.receive_v1", textMsg("om_4", "ou_1"));
    expect(deps.dedupe.isDuplicate).toHaveBeenCalledWith("om_4");
    expect(deps.dedupe.add).toHaveBeenCalledWith("om_4");
    expect(deps.handleInbound).toHaveBeenCalledTimes(1);
    const parsed = deps.handleInbound.mock.calls[0][0];
    expect(parsed).toEqual(expect.objectContaining({ messageId: "om_4", chatId: "ou_1", chatType: "p2p", text: "你好" }));
  });

  it("handleInbound 抛错 → error 日志不崩溃", async () => {
    const deps = makeDeps({ handleInbound: vi.fn().mockRejectedValue(new Error("handle boom")) });
    await createDispatcher(deps).handleEvent("im.message.receive_v1", textMsg("om_5"));
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("handleInbound 失败"));
  });
});
