import { describe, expect, it, vi } from "vitest";
import { createWecomSender, splitMessageByBytes } from "../../src/outbound/wecom-sender.js";

function makeClient(overrides: Record<string, unknown> = {}) {
  const replyFrameFor = vi.fn().mockReturnValue(undefined);
  const reply = vi.fn().mockResolvedValue({});
  const replyStream = vi.fn().mockResolvedValue({});
  const sendMarkdown = vi.fn().mockResolvedValue({});
  const sendMessage = vi.fn().mockResolvedValue({});
  const replyWelcome = vi.fn().mockResolvedValue({});
  const isConnected = vi.fn().mockReturnValue(true);
  return {
    client: { replyFrameFor, reply, replyStream, sendMarkdown, sendMessage, replyWelcome, isConnected, ...overrides },
    replyFrameFor,
    reply,
    replyStream,
    sendMarkdown,
    sendMessage,
    replyWelcome,
  };
}

function makeSender(client: any) {
  return createWecomSender({ getClient: () => client, logger: { warn: vi.fn(), error: vi.fn() } });
}

const FRAME = { headers: { req_id: "r1" }, body: { msgid: "m1" } } as any;

describe("splitMessageByBytes", () => {
  it("未超限 → 原样单段", () => {
    expect(splitMessageByBytes("你好", 4000)).toEqual(["你好"]);
  });
  it("超限 → 按字节切分，不切断多字节字符", () => {
    const parts = splitMessageByBytes("你".repeat(100), 30);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(30);
    }
    expect(parts.join("")).toBe("你".repeat(100));
  });
  it("字节上限边界：中文 4000 字节 = 1333 字符余 1 字节", () => {
    const text = "中".repeat(1334);
    const parts = splitMessageByBytes(text, 4000);
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBe(1333);
  });
});

describe("createWecomSender：帧回复优先", () => {
  it("sendText：有回调帧 → reply（text 消息体）", async () => {
    const m = makeClient();
    m.replyFrameFor.mockReturnValue(FRAME);
    const sender = makeSender(m.client);
    await sender.sendText("u1", "你好");
    expect(m.reply).toHaveBeenCalledWith(FRAME, expect.objectContaining({ msgtype: "text", text: { content: "你好" } }));
    expect(m.sendMarkdown).not.toHaveBeenCalled();
  });

  it("sendText：无回调帧 → sendMarkdown 主动推送", async () => {
    const m = makeClient();
    const sender = makeSender(m.client);
    await sender.sendText("u1", "你好");
    expect(m.reply).not.toHaveBeenCalled();
    expect(m.sendMarkdown).toHaveBeenCalled();
  });

  it("sendMarkdown：超 4000 字节 → 分片逐段发送", async () => {
    const m = makeClient();
    const sender = makeSender(m.client);
    await sender.sendMarkdown("u1", "中".repeat(8000));
    expect(m.sendMarkdown.mock.calls.length).toBeGreaterThan(1);
    for (const call of m.sendMarkdown.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ msgtype: "markdown" }));
    }
  });

  it("sendWelcome：replyWelcome + text 消息体", async () => {
    const m = makeClient();
    const sender = makeSender(m.client);
    await sender.sendWelcome(FRAME, "欢迎");
    expect(m.replyWelcome).toHaveBeenCalledWith(FRAME, expect.objectContaining({ msgtype: "text", text: { content: "欢迎" } }));
  });
});

describe("createWecomSender：流式", () => {
  it("beginStream：有帧 → replyStream(finish=false) + 返回 handle", async () => {
    const m = makeClient();
    m.replyFrameFor.mockReturnValue(FRAME);
    const sender = makeSender(m.client);
    const handle = await sender.beginStream("u1", "开头");
    expect(handle).toBeTruthy();
    expect(m.replyStream).toHaveBeenCalledWith(FRAME, handle!.streamId, "开头", false);
  });

  it("beginStream：无帧 → 降级 sendMarkdown 终稿，返回 undefined", async () => {
    const m = makeClient();
    const sender = makeSender(m.client);
    const handle = await sender.beginStream("u1", "终稿");
    expect(handle).toBeUndefined();
    expect(m.sendMarkdown).toHaveBeenCalled();
    expect(m.replyStream).not.toHaveBeenCalled();
  });

  it("stream(finish=true) → 结束流式并清理登记", async () => {
    const m = makeClient();
    m.replyFrameFor.mockReturnValue(FRAME);
    const sender = makeSender(m.client);
    const handle = await sender.beginStream("u1", "开头");
    await sender.stream(handle, "完整回答", true);
    expect(m.replyStream).toHaveBeenLastCalledWith(FRAME, handle!.streamId, "完整回答", true);
    expect(sender.hasActiveStream("u1")).toBe(false);
  });

  it("stream(finish=false) → 刷新且保留登记", async () => {
    const m = makeClient();
    m.replyFrameFor.mockReturnValue(FRAME);
    const sender = makeSender(m.client);
    const handle = await sender.beginStream("u1", "开头");
    await sender.stream(handle, "中间内容", false);
    expect(sender.hasActiveStream("u1")).toBe(true);
  });

  it("stream：超 19000 字节 → 分片发送", async () => {
    const m = makeClient();
    m.replyFrameFor.mockReturnValue(FRAME);
    const sender = makeSender(m.client);
    const handle = await sender.beginStream("u1", "a");
    await sender.stream(handle, "中".repeat(20_000), true);
    expect(m.replyStream.mock.calls.length).toBeGreaterThan(1);
  });

  it("stream：handle 为 undefined（已降级）→ 静默返回", async () => {
    const m = makeClient();
    const sender = makeSender(m.client);
    await expect(sender.stream(undefined, "x", true)).resolves.toBeUndefined();
  });

  it("sendText：客户端未就绪 → 抛错", async () => {
    const sender = createWecomSender({ getClient: () => undefined, logger: { warn: vi.fn(), error: vi.fn() } });
    await expect(sender.sendText("u1", "hi")).rejects.toThrow("未就绪");
  });
});
