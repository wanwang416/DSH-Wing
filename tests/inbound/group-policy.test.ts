import { describe, expect, it, vi } from "vitest";
import { createGroupPolicy, shouldProcessGroupMessage } from "../../src/inbound/group-policy.js";

function msg(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    userId: "ou_9",
    text: "hi",
    rawText: "hi",
    mentions: [] as string[],
    timestamp: 0,
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    policy: () => "open",
    keywords: () => ["lark", "小斯"],
    botOpenId: () => "ou_bot",
    logger: { info: vi.fn(), warn: vi.fn() },
    ...(overrides as any),
  };
}

describe("shouldProcessGroupMessage", () => {
  it("p2p 消息总是处理", () => {
    expect(shouldProcessGroupMessage(msg({ chatType: "p2p" }), deps() as any)).toBe(true);
  });

  it("open：群消息总是处理", () => {
    expect(shouldProcessGroupMessage(msg(), deps() as any)).toBe(true);
  });

  it("mention：@bot（mentions 含 botOpenId）→ 处理", () => {
    const d = deps({ policy: () => "mention" });
    expect(shouldProcessGroupMessage(msg({ mentions: ["ou_bot"] }), d as any)).toBe(true);
  });

  it("mention：rawText 含 @botOpenId → 处理", () => {
    const d = deps({ policy: () => "mention" });
    expect(shouldProcessGroupMessage(msg({ rawText: "@ou_bot 你好", mentions: [] }), d as any)).toBe(true);
  });

  it("mention：未 @bot → 不处理", () => {
    const d = deps({ policy: () => "mention" });
    expect(shouldProcessGroupMessage(msg(), d as any)).toBe(false);
  });

  it("keywords：含关键词 → 处理", () => {
    const d = deps({ policy: () => "keywords" });
    expect(shouldProcessGroupMessage(msg({ text: "帮我查 lark 配置" }), d as any)).toBe(true);
  });

  it("keywords：不含关键词 → 不处理", () => {
    const d = deps({ policy: () => "keywords" });
    expect(shouldProcessGroupMessage(msg({ text: "随便聊聊" }), d as any)).toBe(false);
  });

  it("reply：有 parentId → 处理", () => {
    const d = deps({ policy: () => "reply" });
    expect(shouldProcessGroupMessage(msg({ parentId: "om_parent" }), d as any)).toBe(true);
  });

  it("reply：有 mention → 处理；都无 → 不处理", () => {
    const d = deps({ policy: () => "reply" });
    expect(shouldProcessGroupMessage(msg({ mentions: ["ou_x"] }), d as any)).toBe(true);
    expect(shouldProcessGroupMessage(msg(), d as any)).toBe(false);
  });

  it("未知 policy → 默认处理", () => {
    const d = deps({ policy: () => "unknown" as any });
    expect(shouldProcessGroupMessage(msg(), d as any)).toBe(true);
  });

  it("createGroupPolicy 封装 shouldProcess 透传", () => {
    const d = deps() as any;
    const gp = createGroupPolicy(d);
    expect(gp.shouldProcess(msg())).toBe(true);
    expect(gp.shouldProcess(msg({ chatType: "p2p" }))).toBe(true);
  });
});
