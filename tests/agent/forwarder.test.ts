import { describe, expect, it, vi } from "vitest";
import { toSessionEventOut, createForwarder } from "../../src/agent/forwarder.js";

describe("toSessionEventOut（M3 任务 3 事件映射）", () => {
  it("assistant/chunk：text-delta → assistant/chunk；reasoning-delta → assistant/thinking", () => {
    expect(toSessionEventOut({ type: "assistant/chunk", data: { chunk: { type: "text-delta", text: "答" } } })).toEqual({ type: "assistant/chunk", text: "答" });
    expect(toSessionEventOut({ type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", text: "想" } } })).toEqual({ type: "assistant/thinking", text: "想" });
  });

  it("tool/call：带 callId + arguments（原始字符串）", () => {
    const ev = toSessionEventOut({ type: "tool/call", data: { callId: "c1", name: "Bash", arguments: '{"command":"npm test"}' } });
    expect(ev).toEqual({ type: "tool/call", name: "Bash", input: '{"command":"npm test"}', callId: "c1" });
  });

  it("tool/result：callId 反查由 onSessionEvent 完成，事件带 callId 兜底", () => {
    const ev = toSessionEventOut({ type: "tool/result", data: { message: { content: [{ type: "text", content: "ok" }], source: { callId: "c1" } } } });
    expect(ev?.type).toBe("tool/result");
    if (ev?.type === "tool/result") {
      expect(ev.callId).toBe("c1");
    }
  });

  it("user/message：source.kind === 'user' → undefined（飞书直接 handleInbound）；非 user → context", () => {
    expect(toSessionEventOut({ type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "hi" }] } })).toBeUndefined();
    expect(toSessionEventOut({ type: "user/message", data: { source: { kind: "context" }, content: [{ type: "text", text: "注入" }] } })).toEqual({ type: "user/message", kind: "context", text: "注入" });
  });
});

describe("createForwarder（M3：callId 反查 + 事件分发）", () => {
  function makeForwarder() {
    const deps = {
      onTurnStart: vi.fn(),
      onChunk: vi.fn(),
      onThinking: vi.fn(),
      onAssistantMessage: vi.fn(),
      onTurnEnd: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onContext: vi.fn(),
    };
    const f = createForwarder(deps);
    return { f, deps };
  }

  it("tool/call → onToolCall(name, input)；tool/result → callId 反查 name", () => {
    const { f, deps } = makeForwarder();
    f.onSessionEvent("oc_1", { type: "tool/call", name: "Bash", input: '{"command":"npm test"}', callId: "c1" });
    expect(deps.onToolCall).toHaveBeenCalledWith("oc_1", "Bash", '{"command":"npm test"}');
    f.onSessionEvent("oc_1", { type: "tool/result", callId: "c1" });
    expect(deps.onToolResult).toHaveBeenCalledWith("oc_1", "Bash", undefined);
  });

  it("turn/start 清空 callNames（跨轮次防串）", () => {
    const { f, deps } = makeForwarder();
    f.onSessionEvent("oc_1", { type: "tool/call", name: "Bash", callId: "c1" });
    f.onSessionEvent("oc_1", { type: "turn/start" });
    f.onSessionEvent("oc_1", { type: "tool/result", callId: "c1" });
    // 反查不到 → 兜底 undefined → name "?"
    expect(deps.onToolResult).toHaveBeenCalledWith("oc_1", "?", undefined);
  });

  it("reasoning-delta → onThinking；text-delta → onChunk", () => {
    const { f, deps } = makeForwarder();
    f.onSessionEvent("oc_1", { type: "assistant/thinking", text: "想" });
    f.onSessionEvent("oc_1", { type: "assistant/chunk", text: "答" });
    expect(deps.onThinking).toHaveBeenCalledWith("oc_1", "想");
    expect(deps.onChunk).toHaveBeenCalledWith("oc_1", "答");
  });

  it("context → onContext", () => {
    const { f, deps } = makeForwarder();
    f.onSessionEvent("oc_1", { type: "user/message", kind: "context", text: "注入" });
    expect(deps.onContext).toHaveBeenCalledWith("oc_1", "注入");
  });
});
