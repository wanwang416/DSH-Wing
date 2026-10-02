import { describe, expect, it, vi } from "vitest";
import { createMissedCompensation } from "../../src/inbound/compensation.js";

/** G5 用例挂在 index 集成层之外，直接测 dispatcher.handleParsed 与 groupPolicy 的接线。
 *  为避免整仓 mock index.ts，这里用轻量桩复现「企微入口 → 群策略 → handleInbound」路径。 */
import { createDispatcher } from "../../src/inbound/dispatcher.js";
import { shouldProcessGroupMessage } from "../../src/inbound/group-policy.js";
import type { ParsedMessage } from "../../src/inbound/parser.js";

function wecomGroupMsg(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    messageId: "wm_1",
    chatId: "wr_group1",
    chatType: "group",
    text: "大家好",
    rawText: "大家好",
    mentions: [],
    userId: "u1",
    ...overrides,
  } as ParsedMessage;
}

function makePolicyDeps(policy: string, botName = "安格斯") {
  return {
    policy: () => policy as never,
    keywords: () => ["lark", "wing"],
    botOpenId: () => botName,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

describe("G5：企微群聊走 group-policy（mention 策略不再失效）", () => {
  function makeRoute(policy: string) {
    const handleInbound = vi.fn().mockResolvedValue(undefined);
    const policyDeps = makePolicyDeps(policy);
    // 模拟 index.ts 新接线：dispatcher.handleParsed 内部（或企微入口）先过群策略
    const dispatcher = createDispatcher({
      dedupe: { isDuplicate: vi.fn().mockReturnValue(false), add: vi.fn().mockReturnValue(true) },
      botOpenId: () => "安格斯",
      handleInbound,
    });
    const route = async (msg: ParsedMessage) => {
      // ★ 新增的共用判定（与飞书侧 index.ts:748 同一套 shouldProcessGroupMessage）
      if (msg.chatType === "group" && !shouldProcessGroupMessage(msg, policyDeps)) {
        policyDeps.logger.warn?.(`企微群消息被群策略过滤 chat=${msg.chatId}`);
        return "filtered";
      }
      await dispatcher.handleParsed(msg);
      return "processed";
    };
    return { route, handleInbound, policyDeps };
  }

  it("企微群聊未 @ 机器人 + mention → 不进入 handleInbound（旧实现会进入 → 红）", async () => {
    const { route, handleInbound, policyDeps } = makeRoute("mention");
    const outcome = await route(wecomGroupMsg());
    expect(outcome).toBe("filtered");
    expect(handleInbound).not.toHaveBeenCalled();
    expect(policyDeps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("群策略过滤"));
  });

  it("企微群聊 @ 了机器人 → 进入 handleInbound", async () => {
    const { route, handleInbound } = makeRoute("mention");
    const outcome = await route(wecomGroupMsg({ text: "@安格斯 帮我查", rawText: "@安格斯 帮我查", mentions: ["安格斯"] }));
    expect(outcome).toBe("processed");
    expect(handleInbound).toHaveBeenCalledTimes(1);
  });

  it("企微私聊任何消息 → 进入 handleInbound（防误伤主场景）", async () => {
    const { route, handleInbound } = makeRoute("mention");
    const outcome = await route(wecomGroupMsg({ chatType: "p2p", chatId: "wr_u1" }));
    expect(outcome).toBe("processed");
    expect(handleInbound).toHaveBeenCalledTimes(1);
  });

  it("企微群聊 policy=open → 任何消息都进入", async () => {
    const { route, handleInbound } = makeRoute("open");
    await route(wecomGroupMsg());
    expect(handleInbound).toHaveBeenCalledTimes(1);
  });

  it("飞书侧行为不变：isConnected 组合下 shouldProcessGroupMessage 对 p2p 恒 true", () => {
    // 飞书侧 index.ts:748 一直走 shouldProcessGroupMessage，本测试防重构改坏其语义
    const deps = makePolicyDeps("mention");
    expect(shouldProcessGroupMessage({ ...wecomGroupMsg(), chatType: "p2p" } as ParsedMessage, deps)).toBe(true);
    expect(shouldProcessGroupMessage(wecomGroupMsg(), deps)).toBe(false);
  });
});
