import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createSender } from "../../src/outbound/sender.js";

function makeClient(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: "om_1" });
  const createCardEntity = vi.fn().mockResolvedValue("cc_1");
  const streamMessageContent = vi.fn().mockResolvedValue({});
  const addReaction = vi.fn().mockResolvedValue({});
  const updateMessage = vi.fn().mockResolvedValue({});
  const client = {
    sendMessage,
    createCardEntity,
    streamMessageContent,
    addReaction,
    updateMessage,
    ...overrides,
  };
  return { client, sendMessage, createCardEntity, streamMessageContent, addReaction, updateMessage };
}

function makeSender(client: any, overrides: Record<string, unknown> = {}) {
  return createSender({
    getClient: () => client,
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSender 基础发送", () => {
  it("sendText oc_ → receive_id_type=chat_id", async () => {
    const { client, sendMessage } = makeClient();
    const sender = makeSender(client);
    await sender.sendText("oc_1", "你好");
    expect(sendMessage).toHaveBeenCalledWith({
      receive_id_type: "chat_id",
      params: { receive_id: "oc_1", msg_type: "text", content: JSON.stringify({ text: "你好" }) },
    });
  });

  it("sendText ou_ → receive_id_type=open_id", async () => {
    const { client, sendMessage } = makeClient();
    const sender = makeSender(client);
    await sender.sendText("ou_u1", "hi");
    expect(sendMessage.mock.calls[0][0].receive_id_type).toBe("open_id");
  });

  it("sendCard → interactive", async () => {
    const { client, sendMessage } = makeClient();
    const sender = makeSender(client);
    await sender.sendCard("oc_1", { schema: "2.0" });
    expect(sendMessage.mock.calls[0][0].params.msg_type).toBe("interactive");
  });

  it("addReaction / updateCard / streamCardContent 各走对应 client 方法", async () => {
    const { client, addReaction, updateMessage, streamMessageContent } = makeClient();
    const sender = makeSender(client);
    await sender.addReaction("om_1", "THUMBSUP");
    expect(addReaction).toHaveBeenCalledWith({ message_id: "om_1", emoji_type: "THUMBSUP" });
    await sender.updateCard("om_1", '{"schema":"2.0"}');
    expect(updateMessage).toHaveBeenCalledWith({ message_id: "om_1", content: '{"schema":"2.0"}' });
    await sender.streamCardContent("cc_1", "内容", 1);
    expect(streamMessageContent).toHaveBeenCalledWith("cc_1", "内容", 1);
  });

  it("client 未就绪 → 抛错", async () => {
    const sender = makeSender(undefined);
    await expect(sender.sendText("oc_1", "hi")).rejects.toThrow("未就绪");
  });

  it("CardKit 缺 createCardEntity → 抛错", async () => {
    const { client } = makeClient({ createCardEntity: undefined });
    const sender = makeSender(client);
    await expect(sender.sendCardKitCard("oc_1", '{}')).rejects.toThrow("未就绪");
  });
});

describe("sendCardKitCard（M3 CardKit 两步）", () => {
  it("createCardEntity → sendMessage 引用 card_id → 返回 messageId/cardId", async () => {
    const { client, createCardEntity, sendMessage } = makeClient();
    const sender = makeSender(client);
    const res = await sender.sendCardKitCard("oc_1", '{"schema":"2.0"}');
    expect(createCardEntity).toHaveBeenCalledWith('{"schema":"2.0"}');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const arg = sendMessage.mock.calls[0][0] as any;
    expect(JSON.parse(arg.params.content)).toEqual({ type: "card", data: { card_id: "cc_1" } });
    expect(res).toEqual({ messageId: "om_1", cardId: "cc_1" });
  });

  it("SDK 嵌套返回 {data:{message_id}} 也能提取 message_id", async () => {
    const { client, sendMessage } = makeClient();
    sendMessage.mockResolvedValue({ data: { message_id: "om_nested" } });
    const sender = makeSender(client);
    const res = await sender.sendCardKitCard("oc_1", '{}');
    expect(res.messageId).toBe("om_nested");
  });

  it("sendMessage 未返回 message_id → 抛错", async () => {
    const { client, sendMessage } = makeClient();
    sendMessage.mockResolvedValue({});
    const sender = makeSender(client);
    await expect(sender.sendCardKitCard("oc_1", '{}')).rejects.toThrow("未返回 message_id");
  });
});

describe("withRetry 重试（退避）", () => {
  it("普通错误退避 500ms → 第二次成功", async () => {
    const { client, sendMessage } = makeClient();
    sendMessage.mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce({ message_id: "om_2" });
    const sender = makeSender(client);
    const p = sender.sendText("oc_1", "hi");
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("230020 限频 → 退避 2000ms（加大）", async () => {
    const { client, sendMessage } = makeClient();
    sendMessage.mockRejectedValueOnce(new Error("Update the single messages too frequently (230020)"))
      .mockResolvedValueOnce({ message_id: "om_3" });
    const sender = makeSender(client);
    const p = sender.sendText("oc_1", "hi");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("maxRetries 全失败 → 抛最后错误", async () => {
    const { client, sendMessage } = makeClient();
    sendMessage.mockRejectedValue(new Error("always"));
    const sender = makeSender(client, { maxRetries: 3 });
    // 预挂 rejection handler，避免 fake timers 推进期间 unhandled rejection
    const checked = sender
      .sendText("oc_1", "hi")
      .then(
        () => { throw new Error("应当失败"); },
        (e: unknown) => e,
      );
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await checked;
    expect((err as Error).message).toContain("always");
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it("自定义 maxRetries=1 → 单次尝试直接失败", async () => {
    const { client, sendMessage } = makeClient();
    sendMessage.mockRejectedValue(new Error("once"));
    const sender = makeSender(client, { maxRetries: 1 });
    await expect(sender.sendText("oc_1", "hi")).rejects.toThrow("once");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
