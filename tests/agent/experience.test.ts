import { describe, expect, it, vi } from "vitest";
import { createExperience } from "../../src/agent/experience.js";

function makeExperience() {
  const sendText = vi.fn().mockResolvedValue(undefined);
  const addReaction = vi.fn().mockResolvedValue(undefined);
  const turnSupervisor = { arm: vi.fn(), disarm: vi.fn() };
  const cfg = () => ({
    streaming: { enabled: true, flushMs: 500 },
    reactions: { enabled: false, pool: [], done: "DONE", failed: "CrossMark" },
    credentialRef: "WING_LARK_APP",
    permissionMode: "workspace-write" as const,
    groupPolicy: "mention" as const,
    turnTimeoutMs: 600_000,
    agentPreset: "code",
  });
  const exp = createExperience({ sendText, addReaction, turnSupervisor, cfg, logger: undefined as never });
  return { exp, sendText, addReaction, turnSupervisor };
}

describe("体验契约：插话/停止分派", () => {
  it("running 时插话 → steer（温和打断）", () => {
    const { exp } = makeExperience();
    const agent = { status: "running", steer: vi.fn(), followup: vi.fn(), cancel: vi.fn() };
    const action = exp.handleUserMessage("oc_1", agent as never, "换个角度写", { kind: "msg" });
    expect(action).toBe("steered");
    expect(agent.steer).toHaveBeenCalledTimes(1);
    expect(agent.followup).not.toHaveBeenCalled();
  });

  it("idle 时消息 → followup（排队）", () => {
    const { exp } = makeExperience();
    const agent = { status: "idle", steer: vi.fn(), followup: vi.fn(), cancel: vi.fn() };
    const action = exp.handleUserMessage("oc_1", agent as never, "你好", { kind: "msg" });
    expect(action).toBe("queued");
    expect(agent.followup).toHaveBeenCalledTimes(1);
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("停止词 → cancel（含口语『停下来』）", () => {
    const { exp } = makeExperience();
    const agent = { status: "running", steer: vi.fn(), followup: vi.fn(), cancel: vi.fn() };
    const action = exp.handleUserMessage("oc_1", agent as never, "停下来", { kind: "msg" });
    expect(action).toBe("stopped");
    expect(agent.cancel).toHaveBeenCalledWith({ kind: "user" });
    expect(agent.steer).not.toHaveBeenCalled();
  });

  it("停止词变体：别写了/停一下/stop", () => {
    const { exp } = makeExperience();
    for (const word of ["别写了", "停一下", "stop", "算了"]) {
      const agent = { status: "running", steer: vi.fn(), followup: vi.fn(), cancel: vi.fn() };
      const action = exp.handleUserMessage("oc_1", agent as never, word, { kind: "msg" });
      expect(action, `词「${word}」应触发停止`).toBe("stopped");
    }
  });
});
