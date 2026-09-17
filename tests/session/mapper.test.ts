import { describe, expect, it, vi } from "vitest";
import { sessionKey, makeSessionId, bumpGeneration, resetGeneration, resetRunNonce, createSessionMapper, rememberPlatform, chatPlatform } from "../../src/session/mapper.js";

describe("sessionKey（铁律 2：前缀隔离）", () => {
  it("格式为 feishu:<chatId>，绝不复用 Web GUI 会话", () => {
    expect(sessionKey("oc_FAKE_CHAT_FOR_TEST")).toBe("feishu:oc_FAKE_CHAT_FOR_TEST");
    expect(sessionKey("ou_xyz").startsWith("feishu:")).toBe(true);
  });

  it("makeSessionId 稳定：同 chat 同 nonce 生成相同 id（resume 落点一致）", () => {
    resetRunNonce();
    const a = makeSessionId("oc_FAKE_CHAT_FOR_TEST");
    const b = makeSessionId("oc_FAKE_CHAT_FOR_TEST");
    expect(a).toBe(b); // ★ 同一 chat 稳定复用（M1 random8 教训的反面）
    expect(a).toMatch(/^feishu:oc_FAKE_CHAT_FOR_TEST:[0-9a-f]{12}:0$/);
    // 不同 chat 不同 id
    expect(makeSessionId("oc_other")).not.toBe(a);
  });

  it("bumpGeneration：dispose 后重建 generation 递增；resetRunNonce：nonce 重置", () => {
    resetRunNonce();
    const id0 = makeSessionId("oc_x");
    bumpGeneration("oc_x");
    const id1 = makeSessionId("oc_x");
    expect(id1).toMatch(/^feishu:oc_x:[0-9a-f]{12}:1$/);
    expect(id1).not.toBe(id0);
    resetRunNonce();
    expect(makeSessionId("oc_x")).toMatch(/^feishu:oc_x:[0-9a-f]{12}:1$/); // generation 保留，nonce 变
  });

  it("resetGeneration：/new 对齐基底 rotate——generation 归零（fresh runNonce + gen 0 → 无碰撞新 id）", () => {
    resetRunNonce();
    const id0 = makeSessionId("oc_y");
    bumpGeneration("oc_y");
    bumpGeneration("oc_y");
    expect(makeSessionId("oc_y")).toMatch(/^feishu:oc_y:[0-9a-f]{12}:2$/); // gen 2
    resetGeneration("oc_y");
    expect(makeSessionId("oc_y")).toMatch(/^feishu:oc_y:[0-9a-f]{12}:0$/); // 归零
    resetRunNonce(); // 对齐 rotate：mint fresh nonce + gen 归零 → 完全全新 id
    const rotated = makeSessionId("oc_y");
    expect(rotated).not.toBe(id0);
    expect(rotated).toMatch(/^feishu:oc_y:[0-9a-f]{12}:0$/);
  });
});

describe("session mapper", () => {
  const createMockAgent = (chatId: string) => ({
    agentId: `agent-${chatId}`,
    sessionId: makeSessionId(chatId),
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    status: "idle",
    dispose: vi.fn().mockResolvedValue(undefined),
  });

  it("不同 chatId 映射不同 session", async () => {
    const mapper = createSessionMapper({ createAgent: createMockAgent });
    const a = await mapper.getOrCreateAgent("oc_1");
    const b = await mapper.getOrCreateAgent("oc_2");
    expect(a).not.toBe(b);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(mapper.size()).toBe(2);
  });

  it("同一 chatId 复用 session（不重复创建）", async () => {
    const createAgent = vi.fn(createMockAgent);
    const mapper = createSessionMapper({ createAgent });
    const a = await mapper.getOrCreateAgent("oc_1");
    const b = await mapper.getOrCreateAgent("oc_1");
    expect(a).toBe(b);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(mapper.size()).toBe(1);
  });
});

describe("平台登记（D6/S6：deliver 分发优先判定）", () => {
  it("rememberPlatform 后 chatPlatform 返回；未登记 undefined", () => {
    expect(chatPlatform("oc_x")).toBeUndefined();
    rememberPlatform("oc_x", "feishu");
    expect(chatPlatform("oc_x")).toBe("feishu");
    rememberPlatform("wb_1", "wecom");
    expect(chatPlatform("wb_1")).toBe("wecom");
    // 覆盖登记
    rememberPlatform("oc_x", "wecom");
    expect(chatPlatform("oc_x")).toBe("wecom");
  });
});

