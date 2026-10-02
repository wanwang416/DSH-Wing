import { describe, expect, it, vi } from "vitest";
import { createSender } from "../../src/outbound/sender.js";

function makeClient(overrides: Record<string, unknown> = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: "om_1" });
  const createCardEntity = vi.fn().mockResolvedValue("cc_1");
  const client = { sendMessage, createCardEntity, ...overrides };
  return { client, sendMessage, createCardEntity };
}

function makeSender(client: any, logger: Record<string, ReturnType<typeof vi.fn>>) {
  return createSender({
    getClient: () => client,
    logger,
  } as any);
}

describe("L18：飞书出站补正向日志", () => {
  it("sendText 成功 → info 日志含字节数（旧实现静默 → 红）", async () => {
    const { client } = makeClient();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = makeSender(client, logger);
    await sender.sendText("oc_1", "你好世界");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("飞书出站"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("文本"));
    // 含可核对数量（字节数）
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/\d+/));
  });

  it("sendCard 成功 → info 日志", async () => {
    const { client } = makeClient();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = makeSender(client, logger);
    await sender.sendCard("oc_1", { schema: "2.0", body: {} });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("飞书出站"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("卡片"));
  });

  it("sendText 失败 → 不打正向 info（不许假成功；失败日志由 outbox deliver 层负责）", async () => {
    const { client } = makeClient({ sendMessage: vi.fn().mockRejectedValue(new Error("429")) });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = makeSender(client, logger);
    await expect(sender.sendText("oc_1", "x")).rejects.toThrow("429");
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("飞书出站"));
  });
});
