import { describe, expect, it, vi } from "vitest";
import { sessionKey, makeSessionId, createSessionMapper } from "../../src/session/mapper.js";

describe("sessionKey（铁律 2：前缀隔离）", () => {
  it("格式为 feishu:<chatId>，绝不复用 Web GUI 会话", () => {
    expect(sessionKey("oc_abc123")).toBe("feishu:oc_abc123");
    expect(sessionKey("ou_xyz").startsWith("feishu:")).toBe(true);
  });

  it("makeSessionId 生成 <feishu:chatId>:<random8>:<gen> 格式", () => {
    const id = makeSessionId("oc_abc123");
    expect(id).toMatch(/^feishu:oc_abc123:[0-9a-f]{8}:0$/);
    const gen1 = makeSessionId("oc_abc123", 3);
    expect(gen1).toMatch(/^feishu:oc_abc123:[0-9a-f]{8}:3$/);
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
