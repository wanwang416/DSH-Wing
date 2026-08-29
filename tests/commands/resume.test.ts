/**
 * P1-3 /resume 命令测试（恢复上次会话）
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { resumeCommand } from "../../src/commands/resume.js";
import type { ParsedMessage } from "../../src/inbound/parser.js";

const msg = (text: string): ParsedMessage => ({
  messageId: "om_1",
  chatId: "oc_1",
  chatType: "p2p",
  userId: "ou_1",
  text,
  rawText: text,
  mentions: [],
  timestamp: Date.now(),
});

describe("/resume", () => {
  it("有历史会话 → 触发恢复 + 回执 sessionId", async () => {
    const resumeSession = vi.fn(async () => ({ resumed: true, sessionId: "feishu:oc_1:abc:0" }));
    const ctx = { services: { resumeSession } } as BridgeCommandContext;
    const res = await resumeCommand.run(ctx, "", msg("/resume"));
    expect(resumeSession).toHaveBeenCalledWith("oc_1");
    expect(res?.text).toContain("已恢复上次会话");
    expect(res?.text).toContain("feishu:oc_1:abc:0");
  });

  it("无历史会话 → 提示全新开始", async () => {
    const resumeSession = vi.fn(async () => ({ resumed: false }));
    const ctx = { services: { resumeSession } } as BridgeCommandContext;
    const res = await resumeCommand.run(ctx, "", msg("/resume"));
    expect(res?.text).toContain("没有可恢复的历史会话");
  });

  it("服务不可用 → 提示", async () => {
    const ctx = {} as BridgeCommandContext;
    const res = await resumeCommand.run(ctx, "", msg("/resume"));
    expect(res?.text).toContain("会话服务不可用");
  });
});
