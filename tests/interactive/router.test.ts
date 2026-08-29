/**
 * P1-2 单选卡回调路由测试（mode/permission/model/preset 分发 + 回执）
 */
import { describe, expect, it, vi } from "vitest";
import { createInteractiveRouter } from "../../src/interactive/router.js";
import { SHIPPED_PRESETS } from "../../src/agent/preset.js";

function mkDeps(over: Partial<Parameters<typeof createInteractiveRouter>[0]> = {}) {
  const state = {
    permissionMode: "workspace-write",
    agentPreset: "standard",
  };
  const setPermissionMode = vi.fn((mode: string) => {
    if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") {
      state.permissionMode = mode;
      return true;
    }
    return false;
  });
  const setAgentPreset = vi.fn((id: string) => { state.agentPreset = id; });
  const setOverride = vi.fn();
  const clearOverride = vi.fn();
  const hasOverride = vi.fn(() => false);
  const liveFor = vi.fn((chatId: string) => {
    void chatId;
    return { provider: "deepseek", model: "default" };
  });
  const getModelDefault = vi.fn(() => undefined);
  const rotateSession = vi.fn(async () => void 0);
  const reply = vi.fn();

  const router = createInteractiveRouter({
    runtime: {
      getPermissionMode: () => state.permissionMode,
      setPermissionMode,
      getAgentPreset: () => state.agentPreset,
      setAgentPreset,
    },
    modelRegistry: { setOverride, clearOverride, hasOverride, liveFor, getModelDefault },
    rotateSession,
    reply,
    presets: () => SHIPPED_PRESETS,
    ...over,
  });
  return { router, state, setPermissionMode, setAgentPreset, setOverride, rotateSession, reply };
}

describe("interactive router onCardAction", () => {
  it("mode:read-only → setPermissionMode + 中文回执（含只对新消息生效）", async () => {
    const { router, setPermissionMode, reply } = mkDeps();
    const consumed = await router.onCardAction("oc_1", "mode:read-only");
    expect(consumed).toBe(true);
    expect(setPermissionMode).toHaveBeenCalledWith("read-only");
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("只读"));
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("只对后续新消息生效"));
  });

  it("permission:read-only → 同 mode（/permission 单选卡共用）", async () => {
    const { router, setPermissionMode, reply } = mkDeps();
    const consumed = await router.onCardAction("oc_1", "permission:read-only");
    expect(consumed).toBe(true);
    expect(setPermissionMode).toHaveBeenCalledWith("read-only");
    expect(reply).toHaveBeenCalled();
  });

  it("mode:非法值 → 回执「未知权限模式」，不设置", async () => {
    const { router, setPermissionMode, reply } = mkDeps();
    const consumed = await router.onCardAction("oc_1", "mode:super-admin");
    expect(consumed).toBe(true);
    expect(setPermissionMode).toHaveBeenCalledWith("super-admin"); // 校验在 set 里拒绝
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("未知权限模式"));
  });

  it("model:deepseek/deepseek-chat → setOverride + 回执（单聊生效）", async () => {
    const { router, setOverride, reply } = mkDeps();
    const consumed = await router.onCardAction("oc_1", "model:deepseek/deepseek-chat");
    expect(consumed).toBe(true);
    expect(setOverride).toHaveBeenCalledWith("oc_1", { provider: "deepseek", model: "deepseek-chat" });
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("deepseek/deepseek-chat"));
  });

  it("model:非法格式 → 回执格式提示，不 setOverride", async () => {
    const { router, setOverride, reply } = mkDeps();
    const consumed = await router.onCardAction("oc_1", "model:badsig");
    expect(consumed).toBe(true);
    expect(setOverride).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("供应商/模型"));
  });

  it("preset:code → setAgentPreset + rotateSession + 中文回执", async () => {
    const { router, setAgentPreset, rotateSession, reply } = mkDeps();
    const consumed = await router.onCardAction("oc_1", "preset:code");
    expect(consumed).toBe(true);
    expect(setAgentPreset).toHaveBeenCalledWith("code");
    expect(rotateSession).toHaveBeenCalledWith("oc_1");
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("PTC 模式"));
  });

  it("未知前缀 → 返回 false（不消费）", async () => {
    const { router, reply } = mkDeps();
    const consumed = await router.onCardAction("oc_1", "unknown:foo");
    expect(consumed).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  it("rotateSession 不可用 → preset 仍切换 + 回执（不挂）", async () => {
    const { router, setAgentPreset, reply } = mkDeps({ rotateSession: undefined });
    const consumed = await router.onCardAction("oc_1", "preset:minimal");
    expect(consumed).toBe(true);
    expect(setAgentPreset).toHaveBeenCalledWith("minimal");
    expect(reply).toHaveBeenCalledWith("oc_1", expect.stringContaining("极简模式"));
  });
});
