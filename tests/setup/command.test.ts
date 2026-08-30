/**
 * M4.2 /setup 命令测试（注册制命令层：调 services.setup.start → 渲染二维码消息）
 */
import { describe, expect, it, vi } from "vitest";
import { setupCommand } from "../../src/commands/setup.js";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import type { ParsedMessage } from "../../src/inbound/parser.js";

const msg: ParsedMessage = {
  messageId: "om_m1",
  chatId: "oc_chat1",
  chatType: "p2p",
  userId: "ou_user1",
  text: "/setup",
  rawText: "/setup",
  mentions: [],
  parentId: undefined,
  timestamp: 1,
};

describe("setupCommand", () => {
  it("扫码链接就绪 → 消息含链接 + 引导文案", async () => {
    const start = vi.fn().mockResolvedValue({ url: "https://qr.example/xyz", expireIn: 600 });
    const deps: BridgeCommandContext = { services: { setup: { start } } };
    const res = await setupCommand.run(deps, "", msg);
    expect(res?.text).toContain("扫码创建飞书机器人");
    expect(res?.text).toContain("https://qr.example/xyz");
    expect(res?.text).toContain("600 秒后过期");
    expect(start).toHaveBeenCalledWith("oc_chat1");
  });

  it("start 未就绪（undefined）→ 提示稍后重试", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const deps: BridgeCommandContext = { services: { setup: { start } } };
    const res = await setupCommand.run(deps, "", msg);
    expect(res?.text).toContain("未在 30 秒内就绪");
  });

  it("setup 服务缺失 → 提示不可用", async () => {
    const deps: BridgeCommandContext = { services: {} };
    const res = await setupCommand.run(deps, "", msg);
    expect(res?.text).toContain("服务不可用");
  });
});
