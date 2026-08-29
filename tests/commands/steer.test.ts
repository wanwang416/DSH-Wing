/**
 * P1-3 /steer 命令测试（手动注入消息）
 */
import { describe, expect, it, vi } from "vitest";
import type { BridgeCommandContext } from "../../src/commands/types.js";
import { steerCommand } from "../../src/commands/steer.js";
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

describe("/steer", () => {
  it("带文本 + running → steered（打断生效）", async () => {
    const steer = vi.fn(async () => "steered" as const);
    const ctx = { services: { steer } } as BridgeCommandContext;
    const res = await steerCommand.run(ctx, "换个思路做", msg("/steer 换个思路做"));
    expect(steer).toHaveBeenCalledWith("oc_1", "换个思路做");
    expect(res?.text).toContain("已注入");
  });

  it("带文本 + idle → queued（排队下轮）", async () => {
    const steer = vi.fn(async () => "queued" as const);
    const ctx = { services: { steer } } as BridgeCommandContext;
    const res = await steerCommand.run(ctx, "先记着这个", msg("/steer 先记着这个"));
    expect(res?.text).toContain("排队下轮");
  });

  it("无 agent → 提示先建会话", async () => {
    const steer = vi.fn(async () => "no-agent" as const);
    const ctx = { services: { steer } } as BridgeCommandContext;
    const res = await steerCommand.run(ctx, "注入下", msg("/steer 注入下"));
    expect(res?.text).toContain("请先发一条普通消息");
  });

  it("无文本 → 用法说明", async () => {
    const ctx = {} as BridgeCommandContext;
    const res = await steerCommand.run(ctx, "", msg("/steer"));
    expect(res?.text).toContain("用法");
  });

  it("服务不可用 → 提示", async () => {
    const ctx = { services: {} } as BridgeCommandContext;
    const res = await steerCommand.run(ctx, "注入", msg("/steer 注入"));
    expect(res?.text).toContain("注入服务不可用");
  });
});
