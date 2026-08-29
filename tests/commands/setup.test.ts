/**
 * P1-3 /setup 命令测试（占位回执能力清单）
 */
import { describe, expect, it } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { setupCommand } from "../../src/commands/setup.js";
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

describe("/setup", () => {
  it("回执能力清单（不依赖 services）", async () => {
    const ctx = {} as BridgeCommandContext;
    const res = await setupCommand.run(ctx, "", msg("/setup"));
    expect(res?.text).toContain("能力清单");
    expect(res?.text).toContain("/mode");
    expect(res?.text).toContain("审批卡");
    expect(res?.text).toContain("意图桥");
  });
});
